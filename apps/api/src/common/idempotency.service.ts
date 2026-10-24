import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';

/** Prisma 唯一约束冲突的错误码 */
const UNIQUE_VIOLATION = 'P2002';

/**
 * 幂等记录保留期（天）。
 *
 * 幂等键的价值只在**重试窗口**内：用户弱网重试、跨标签页重复点，
 * 都是几分钟到几小时内的重投。超过 7 天还留着，纯属占着唯一索引和磁盘。
 */
export const IDEMPOTENCY_RETENTION_DAYS = 7;

/**
 * 每抢占多少次提交键，才做一次幂等记录的保留期清理。
 *
 * 和审计清理同一个道理：清理频率必须**远低于**写入频率。
 * 每次抢占都清 = 自己制造写放大（一次 DELETE 的 WAL + 死元组 + 索引维护），
 * 比不清理还糟。取 200：清理一次摊到 200 次抢占上可以忽略。
 *
 * 注意：IdempotencyService 是**各模块各注册一份**（orders / lighting / layout），
 * 计数也是各数各的 —— 真实清理频率是「每个使用方每 200 次抢占」，
 * 仍然远低于写入频率。
 */
export const IDEMPOTENCY_PURGE_EVERY = 200;

export interface ClaimOutcome {
  /** true = 抢占成功，本次应当真正执行；false = 已有同键记录，本次是重复提交 */
  fresh: boolean;
  /** 重复提交时带回的既有结果（可能为 null：上次抢到但执行中/已失败释放） */
  previous?: unknown;
}

/**
 * 提交幂等服务（批次 10「幂等全链路」）。
 *
 * 解决的是：用户在弱网下重试、或跨标签页重复点提交时，**同一个操作被真正跑两次** ——
 * 对扣费端点来说就是白扣一次额度。已有的方案生成 / 生图 / 生视频已经在业务表上带
 * `clientRequestId` 列，但产品 AI 批量、灯光问诊、接单接待、跟进建议、素材购买
 * 这几处没有可挂的业务行，重试就会重复扣。
 *
 * 关键设计：**用唯一约束抢占，不是「先查后插」**。
 * 「先查后插」在并发下会双双查到空、然后双双插入 —— 两个并发点击照样扣两次。
 * 这里改为直接 insert，靠 (tenantId, key) 唯一索引让第二个请求当场失败。
 *
 * 失败要能重试：抢占成功后若执行报错，必须 `release()` 删掉占位，
 * 否则用户第一次失败后就再也提交不了了。异步出图队列的「卡住时查原任务、
 * 禁止重新提交」是另一套问题；同步端点失败应当允许重试，两者不能混为一谈。
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  /** 抢占计数：每 IDEMPOTENCY_PURGE_EVERY 次触发一次保留期清理（见该常量的说明） */
  private claimCount = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 抢占一个提交键。
   * @returns fresh=true 应当执行；fresh=false 为重复提交，previous 是既有结果
   */
  async claim(tenantId: string, key: string | undefined, kind: string): Promise<ClaimOutcome> {
    if (!key) return { fresh: true };
    // 保留期清理挂在这条已有的写入路径上：幂等记录只增不减，
    // 而抢占是这张表唯一稳定的写入触发点（没有别的地方会碰它）。
    this.maybePurge(tenantId);
    try {
      await this.prisma.idempotencyRecord.create({ data: { tenantId, key, kind } });
      return { fresh: true };
    } catch (e) {
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) {
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { idempotency_tenant_key: { tenantId, key } },
        });
        return { fresh: false, previous: existing?.result ?? null };
      }
      throw e;
    }
  }

  /**
   * 低频清理过期幂等记录。
   *
   * 按租户隔离：只删本租户过期的记录（租户 A 的请求不清租户 B 的）。
   * 绝大多数抢占只做一次整数自增就返回，满 IDEMPOTENCY_PURGE_EVERY 才真跑清理。
   * 清理失败绝不能影响抢占：抢不到就抢不到，清理失败下轮再来。
   */
  private maybePurge(tenantId: string): void {
    this.claimCount += 1;
    if (this.claimCount < IDEMPOTENCY_PURGE_EVERY) return;
    this.claimCount = 0;
    void this.purgeOlderThan(IDEMPOTENCY_RETENTION_DAYS, tenantId)
      .catch((e: unknown) => this.logger.warn(`幂等记录清理失败 tenant=${tenantId}: ${String(e)}`));
  }

  /** 执行成功后回填结果摘要，便于重复提交时原样返回 */
  async complete(tenantId: string, key: string | undefined, kind: string, result: unknown): Promise<void> {
    if (!key) return;
    try {
      await this.prisma.idempotencyRecord.update({
        where: { idempotency_tenant_key: { tenantId, key } },
        data: { result: (result ?? null) as never },
      });
    } catch (e) {
      // 结果回填失败不该让业务操作失败：操作本身已经做完并扣过额度了，
      // 最多是重复提交时拿不回摘要，走一次空执行也不能双扣。
      this.logger.warn(`幂等结果回填失败 ${kind}/${key}：${(e as Error).message}`);
    }
  }

  /** 执行失败时释放占位，让用户能重试 */
  async release(tenantId: string, key: string | undefined): Promise<void> {
    if (!key) return;
    try {
      await this.prisma.idempotencyRecord.delete({ where: { idempotency_tenant_key: { tenantId, key } } });
    } catch {
      // 已被清理或不存在，忽略
    }
  }

  /**
   * 清掉超过保留期的记录。幂等键的价值只在重试窗口内，长期留着只会白涨。
   *
   * @param days 保留天数
   * @param tenantId 只清这个租户的；不传则全表清（保留旧行为，供无租户上下文的场景使用）
   */
  async purgeOlderThan(days = IDEMPOTENCY_RETENTION_DAYS, tenantId?: string): Promise<number> {
    const before = new Date(Date.now() - days * 86400_000);
    const r = await this.prisma.idempotencyRecord.deleteMany({
      where: { createdAt: { lt: before }, ...(tenantId ? { tenantId } : {}) },
    });
    return r.count;
  }
}
