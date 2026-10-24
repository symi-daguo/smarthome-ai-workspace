import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.module.js';
import { AgentService } from './agent.service.js';
import { destructivePatterns } from './manifest.js';
import type { AuthProfile } from '../auth/auth.service.js';

/** 只记写操作。GET 每次都记的话，一天就能把审计表撑爆，真出事时反而翻不动 */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** 这些路径本身是「查审计」的，记进去会自我繁殖；健康检查同理 */
const SKIP_PREFIXES = ['/api/health', '/api/agent/audit'];

/**
 * 每写多少条审计，才做一次保留期清理。
 *
 * 为什么不能「每个写请求都清一次」：审计表本身就是只增的流水，
 * 每个写请求都跑一次 DELETE = 把「治审计日志」变成「制造写放大」——
 * 清一次要扫索引、写 WAL、留死元组，频率跟审计写入一样高的话，
 * 磁盘写入量跟审计表本身一个量级，越用越慢（用户的要求：长期运行不持续擦写硬盘）。
 *
 * 取 500：一次清理的代价（一次索引扫描 + 一次批量删）摊到 500 次写请求上可以忽略，
 * 而清理频率又远低于写入频率，长期不会积压。
 * 一句话：**清理的开销必须远低于它省下来的东西**，否则就是白折腾。
 *
 * 为什么不用定时器：定时器要额外管生命周期（进程重启就不跑、多实例还要防重入），
 * 而审计写入本身就是现成的触发点 —— 挂在已有路径上更简单可靠。
 */
const AUDIT_PURGE_EVERY = 500;

