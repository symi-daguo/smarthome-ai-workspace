import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import { LlmService } from '../llm/llm.service.js';
import { TokenService } from '../billing/token.service.js';

/**
 * 接单工作台服务：销售接待线索的状态机 + AI 协助（intake 结构化解析 / 跟进建议 / 产品匹配）。
 * 设计参考开源 CRM（Twenty / NextCRM / Headless CRM）的 lead pipeline 模式，
 * 复用自有 NestJS+Prisma+LlmService 栈自建，不引入外部框架。
 */

/** 允许的状态流转（参考 CRM pipeline：新建 -> 已确认 -> 已出方案 -> 已报价 -> 成单/失单） */
const TRANSITIONS: Record<string, string[]> = {
  new: ['qualified', 'lost'],
  qualified: ['proposed', 'lost'],
  proposed: ['quoted', 'qualified', 'lost'],
  quoted: ['won', 'proposed', 'lost'],
  won: [],
  lost: ['new'], // 失单可重新激活
};

export const STATUS_LABELS: Record<string, string> = {
  new: '了解客户',
  qualified: '需求确认',
  proposed: '方案匹配',
  quoted: '报价',
  won: '成单',
  lost: '失单',
};

// AI 协助扣费额度（intake 解析 / 跟进建议各一次极短对话）
const INTAKE_TOKENS = Number(process.env.BILLING_ORDER_INTAKE_TOKENS ?? 5);
const FOLLOWUP_TOKENS = Number(process.env.BILLING_ORDER_FOLLOWUP_TOKENS ?? 5);

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tokens: TokenService,
  ) {}

  private async mustGet(tenantId: string, id: string) {
    const order = await this.prisma.orderRequest.findFirst({ where: { id, tenantId }, include: { notes: { orderBy: { createdAt: 'asc' } } } });
    if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
    return order;
  }

  list(tenantId: string) {
    return this.prisma.orderRequest.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { notes: true } } },
    });
  }

  detail(tenantId: string, id: string) {
    return this.mustGet(tenantId, id);
  }

  create(tenantId: string, userId: string, dto: { customer: string; phone?: string; community?: string; area?: string; layout?: string; needs?: string; rawInput?: string; budget?: string; ecosystem?: string }) {
    return this.prisma.orderRequest.create({
      data: {
        tenantId,
        userId,
        customer: dto.customer.trim(),
        phone: dto.phone?.trim() ?? '',
        community: dto.community?.trim() ?? '',
        area: dto.area?.trim() ?? '',
        layout: dto.layout?.trim() ?? '',
        needs: dto.needs?.trim() ?? '',
        rawInput: dto.rawInput ?? '',
        budget: dto.budget?.trim() ?? '',
        ecosystem: dto.ecosystem?.trim() ?? '',
      },
    });
  }

  async update(tenantId: string, id: string, dto: Partial<{ customer: string; phone: string; community: string; area: string; layout: string; needs: string; rawInput: string; budget: string; ecosystem: string }>) {
    const owned = await this.assertOwned(tenantId, id);
    return this.prisma.orderRequest.update({ where: { id: owned.id }, data: dto });
  }

  /** 独立断言归属（update 不能复用 mustGet 的 include 结果做 where） */
  private async assertOwned(tenantId: string, id: string) {
    const order = await this.prisma.orderRequest.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
    return order;
  }

  async changeStatus(tenantId: string, id: string, status: string, opts: { lostReason?: string; planId?: string }) {
    const order = await this.mustGet(tenantId, id);
    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(status)) {
      throw new BadRequestException({ code: 'ILLEGAL_TRANSITION', message: `不允许从「${STATUS_LABELS[order.status]}」直接到「${STATUS_LABELS[status] ?? status}」` });
    }
    return this.prisma.orderRequest.update({
      where: { id },
      data: {
        status,
        ...(status === 'lost' ? { lostReason: opts.lostReason?.trim() ?? '' } : {}),
        ...(status === 'proposed' && opts.planId ? { planId: opts.planId } : {}),
      },
    });
  }

  async addNote(tenantId: string, userId: string, id: string, content: string) {
    await this.assertOwned(tenantId, id);
    return this.prisma.orderNote.create({ data: { orderId: id, userId, content: content.trim() } });
  }

  async remove(tenantId: string, id: string) {
    const owned = await this.assertOwned(tenantId, id);
    return this.prisma.orderRequest.delete({ where: { id: owned.id } });
  }

  /**
   * AI 接待解析：把销售口述/微信粘贴的客户原始描述，
   * 用 LLM 抽取为结构化字段 + 需求要点 + 推荐生态与产品品类（对接产品库）。
   */
  async intake(tenantId: string, userId: string, rawInput: string) {
    const parsed = await this.llm.chatObject<Record<string, string>>({
      systemPrompt: `你是智能家居门店的销售接待助手。从客户咨询原始描述中抽取字段：
"customer"(客户称呼)、"phone"(电话，没有则空)、"community"(小区名)、"area"(面积㎡)、
"layout"(户型)、"budget"(预算)、"ecosystem"(生态偏好，如米家/HomeKit/不限)、
"needs"(需求要点，用中文顿号分隔)、"categories"(建议关注的产品品类，从 gateway/switch/sensor/light/curtain/security/appliance/audio/hvac 中选，逗号分隔)。
只返回 JSON 对象。`,
      prompt: rawInput,
      rag: { tenantId, userId, scene: 'order-intake' },
    });

    // 产品匹配：按建议品类从产品库取候选（真实数据，非 LLM 幻觉）
    const cats = (parsed.categories ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    const products = cats.length
      ? await this.prisma.product.findMany({ where: { category: { in: cats }, active: true }, orderBy: { sortOrder: 'asc' }, take: 12 })
      : [];

    // 与方案生成一致：解析成功才扣额（LLM 失败异常上抛，不白扣）
    await this.tokens.consume(tenantId, INTAKE_TOKENS, 'CONSUME', { kind: 'order-intake' }, userId);

    return {
      customer: parsed.customer ?? '',
      phone: parsed.phone ?? '',
      community: parsed.community ?? '',
      area: parsed.area ?? '',
      layout: parsed.layout ?? '',
      budget: parsed.budget ?? '',
      ecosystem: parsed.ecosystem ?? '',
      needs: parsed.needs ?? '',
      categories: cats,
      products: products.map((p) => ({ id: p.id, name: p.name, category: p.category, priceMin: p.priceMin, priceMax: p.priceMax, perRoom: p.perRoom })),
    };
  }

  /** AI 跟进建议：基于当前状态 + 需求 + 最近跟进，给出下一步动作与话术要点 */
  async followupAdvice(tenantId: string, userId: string, id: string) {
    const order = await this.mustGet(tenantId, id);
    const recentNotes = order.notes.slice(-5).map((n) => n.content).join('；') || '（暂无跟进记录）';
    const { reply } = await this.llm.chat({
      model: 'MiniMax-M3',
      maxTokens: 400,
      systemPrompt: '你是智能家居门店的销售教练。根据线索状态与需求，给出下一步跟进建议：1 句核心动作 + 3 条要点（含话术方向）。控制在 120 字内，中文，不要 markdown。',
      prompt: `客户：${order.customer}（${order.community || '小区未知'} ${order.area || '面积未知'} ${order.layout || ''}）\n预算：${order.budget || '未知'}\n生态：${order.ecosystem || '未知'}\n需求：${order.needs || order.rawInput.slice(0, 200)}\n当前阶段：${STATUS_LABELS[order.status]}\n最近跟进：${recentNotes}`,
    });
    await this.tokens.consume(tenantId, FOLLOWUP_TOKENS, 'CONSUME', { kind: 'order-followup', orderId: id }, userId);
    return { advice: reply };
  }
}
