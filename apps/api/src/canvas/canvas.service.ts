import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MediaService } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.module.js';
import type { CreateConversationDto, CreateTurnDto, UpdateConversationDto, UpdateTurnDto } from './canvas.schemas.js';

/**
 * AI 画布（对话式生图）：对话线 + 轮次树 + 异步生成作业。
 *
 * 三条不变量（与参考站语义一致，勿轻易改）：
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
  parentId?: string | null;
}

@Injectable()
export class CanvasService {
  private readonly logger = new Logger(CanvasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

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

    // 参考图：本租户且必须是图片资产。我方生图暂不支持图生图，参考图仅作上下文记录到 params
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
   * 幂等：非 pending 的作业直接返回，避免重复扣费与重复追加变体。
   */
  async runJob(tenantId: string, userId: string, jobId: string): Promise<void> {
    try {
      const job = await this.prisma.generationJob.findFirst({ where: { id: jobId, tenantId } });
      if (!job || job.status !== 'pending') return;
      const params = job.params as unknown as JobParams;
      await this.prisma.generationJob.update({ where: { id: job.id }, data: { status: 'running' } });

      const asset = await this.media.generateImage({
        tenantId,
        userId,
        prompt: params.fullPrompt ?? params.prompt,
        size: params.size,
        fitVideo: params.fitVideo,
        background: params.background,
        title: 'AI 画布',
      });

      await this.prisma.generationJob.update({ where: { id: job.id }, data: { status: 'done', resultUrl: asset.url, error: null } });
      await this.appendVariant(params.turnId, asset.url);
    } catch (error) {
      const reason = this.errorText(error);
      this.logger.warn(`画布作业 ${jobId} 出图失败: ${reason}`);
      try {
        const job = await this.prisma.generationJob.findFirst({ where: { id: jobId, tenantId }, select: { params: true } });
        await this.prisma.generationJob.update({ where: { id: jobId }, data: { status: 'failed', error: reason } });
        const turnId = (job?.params as unknown as JobParams | undefined)?.turnId;
        if (turnId) {
          await this.prisma.imageTurn.update({ where: { id: turnId }, data: { status: 'failed', error: reason } });
        }
      } catch {
        // 收尾失败（如进程正在关闭）不再抛出：作业状态已尽力落库
      }
    }
  }

  /**
   * 把结果 URL 追加进 assistant 轮的变体列表（出图完成后由 runJob 调用）。
   * 去重规则照抄参考站：按 url 去重，同一张图不重复计数；已有项不重排编号，只补新项。
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
}
