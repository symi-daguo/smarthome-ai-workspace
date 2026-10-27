import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MediaService, isChargedError } from '../media/media.service.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { PrismaService } from '../prisma/prisma.module.js';
import type { CreateConversationDto, CreateTurnDto, UpdateConversationDto, UpdateTurnDto } from './canvas.schemas.js';

/**
 * AI 画布（对话式生图）：对话线 + 轮次树 + 异步生成作业。
 *
 * 三条不变量（勿轻易改）：
 * 1. 重新生成是「追加变体」不是覆盖：同一轮的 variants 只增不改，按 url 去重，已有项不重排编号。
 * 2. 分支是树不是线：每个轮次记 parentId，详情接口为每轮附带 children[]，前端自行构树与切换分支。
 * 3. 生图是异步作业：创建轮次只落库 pending 作业，HTTP 立即返回，出图在后台跑，前端轮询作业状态。
 */

/** 变体项：与 schema.prisma 中 ImageTurn.variants 的元素结构一致 */
export interface TurnVariant {
  url: string;
  label: string;
  createdAt: string;
}

/** GenerationJob.params 的参数快照 */
interface JobParams {
  conversationId: string;
  userTurnId: string;
  turnId: string;
  /** 用户原样提示词 */
  prompt: string;
  /** 组装后的完整提示词（实际送生出图） */
  fullPrompt: string;
  size: string;
  fitVideo?: boolean;
  background?: 'auto' | 'transparent' | 'white';
  quality?: 'standard' | 'high';
  refAssetId?: string | null;
  /** 局部重绘参数（成对存在） */
  imageAssetId?: string | null;
  maskDataUrl?: string | null;
  parentId?: string | null;
}

/**
 * 允许「补跑」的作业状态。
 *
 * failed  = 失败且**没扣**额度（失败发生在扣额度之前）→ 补跑正常扣一次
 * unknown = 已扣额度但结果待核对 → 补跑**不再扣第二次**（alreadyCharged），且只有一次机会
 * pending = 首次执行
 * done / running / interrupted 不在其中：已经有结果的不用重跑，进行中的不该被顶掉。
 */
const RERUNNABLE_JOB_STATUS = ['pending', 'failed', 'unknown'];

/** 补跑端点的执行结果：不再是「什么都不做也不报错」 */
export interface JobRunResult {
  /** 是否真的执行了（false = 没有可执行的作业） */
  ran: boolean;
  /** 作业当前状态 */
  status: string;
  /** 没执行的原因（ran=false）或失败原因（ran=true 且失败） */
  reason?: string;
  /** 给人和 Agent 看的白话说明（reason 的展开，省得各自去猜代码） */
  message?: string;
  /** 产出物 id（成功时） */
  assetId?: string;
}

/**
 * 每个已扣额度的作业允许的**免费补跑**次数：1 次。
 *
 * unknown = 额度已经扣了，但没拿到结果。此时补跑**不再扣用户额度**（用户已经付过这一笔），
 * 可上游 API 是实打实的成本 —— 不设上限，「反复点补跑」就成了一条白烧平台额度的路。
 *
 * 用抢占式（唯一约束）实现：并发重复点只有一个能抢到，抢不到的直接返回明确原因。
 * 抢占记录**不释放**：这一次机会花掉就没了，要再来得重新发起（重新发起会正常计费）。
 */
const FREE_RERUN_KEY_PREFIX = 'canvas-free-rerun:';

@Injectable()
export class CanvasService implements OnModuleInit {
  private readonly logger = new Logger(CanvasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly idem: IdempotencyService,
  ) {}

