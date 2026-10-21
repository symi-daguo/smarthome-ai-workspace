import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthProfile } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { BenchmarkService } from './benchmark.service.js';
import { BenchmarkAnalyzeService } from './benchmark-analyze.service.js';
import {
  BENCHMARK_FIELD_SPECS,
  BENCHMARK_HOT_RULES,
  BENCHMARK_IMPORT_RULES,
  BENCHMARK_RETENTION_DAYS,
  BENCHMARK_SORT_FIELDS,
  type BenchmarkSortKey,
} from './benchmark-fields.js';
import {
  analyzeSchema,
  createAccountSchema,
  submitContentsSchema,
  updateAccountSchema,
  type AnalyzeDto,
  type CreateAccountDto,
  type SubmitContentsDto,
  type UpdateAccountDto,
} from './benchmark.schemas.js';

type Profile = AuthProfile & { activeTenantId?: string };

/**
 * 对标账号情报。
 *
 * 分工很清楚：
 * - **服务端**：告诉 Agent 哪些是我们对标的（账号清单 + 采集契约），
 *   接收 Agent 采回来的热门内容元数据，用 AI 映射到我们业务，产出画像与差距。
 * - **Agent 侧**：用自带浏览器能力登录平台、采集热门内容、调本接口提交。
 *
 * 服务端不引无头浏览器（镜像会大几百 MB，且平台内容要真实登录态）。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('benchmark')
export class BenchmarkController {
  constructor(
    private readonly benchmark: BenchmarkService,
    private readonly analyzer: BenchmarkAnalyzeService,
  ) {}

  private tenantIdOf(user: Profile): string {
    const id = user.activeTenantId;
    if (!id) throw new Error('TENANT_REQUIRED');
    return id;
  }

  /** 对标账号清单（带每个账号已采集的内容条数） */
  @RequirePermissions('benchmark:read')
  @Get('accounts')
  async accounts(@CurrentUser() user: Profile) {
    const tenantId = this.tenantIdOf(user);
    const [accounts, counts] = await Promise.all([
      this.benchmark.accounts(tenantId),
      this.benchmark.countsByAccount(tenantId),
    ]);
    return {
      accounts: accounts.map((a) => ({ ...a, contentCount: counts[a.id] ?? 0 })),
    };
  }

  @RequirePermissions('benchmark:write')
  @Post('accounts')
  createAccount(@CurrentUser() user: Profile, @Body(new ZodValidationPipe(createAccountSchema)) dto: CreateAccountDto) {
    return this.benchmark.createAccount(this.tenantIdOf(user), dto);
  }

  @RequirePermissions('benchmark:write')
  @Patch('accounts/:id')
  updateAccount(
    @CurrentUser() user: Profile,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAccountSchema)) dto: UpdateAccountDto,
  ) {
    return this.benchmark.updateAccount(this.tenantIdOf(user), id, dto);
  }

  @RequirePermissions('benchmark:write')
  @Delete('accounts/:id')
  async removeAccount(@CurrentUser() user: Profile, @Param('id') id: string) {
    await this.benchmark.removeAccount(this.tenantIdOf(user), id);
    return { ok: true };
  }

  /**
   * 采集契约（给 Agent 的可编程规格）。
   *
   * 这份东西是本功能的核心交付物：Agent 拿到它就知道
   * **采什么字段、怎么算热门、怎么提交**，不需要人肉翻译需求。
   */
  @RequirePermissions('benchmark:read')
  @Get('collect-spec')
  async collectSpec(@CurrentUser() user: Profile) {
    const tenantId = this.tenantIdOf(user);
    const accounts = (await this.benchmark.accounts(tenantId)).filter((a) => a.enabled);
    const first = accounts[0];
    return {
      version: '1.0',
      title: '对标账号情报 · 采集契约',
      intro:
        '你是采集执行方：用你的浏览器能力登录平台、找到下列对标账号、抓取它们的热门内容元数据，' +
        '按本契约整理后调用提交接口。只采元数据与文案，不要下载视频本体。',
      accounts: accounts.map((a) => ({
        accountId: a.id,
        platform: a.platform,
        accountName: a.accountName,
        homeUrl: a.homeUrl,
        tags: a.tags,
        note: a.note,
      })),
      fields: BENCHMARK_FIELD_SPECS,
      hotRules: BENCHMARK_HOT_RULES,
      sortFields: BENCHMARK_SORT_FIELDS,
      retentionDays: BENCHMARK_RETENTION_DAYS,
      rules: BENCHMARK_IMPORT_RULES,
      jsonExample: {
        batchId: 'collect-2026-10-21',
        items: [
          {
            accountId: first?.id ?? '对标账号的 accountId',
            title: '示例：全屋灯光，一键搞定',
            text: '示例：装修最怕插座不够用…（这里是发布时的完整文案原文）',
            sourceUrl: 'https://example.com/post/123456',
            publishedAt: '2026-10-18T12:30:00+08:00',
            play: 128000,
            like: 3200,
            comment: 186,
            collect: 540,
            share: 92,
            topics: ['智能家居', '装修避坑'],
            coverUrl: 'https://example.com/cover/123456.jpg',
            durationSec: 42,
          },
        ],
      },
      submit: {
        method: 'POST',
        path: '/api/benchmark/contents',
        auth: 'Bearer <API Key 或登录令牌>',
        bodyShape: '{ batchId?: string, items: 采集到的内容数组 }',
      },
    };
  }

  /** 提交采集结果（Agent → 服务端） */
  @RequirePermissions('benchmark:write')
  @Post('contents')
  submitContents(
    @CurrentUser() user: Profile,
    @Body(new ZodValidationPipe(submitContentsSchema)) dto: SubmitContentsDto,
  ) {
    return this.benchmark.submitContents(this.tenantIdOf(user), dto);
  }

  /** 已采集到的热门内容（排序维度可切换） */
  @RequirePermissions('benchmark:read')
  @Get('contents')
  async contents(
    @CurrentUser() user: Profile,
    @Query('accountId') accountId?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
  ) {
    const n = limit ? Number(limit) : 50;
    const key = BENCHMARK_SORT_FIELDS.find((f) => f.key === sortBy)?.key ?? 'hotScore';
    const rows = await this.benchmark.contents(
      this.tenantIdOf(user),
      accountId,
      Number.isFinite(n) ? n : 50,
      key as BenchmarkSortKey,
    );
    return { contents: rows, sortBy: key };
  }

  /** 清理超期内容（保留期默认 90 天） */
  @RequirePermissions('benchmark:write')
  @Post('prune')
  prune(@CurrentUser() user: Profile, @Query('days') days?: string) {
    const n = days ? Number(days) : undefined;
    return this.benchmark.prune(this.tenantIdOf(user), Number.isFinite(n) ? (n as number) : undefined);
  }

  /** 触发 AI 映射分析 */
  @RequirePermissions('benchmark:write')
  @Post('analyze')
  analyze(@CurrentUser() user: Profile, @Body(new ZodValidationPipe(analyzeSchema)) dto: AnalyzeDto) {
    return this.analyzer.analyze(this.tenantIdOf(user), dto);
  }

  /** 分析结果（风格画像 + 差距） */
  @RequirePermissions('benchmark:read')
  @Get('insights')
  async insights(@CurrentUser() user: Profile, @Query('accountId') accountId?: string) {
    const rows = await this.benchmark.insights(this.tenantIdOf(user), accountId);
    return {
      insights: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        accountName: r.accountName,
        summary: r.summary,
        analysis: safeJson(r.analysis),
        gaps: safeJson(r.gaps),
        sampleSize: r.sampleSize,
        createdAt: r.createdAt,
      })),
    };
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
