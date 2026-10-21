import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import {
  BENCHMARK_HOT_RULES,
  BENCHMARK_RETENTION_DAYS,
  type BenchmarkSortKey,
} from './benchmark-fields.js';
import type { CreateAccountDto, SubmitContentsDto, UpdateAccountDto } from './benchmark.schemas.js';

/**
 * 排序用的数值指标。
 * engagement = 互动总量（点赞+评论+收藏+转发）；views = 播放量。
 */
function sortMetric(row: { stats: string }, sortBy: BenchmarkSortKey): number {
  let s: { play?: number; like?: number; comment?: number; collect?: number; share?: number } = {};
  try {
    s = JSON.parse(row.stats) as typeof s;
  } catch {
    return 0;
  }
  if (sortBy === 'views') return s.play ?? 0;
  return (s.like ?? 0) + (s.comment ?? 0) + (s.collect ?? 0) + (s.share ?? 0);
}

/** 一条内容的互动数据 */
export type ContentStats = {
  play?: number;
  like?: number;
  comment?: number;
  collect?: number;
  share?: number;
};

/**
 * 热度分：**服务端唯一口径**。
 *
 * 为什么不让采集端自己算：
 * 不同 Agent 各自实现一遍公式，排序就不可比了——而「热门」这件事
 * 恰恰是这套功能的核心（采热门 → 学热门）。口径必须收在一处。
 *
 * 公式：加权互动 × 时效衰减
 *   权重：评论(5) 与转发(6) 的决策价值高于点赞(3)，收藏(4) 次之，播放(0.02) 只做微调
 *   衰减：每过 7 天打 5 折（半衰期），保证「昨天的爆款」不会一直占着榜首
 *
 * 导出供 smoke 直接断言：这段公式决定了榜单顺序是不是稳定可复现的，
 * 不能只靠人工看一眼。
 */
export function computeHotScore(stats: ContentStats, publishedAt: Date | null, now: Date = new Date()): number {
  const w = BENCHMARK_HOT_RULES.weights;
  const raw =
    (stats.play ?? 0) * w.play +
    (stats.like ?? 0) * w.like +
    (stats.comment ?? 0) * w.comment +
    (stats.collect ?? 0) * w.collect +
    (stats.share ?? 0) * w.share;
  if (raw <= 0) return 0;
  // 没拿到发布时间就不做时效衰减（拿采集时间冒充会错排，这里宁可不算）
  if (!publishedAt) return round2(raw);
  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / 86_400_000);
  const decay = Math.pow(0.5, ageDays / BENCHMARK_HOT_RULES.decayHalfLifeDays);
  return round2(raw * decay);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 解析发布时间：拿不到 / 格式不对都当「没有」，不用采集时间冒充 */
function parsePublishedAt(raw: string | undefined): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

/** 对标账号情报：配置对标账号 → 采集热门内容元数据 → AI 映射学习比对 */
@Injectable()
export class BenchmarkService {
  constructor(private readonly prisma: PrismaService) {}