  /**
   * 启动时把「僵尸作业」标成 interrupted。
   *
   * 出图是 fire-and-forget（提交即异步跑），没有队列也没有重试调度器。
   * 进程重启 / 崩溃时，正在跑或排队中的作业**没人再执行它**，状态会永远停在
   * running，任务球就一直转圈——这就是「明明生成完了却一直显示生成中」的根因。
   *
   * 阈值取 30 分钟：出图正常 1 分钟内结束，30 分钟仍在跑基本可以断定是被中断了。
   */
  async onModuleInit(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 60_000);
    try {
      const { count } = await this.prisma.generationJob.updateMany({
        where: { status: { in: ['pending', 'running'] }, updatedAt: { lt: cutoff } },
        data: { status: 'interrupted', error: '服务重启导致任务中断，可重新提交' },
      });
      if (count > 0) this.logger.warn(`启动清理：${count} 条中断的生成作业已标记为 interrupted`);
    } catch (error) {
      // 清理失败不能挡住启动：这些作业最坏是任务球一直转圈，不影响其他功能
      this.logger.warn(`启动清理中断作业失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------- 对话线 ----------

  /** 列表：只带首轮提示词预览与轮次数，不回传全部轮次（列表页无需携带大树） */
  async list(tenantId: string) {
    const rows = await this.prisma.imageConversation.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        turns: { take: 1, orderBy: { createdAt: 'asc' }, select: { prompt: true } },
        _count: { select: { turns: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      preview: row.turns[0]?.prompt ?? '',
      turnCount: row._count.turns,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  create(tenantId: string, userId: string, dto: CreateConversationDto) {
    return this.prisma.imageConversation.create({
      data: { tenantId, userId, ...(dto.title ? { title: dto.title.trim() } : {}) },
    });
  }

  /**
   * 详情：轮次按 createdAt 正序，每轮附带 children[]（以该轮为 parentId 的直接子轮 id），
   * 前端据此把线性 turns 构成分支树并渲染「分支 N/M」导航。
   */
  async detail(tenantId: string, id: string) {
    const conversation = await this.mustGetConversation(tenantId, id);
    const turns = await this.prisma.imageTurn.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });

    const childrenOf = new Map<string, string[]>();
    for (const turn of turns) {
      if (!turn.parentId) continue;
      const bucket = childrenOf.get(turn.parentId);
      if (bucket) bucket.push(turn.id);
      else childrenOf.set(turn.parentId, [turn.id]);
    }

    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      turns: turns.map((turn) => ({
        id: turn.id,
        parentId: turn.parentId,
        prompt: turn.prompt,
        kind: turn.kind,
        status: turn.status,
        error: turn.error,
        variants: this.readVariants(turn.variants),
        createdAt: turn.createdAt,
        children: childrenOf.get(turn.id) ?? [],
      })),
    };
  }

  async rename(tenantId: string, id: string, dto: UpdateConversationDto) {
    const conversation = await this.mustGetConversation(tenantId, id);
    return this.prisma.imageConversation.update({ where: { id: conversation.id }, data: { title: dto.title.trim() } });
  }

  /** 删除对话线：轮次靠 FK onDelete: Cascade 一并清理 */
  async remove(tenantId: string, id: string) {
    const conversation = await this.mustGetConversation(tenantId, id);
    await this.prisma.imageConversation.delete({ where: { id: conversation.id } });
    return { id: conversation.id };
  }

  // ---------- 轮次 ----------

  /**
   * 发起一轮：校验 -> 同事务写 user 轮 + assistant 轮 + 作业 -> 异步出图。
   * 三条记录要么全成要么全败，避免出现「有轮次没作业」的半截状态。
   */
  async createTurn(tenantId: string, userId: string, conversationId: string, dto: CreateTurnDto) {
    const conversation = await this.mustGetConversation(tenantId, conversationId);

    // 分支父轮必须落在同一对话线内（否则前端树会串线）
    if (dto.parentId) {
      const parent = await this.prisma.imageTurn.findFirst({
        where: { id: dto.parentId, conversationId: conversation.id, tenantId },
        select: { id: true },
      });
      if (!parent) throw new BadRequestException('PARENT_TURN_NOT_IN_CONVERSATION');
    }

    // 参考图：本租户且必须是图片资产。当前生图暂不支持图生图，参考图仅作上下文记录到 params
    let refAsset: { id: string } | null = null;
    if (dto.refAssetId) {
      refAsset = await this.prisma.mediaAsset.findFirst({
        where: { id: dto.refAssetId, tenantId, kind: 'image' },
        select: { id: true },
      });
      if (!refAsset) throw new BadRequestException('REF_ASSET_INVALID');
    }

    const fullPrompt = refAsset
      ? `${dto.prompt}（已附参考图，请保持同一风格、主体与构图语言）`
      : dto.prompt;

    const created = await this.prisma.$transaction(async (tx) => {
      const userTurn = await tx.imageTurn.create({
        data: { conversationId: conversation.id, tenantId, parentId: dto.parentId ?? null, prompt: dto.prompt, kind: 'user', status: 'ready' },
      });
      const assistantTurn = await tx.imageTurn.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          // assistant 轮挂在刚建的 user 轮下，前端把 user+assistant 合成一条消息渲染
          parentId: userTurn.id,
          prompt: fullPrompt,
          kind: 'assistant',
          status: 'pending',
        },
      });
      const job = await tx.generationJob.create({
        data: {
          tenantId,
          userId,
          kind: 'image',
          status: 'pending',
          params: {
            conversationId: conversation.id,
            userTurnId: userTurn.id,
            turnId: assistantTurn.id,
            prompt: dto.prompt,
            fullPrompt,
            size: dto.size,
            fitVideo: dto.fitVideo ?? false,
            background: dto.background ?? 'auto',
            quality: dto.quality ?? 'standard',
            refAssetId: refAsset?.id ?? null,
            // 局部重绘：原图 + 遮罩必须成对，半对会在出图阶段报错而不是静默整张重画
            imageAssetId: dto.imageAssetId ?? null,
            maskDataUrl: dto.maskDataUrl ?? null,
            parentId: dto.parentId ?? null,
          } satisfies JobParams,
        },
      });
      await tx.imageConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      return { userTurn, assistantTurn, job };
    });

    // 出图放到后台跑：HTTP 立刻返回三个 id，前端拿 jobId 轮询
    setImmediate(() => {
      void this.runJob(tenantId, userId, created.job.id);
    });

    return { userTurnId: created.userTurn.id, turnId: created.assistantTurn.id, jobId: created.job.id };
  }

  /** 改轮次提示词（前端「恢复历史轮次到输入框」后另存用） */
  async updateTurn(tenantId: string, id: string, dto: UpdateTurnDto) {
    const turn = await this.mustGetTurn(tenantId, id);
    return this.prisma.imageTurn.update({ where: { id: turn.id }, data: { prompt: dto.prompt.trim() } });
  }

  /** 删一轮：连同其全部后代（分支子树）一并删除。parentId 无 FK 自关联，只能显式收集后单语句删 */
  async removeTurn(tenantId: string, id: string) {
    const turn = await this.mustGetTurn(tenantId, id);
    const siblings = await this.prisma.imageTurn.findMany({
      where: { conversationId: turn.conversationId },
      select: { id: true, parentId: true },
    });

    const doomed = new Set<string>([turn.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of siblings) {
        if (row.parentId && doomed.has(row.parentId) && !doomed.has(row.id)) {
          doomed.add(row.id);
          grew = true;
        }
      }
    }

    await this.prisma.imageTurn.deleteMany({ where: { id: { in: [...doomed] } } });
    return { id: turn.id, deletedTurns: doomed.size };
  }

  // ---------- 异步作业 ----------

  /** 作业状态轮询（跨租户 404） */
  async job(tenantId: string, id: string) {
    const job = await this.prisma.generationJob.findFirst({ where: { id, tenantId } });
    if (!job) throw new NotFoundException('JOB_NOT_FOUND');
    return { id: job.id, kind: job.kind, status: job.status, resultUrl: job.resultUrl, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt };
  }

  /**
   * 执行出图：调 MediaService.generateImage（扣额度在其中完成，本服务不重复扣），
   * 成功后作业置 done + 结果 URL 追加进对应 assistant 轮的变体，失败则两端一起置 failed。
   *
   * 可重跑的状态（作业失败后重跑是这个端点存在的唯一理由）：
   *   - pending   首次执行
   *   - failed    失败且**没扣**额度（失败发生在扣额度之前）→ 补跑正常扣一次
   *   - unknown   已扣额度但结果待核对 → 补跑**不再扣第二次**（alreadyCharged）
   * done / running / interrupted 不重跑：已经有结果的不用重跑，进行中的不该被顶掉。
   *
   * 幂等：作业级 clientRequestId —— 同一个作业只可能有一份产物。
   * 补跑命中已有产物时直接复用，不再出图也不再扣额度。
   */
  async runJob(tenantId: string, userId: string, jobId: string): Promise<JobRunResult> {
    try {
      const job = await this.prisma.generationJob.findFirst({ where: { id: jobId, tenantId } });
      if (!job) {
        return { ran: false, status: 'not_found', reason: 'JOB_NOT_FOUND', message: '作业不存在或不属于当前租户' };
      }
      if (!RERUNNABLE_JOB_STATUS.includes(job.status)) {
        return {
          ran: false,
          status: job.status,
          reason: 'JOB_NOT_RERUNNABLE',
          message: `作业当前状态是「${job.status}」，不需要（也不能）补跑`,
        };
      }

      // 已扣额度的作业补跑是**免费**的：用户已经为这一笔付过钱了。
      // 但上游 API 的成本是真的 —— 所以给一次免费补跑机会（抢占式，并发重复点只有一个能抢到）。
      // 机会用完还想要，只能重新发起一次新的生成（那一笔会正常计费）。
      const isFreeRerun = job.status === 'unknown';
      if (isFreeRerun) {
        const claim = await this.idem.claim(tenantId, `${FREE_RERUN_KEY_PREFIX}${job.id}`, 'canvas_free_rerun');
        if (!claim.fresh) {
          return {
            ran: false,
            status: job.status,
            reason: 'FREE_RERUN_ALREADY_USED',
            message: '这次免费补跑机会已经用过了。要再出图请重新发起一次生成（会重新计费）。',
          };
        }
      }

      const params = job.params as unknown as JobParams;
      await this.prisma.generationJob.update({ where: { id: job.id }, data: { status: 'running' } });

      const asset = await this.media.generateImage({
        tenantId,
        userId,
        prompt: params.fullPrompt ?? params.prompt,
        size: params.size,
        fitVideo: params.fitVideo,
        background: params.background,
        ...(params.imageAssetId && params.maskDataUrl
          ? { imageAssetId: params.imageAssetId, maskDataUrl: params.maskDataUrl }
          : {}),
        // 作业级幂等键：同一个作业只有一份产物（补跑不会出第二张图）。
        // 免费补跑换一把键：上一把键的幂等记录还占着（那笔钱已经花掉了，不能让它再跑一次），
        // 免扣靠 alreadyCharged 标志，不靠换键 —— 换键只是为了避开已占用的幂等记录。
        clientRequestId: isFreeRerun ? `canvas-job:${job.id}:rerun` : `canvas-job:${job.id}`,
        // unknown = 上一次已经扣过额度（扣了钱却没出图），补跑不能再扣第二次
        alreadyCharged: isFreeRerun,
        title: 'AI 画布',
      });

      await this.prisma.generationJob.update({ where: { id: job.id }, data: { status: 'done', resultUrl: asset.url, error: null } });
      await this.appendVariant(params.turnId, asset.url);
      return { ran: true, status: 'done', assetId: asset.id };
    } catch (error) {
      const reason = this.errorText(error);
      // 扣了额度却没出图，不等于「没花钱的失败」。标成 unknown（结果待核对），
      // 用户看到的是「这笔钱已经花了、结果待核对」而不是笼统的「失败」——
      // 后者会让人以为没扣钱就再点一次，反而多扣一次。这正是客诉高发的那一态。
      const status: string = isChargedError(error) ? 'unknown' : 'failed';
      this.logger.warn(`画布作业 ${jobId} ${status === 'unknown' ? '结果待核对' : '出图失败'}: ${reason}`);
      try {
        const job = await this.prisma.generationJob.findFirst({ where: { id: jobId, tenantId }, select: { params: true } });
        await this.prisma.generationJob.update({ where: { id: jobId }, data: { status, error: reason } });
        const turnId = (job?.params as unknown as JobParams | undefined)?.turnId;
        if (turnId) {
          await this.prisma.imageTurn.update({ where: { id: turnId }, data: { status, error: reason } });
        }
      } catch {
        // 收尾失败（如进程正在关闭）不再抛出：作业状态已尽力落库
      }
      return {
        ran: true,
        status,
        reason,
        message: status === 'unknown'
          ? '这次生成已经扣了额度但没拿到结果，状态记为「待核对」。可以补跑一次（不重复扣额度），补跑机会只有一次。'
          : '这次生成失败（未扣额度），可以直接补跑。',
      };
    }
  }

  /**
   * 把结果 URL 追加进 assistant 轮的变体列表（出图完成后由 runJob 调用）。
   * 去重规则：按 url 去重，同一张图不重复计数；已有项不重排编号，只补新项。
   */
  async appendVariant(turnId: string, url: string): Promise<void> {
    const turn = await this.prisma.imageTurn.findUnique({ where: { id: turnId } });
    if (!turn) return;
    const variants = this.readVariants(turn.variants);
    const merged = variants.some((v) => v.url === url)
      ? variants
      : [...variants, { url, label: `变体 ${variants.length + 1}`, createdAt: new Date().toISOString() }];
    await this.prisma.imageTurn.update({
      where: { id: turnId },
      data: { status: 'ready', error: null, variants: merged as unknown as Prisma.InputJsonValue },
    });
  }

  // ---------- 内部 ----------

  private async mustGetConversation(tenantId: string, id: string) {
    const conversation = await this.prisma.imageConversation.findFirst({ where: { id, tenantId } });
    if (!conversation) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    return conversation;
  }

  private async mustGetTurn(tenantId: string, id: string) {
    const turn = await this.prisma.imageTurn.findFirst({ where: { id, tenantId } });
    if (!turn) throw new NotFoundException('TURN_NOT_FOUND');
    return turn;
  }

  private readVariants(raw: unknown): TurnVariant[] {
    return Array.isArray(raw) ? (raw as TurnVariant[]) : [];
  }

  /** Nest 的 HttpException 允许 message 为对象，统一压成可落库的单行文本 */
  private errorText(error: unknown): string {
    if (error instanceof Error) {
      const message: unknown = error.message;
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      return text.slice(0, 500);
    }
    return String(error).slice(0, 500);
  }

  // ---------- 任务中心（跨页面/跨刷新的生成任务来源） ----------

  /**
   * 列出本租户最近 50 条生成任务。
   * 返回体刻意扁平化，前端任务球直接渲染，无需再拼装轮次上下文。
   */
  async listTasks(tenantId: string): Promise<
    { id: string; kind: string; status: string; title: string; resultUrl: string | null; error: string | null; createdAt: string }[]
  > {
    const jobs = await this.prisma.generationJob.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jobs.map((j) => {
      const params = (j.params ?? {}) as { prompt?: string; title?: string };
      return {
        id: j.id,
        kind: j.kind,
        status: j.status,
        title: (params.title || params.prompt || '生成任务').slice(0, 40),
        resultUrl: j.resultUrl,
        error: j.error,
        createdAt: j.createdAt.toISOString(),
      };
    });
  }

  /** 清空已结束任务；进行中的必须保留，否则用户会以为任务丢了 */
  async clearFinishedTasks(tenantId: string): Promise<{ deleted: number }> {
    const r = await this.prisma.generationJob.deleteMany({
      where: { tenantId, status: { in: ['done', 'failed'] } },
    });
    return { deleted: r.count };
  }
}