/**
 * 全量审计（0.1.53）
 *
 * 为什么不用逐个 service 手写：改之前全项目只有 llm / layout / knowledge 三处在写 AuditLog，
 * 报价、接单、灯光、画布、方案、智能体、反馈**一条都不记**。靠自觉补是补不齐的，
 * 而且以后每加一个 service 都会再漏一次。拦截器是唯一能保证「不漏」的位置。
 *
 * 记什么：
 *   - 谁（actorId + actorKind：人点的还是机器跑的）
 *   - 在什么时间、哪个接口、什么方法、返回什么状态码、耗时多久
 *   - 请求体的 SHA-256 摘要 —— 能证明「当时发出去的到底是什么」，
 *     又不用把客户信息和提示词原文存进审计表
 *   - X-Request-Id：客户端自带，用来把一串动作串成一次任务
 *
 * 不记请求体原文是刻意的：报价单和接单记录里全是客户姓名电话。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);
  /** 破坏性操作模板（Nest 风格 :param → 匹配任意一段） */
  private readonly destructive = destructivePatterns();
  /** 审计写入计数：每 AUDIT_PURGE_EVERY 次触发一次保留期清理（见该常量的说明） */
  private auditWriteCount = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
  ) {}

  /**
   * 低频触发审计保留期清理。
   *
   * 绝大多数请求只做一次整数自增就返回（代价可忽略）；满 AUDIT_PURGE_EVERY 才真跑清理。
   * 清理失败绝不能影响业务请求 —— 审计已经落库了，清理只是 housekeeping，失败下轮再来。
   *
   * 按租户隔离：清的是**触发这次清理的租户**自己的过期审计（外加不属于任何租户的
   * 系统级审计）。别的租户的记录不动。
   */
  private maybePurgeAuditLogs(tenantId: string): void {
    this.auditWriteCount += 1;
    if (this.auditWriteCount < AUDIT_PURGE_EVERY) return;
    this.auditWriteCount = 0;
    void this.agent
      .purgeExpiredAuditLogs(tenantId)
      .catch((e: unknown) => this.logger.warn(`审计保留期清理失败 tenant=${tenantId}: ${String(e)}`));
  }

  /** 命中破坏性操作模板才算；DELETE 一律算，POST/PATCH 只认清单里标了 destructive 的 */
  private isDestructive(method: string, path: string): boolean {
    if (method === 'DELETE') return true;
    return this.destructive.some((d) => d.method === method && d.pattern.test(path));
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{
      method: string; originalUrl: string; url: string; body?: unknown;
      user?: AuthProfile; params?: Record<string, string>;
      headers: Record<string, string | string[] | undefined>;
    }>();
    const res = http.getResponse<{ statusCode: number; setHeader?: (k: string, v: string) => void }>();

    const method = req.method.toUpperCase();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (!WRITE_METHODS.has(method) || SKIP_PREFIXES.some((p) => path.startsWith(p))) return next.handle();

    const startedAt = Date.now();
    const requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? randomUUID();
    // 回写给客户端：调用方拿它就能去 /api/agent/audit?requestId= 复盘这次动作
    res.setHeader?.('x-request-id', requestId);

    const tenantId = req.user?.activeTenantId ?? null;
    const actorId = req.user?.id ?? null;
    // 机器账号发起的记 AGENT，其余记 USER。审计里一眼能分出「人点的」和「Agent 跑的」
    const actorKind = actorId ? (req.user?.isServiceAccount ? 'AGENT' : 'USER') : 'SYSTEM';

    // —— 操作前自动留底 ——
    // 破坏性操作且调用方没自带 X-Snapshot-Id 时，先给该租户打一份 auto 快照再放行。
    // 这样即使 Agent 忘了主动打点，误删也能还原；主动打了快照的请求直接跳过，
    // 免得同一串操作里反复生成整租户快照把库撑爆。
    let autoSnapshotId: string | null = null;
    const givenSnapshotId = (req.headers['x-snapshot-id'] as string | undefined)?.slice(0, 64);
    const needAuto = Boolean(tenantId) && this.isDestructive(method, path) && !givenSnapshotId;

    const run = async (): Promise<unknown> =>
      lastValueFrom(from(next.handle())).then(
        (v) => { finish(res.statusCode ?? 200, true); return v; },
        (e) => { finish(statusOf(e), false); throw e; },
      );

    const finish = (statusCode: number, ok: boolean): void => {
      const durationMs = Date.now() - startedAt;
      const payloadDigest = hashPayload(req.body);
      // 审计写失败绝不能反过来把业务请求搞挂，所以整段吞掉异常只记日志
      void this.prisma.auditLog
        .create({
          data: {
            tenantId, actorId, actorKind, action: `${method} ${path}`,
            target: req.params?.id ?? null,
            ip: clientIp(req.headers),
            requestId, method, path, statusCode, ok, payloadDigest, durationMs,
            snapshotId: givenSnapshotId ?? autoSnapshotId,
          },
        })
        .catch((e: unknown) => this.logger.error(`审计写入失败 ${method} ${path}: ${String(e)}`));
      // 保留期清理挂在这条已有的写入路径上：写审计的频率远高于清理的频率（见 AUDIT_PURGE_EVERY）
      // 没有租户上下文时（tenantId 为空）不触发 —— 清理要按租户隔离，没有租户就没法隔离
      if (tenantId) this.maybePurgeAuditLogs(tenantId);
    };

    if (!needAuto) {
      return from(run());
    }
    // 快照失败**不阻断**业务：宁可放行并把风险写进审计，也不能因为备份机制本身故障把系统锁死
    return from(
      this.agent
        .createSnapshot(tenantId as string, actorId ?? '', `自动兜底：${method} ${path}`, 'AUTO')
        .then((s) => {
          autoSnapshotId = s.id;
          this.logger.warn(`破坏性操作已自动打点 snapshot=${s.id} ${method} ${path}`);
        })
        .catch((e: unknown) => this.logger.error(`自动快照失败，仍放行 ${method} ${path}: ${String(e)}`))
        .then(run),
    );
  }
}

/**
 * 取异常里的真实 HTTP 状态码。
 *
 * 之前一律记 500，等于把「参数写错了（400，改一下就能成）」、
 * 「没权限（403，找管理员开权限）」、「对象不存在（404，重新拉清单）」
 * 三种完全不同的情况全涂成同一色 —— 审计表里的状态码字段就此失去意义，
 * Agent 也没法据此判断该重试还是该改参数。
 * Nest 的 HttpException 带 getStatus()；非 HTTP 异常才按 500 记。
 */
function statusOf(e: unknown): number {
  const err = e as { getStatus?: () => number; status?: number };
  const candidate = typeof err?.getStatus === 'function' ? err.getStatus() : err?.status;
  if (Number.isInteger(candidate) && Number(candidate) >= 400 && Number(candidate) < 600) {
    return Number(candidate);
  }
  return 500;
}

function hashPayload(body: unknown): string | null {  if (body === undefined || body === null) return null;
  try {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
  } catch {
    // multipart 等无法 JSON 序列化的请求体，跳过摘要而不是让整个请求失败
    return null;
  }
}

function clientIp(headers: Record<string, string | string[] | undefined>): string | null {
  const v = headers['x-forwarded-for'] ?? headers['x-real-ip'];
  const raw = Array.isArray(v) ? v[0] : v;
  return raw ? String(raw).split(',')[0].trim().slice(0, 45) : null;
}