  /** 对标账号清单 */
  accounts(tenantId: string) {
    return this.prisma.benchmarkAccount.findMany({
      where: { tenantId },
      orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createAccount(tenantId: string, dto: CreateAccountDto) {
    return this.prisma.benchmarkAccount.create({
      data: {
        tenantId,
        platform: dto.platform,
        accountName: dto.accountName,
        homeUrl: dto.homeUrl,
        tags: dto.tags ?? '',
        note: dto.note ?? '',
        enabled: dto.enabled ?? true,
      },
    });
  }

  async updateAccount(tenantId: string, id: string, dto: UpdateAccountDto) {
    await this.mustGetAccount(tenantId, id);
    return this.prisma.benchmarkAccount.update({
      where: { id },
      data: {
        platform: dto.platform,
        accountName: dto.accountName,
        homeUrl: dto.homeUrl,
        tags: dto.tags,
        note: dto.note,
        enabled: dto.enabled,
      },
    });
  }

  /** 删账号：连同该账号采集到的内容与分析结果一起清掉（不留孤儿数据） */
  async removeAccount(tenantId: string, id: string): Promise<void> {
    await this.mustGetAccount(tenantId, id);
    await this.prisma.$transaction([
      this.prisma.benchmarkContent.deleteMany({ where: { tenantId, accountId: id } }),
      this.prisma.benchmarkInsight.deleteMany({ where: { tenantId, accountId: id } }),
      this.prisma.benchmarkAccount.delete({ where: { id } }),
    ]);
  }

  /**
   * 提交采集结果（Agent → 服务端）。
   *
   * 幂等：内容链接是幂等键，同一条重复提交只更新不重复入库。
   * 超出每账号条数上限的按热度分截断，不算错误（返回 skipped 计数）。
   */
  async submitContents(tenantId: string, dto: SubmitContentsDto) {
    const accountIds = [...new Set(dto.items.map((i) => i.accountId))];
    const accounts = await this.prisma.benchmarkAccount.findMany({
      where: { tenantId, id: { in: accountIds } },
    });
    if (accounts.length !== accountIds.length) {
      const known = new Set(accounts.map((a) => a.id));
      const missing = accountIds.filter((id) => !known.has(id));
      throw new BadRequestException({
        code: 'BENCHMARK_ACCOUNT_UNKNOWN',
        message: `有 ${missing.length} 个对标账号不存在或不属于当前租户，请先在「对标账号」里配置`,
        details: missing,
      });
    }
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    // 服务端统一算热度分，再按分数做每账号截断
    const now = new Date();
    const scored = dto.items.map((item) => {
      const account = accountMap.get(item.accountId)!;
      const publishedAt = parsePublishedAt(item.publishedAt);
      const hotScore = computeHotScore(item, publishedAt, now);
      return { item, account, publishedAt, hotScore };
    });

    const perAccount = new Map<string, typeof scored>();
    for (const s of scored) {
      const list = perAccount.get(s.item.accountId) ?? [];
      list.push(s);
      perAccount.set(s.item.accountId, list);
    }
    const accepted: typeof scored = [];
    let skippedOverLimit = 0;
    for (const list of perAccount.values()) {
      list.sort((a, b) => b.hotScore - a.hotScore);
      const keep = list.slice(0, BENCHMARK_HOT_RULES.perAccountLimit);
      skippedOverLimit += list.length - keep.length;
      accepted.push(...keep);
    }

    let created = 0;
    let updated = 0;
    const batchId = dto.batchId ?? '';
    for (const s of accepted) {
      const stats = {
        play: s.item.play ?? 0,
        like: s.item.like ?? 0,
        comment: s.item.comment ?? 0,
        collect: s.item.collect ?? 0,
        share: s.item.share ?? 0,
      };
      const data = {
        accountName: s.account.accountName,
        platform: s.account.platform,
        title: s.item.title,
        text: s.item.text,
        sourceUrl: s.item.sourceUrl,
        publishedAt: s.publishedAt,
        stats: JSON.stringify(stats),
        hotScore: s.hotScore,
        topics: (s.item.topics ?? []).join(','),
        coverUrl: s.item.coverUrl ?? '',
        batchId,
        collectedAt: now,
      };
      const existed = await this.prisma.benchmarkContent.findFirst({
        where: { tenantId, accountId: s.item.accountId, sourceUrl: s.item.sourceUrl },
        select: { id: true },
      });
      if (existed) {
        await this.prisma.benchmarkContent.update({ where: { id: existed.id }, data });
        updated += 1;
      } else {
        await this.prisma.benchmarkContent.create({ data: { tenantId, accountId: s.item.accountId, ...data } });
        created += 1;
      }
    }

    return {
      accepted: accepted.length,
      created,
      updated,
      /** 超出每账号上限被截断的条数（不是错误，是采集端采多了） */
      skippedOverLimit,
      batchId,
    };
  }

  /**
   * 已采集到的内容。
   *
   * 排序维度可切换（见 `BENCHMARK_SORT_FIELDS`）：
   * hotScore / published 直接用 Prisma 排序；
   * engagement / views 存在 JSON 列里，Prisma 排不了 → 取一批在内存里排。
   */
  async contents(
    tenantId: string,
    accountId?: string,
    limit = 50,
    sortBy: BenchmarkSortKey = 'hotScore',
  ) {
    const where = { tenantId, ...(accountId ? { accountId } : {}) };
    const take = Math.min(Math.max(limit, 1), 200);
    if (sortBy === 'hotScore') {
      return this.prisma.benchmarkContent.findMany({
        where,
        orderBy: [{ hotScore: 'desc' }, { collectedAt: 'desc' }],
        take,
      });
    }
    if (sortBy === 'published') {
      return this.prisma.benchmarkContent.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { collectedAt: 'desc' }],
        take,
      });
    }
    const rows = await this.prisma.benchmarkContent.findMany({
      where,
      orderBy: [{ hotScore: 'desc' }],
      take: 500,
    });
    rows.sort((a, b) => sortMetric(b, sortBy) - sortMetric(a, sortBy));
    return rows.slice(0, take);
  }

  /**
   * 清理超期内容。
   *
   * 保留期是我们自己定的（同业公开条款没给天数）：内容权利归原主，
   * 平台有权要求下架，长期囤着原始文案对我们没有额外价值、只有风险。
   */
  async prune(tenantId: string, retentionDays = BENCHMARK_RETENTION_DAYS) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const res = await this.prisma.benchmarkContent.deleteMany({
      where: { tenantId, collectedAt: { lt: cutoff } },
    });
    return { removed: res.count, cutoff: cutoff.toISOString(), retentionDays };
  }

  /** 分析结果（最新一条在前） */
  insights(tenantId: string, accountId?: string) {
    return this.prisma.benchmarkInsight.findMany({
      where: { tenantId, ...(accountId ? { accountId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 账号内容条数统计（界面展示用） */
  async countsByAccount(tenantId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.benchmarkContent.groupBy({
      by: ['accountId'],
      where: { tenantId },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.accountId] = r._count._all;
    return out;
  }

  async mustGetAccount(tenantId: string, id: string) {
    const row = await this.prisma.benchmarkAccount.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('BENCHMARK_ACCOUNT_NOT_FOUND');
    return row;
  }
}
