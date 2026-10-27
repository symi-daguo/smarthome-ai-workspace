import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { LlmService } from '../llm/llm.service.js';
import { DEFAULT_CHAT_MODEL } from '../llm/llm.constants.js';
import { TokenService } from '../billing/token.service.js';
import {
  RENO_STAGES, SCENE_KEYS, SYSTEM_KEYS,
  type CreateOrderDto, type UpdateOrderDto,
  type RenoStage, type SceneKey, type SystemKey, type SystemsMap,
} from './orders.schemas.js';

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
    private readonly idem: IdempotencyService,
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

  create(tenantId: string, userId: string, dto: CreateOrderDto) {
    return this.prisma.orderRequest.create({
      data: { ...this.toRow(dto), tenantId, userId, customer: dto.customer.trim() },
    });
  }

  /**
   * DTO -> Prisma 行数据：字符串统一 trim、缺省给空串/0。
   * scenes / systems 是 Json 列，Prisma 接受已解析的对象/数组，无需再序列化。
   */
  private toRow(dto: Partial<CreateOrderDto>): Record<string, unknown> {
    const str = (v: string | undefined): string => v?.trim() ?? '';
    return {
      phone: str(dto.phone),
      community: str(dto.community),
      area: str(dto.area),
      layout: str(dto.layout),
      needs: str(dto.needs),
      rawInput: dto.rawInput ?? '',
      budget: str(dto.budget),
      ecosystem: str(dto.ecosystem),
      renoStage: dto.renoStage ?? 'undecided',
      moveInDate: str(dto.moveInDate),
      city: str(dto.city),
      district: str(dto.district),
      address: str(dto.address),
      store: str(dto.store),
      residents: str(dto.residents),
      priority1: str(dto.priority1),
      priority2: str(dto.priority2),
      priority3: str(dto.priority3),
      exclusions: str(dto.exclusions),
      habits: str(dto.habits),
      nightHabits: str(dto.nightHabits),
      devicePrefs: str(dto.devicePrefs),
      scenes: dto.scenes ?? [],
      systems: dto.systems ?? {},
      budgetMin: dto.budgetMin ?? 0,
      budgetMax: dto.budgetMax ?? 0,
      budgetScope: str(dto.budgetScope),
    };
  }

  async update(tenantId: string, id: string, dto: UpdateOrderDto) {
    const owned = await this.assertOwned(tenantId, id);
    // customer 是必填主字段，partial 更新时不能被 toRow 覆盖成空串
    const { customer, ...rest } = dto;
    return this.prisma.orderRequest.update({
      where: { id: owned.id },
      data: {
        ...this.toRow(rest),
        ...(customer !== undefined ? { customer: customer.trim() } : {}),
      },
    });
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
   *
   * 2026-10-13 扩展：除原有 9 个自由文本字段外，一并抽取表单里的结构化部分
   * （装修阶段 / 体验场景 / 系统范围三态 / 预算上下限），
   * 否则销售仍然只能靠 needs 一段自由文本兜底，下游方案与报价拿不到结构化输入。
   * 场景与系统 key 必须落在 SCENE_KEYS / SYSTEM_KEYS 白名单内，未提及就不填——
   * 猜出来的「系统需要」比没有更危险。
   */
  async intake(tenantId: string, userId: string, rawInput: string, clientRequestId?: string) {
    // 幂等：接单接待要调 LLM 并扣额度，重试不该重复付费
    const claim = await this.idem.claim(tenantId, clientRequestId, 'order-intake');
    if (!claim.fresh) {
      return { ...((claim.previous as Record<string, unknown> | null) ?? {}), deduped: true };
    }
    try {
      return await this.doIntake(tenantId, userId, rawInput, clientRequestId);
    } catch (e) {
      await this.idem.release(tenantId, clientRequestId);
      throw e;
    }
  }

  /** 接单 AI 接待的实际执行体（幂等抢占在 intake 里） */
  private async doIntake(tenantId: string, userId: string, rawInput: string, clientRequestId?: string) {
    const parsed = await this.llm.chatObject<Record<string, unknown>>({
      systemPrompt: `你是智能家居门店的销售接待助手。从客户咨询原始描述中抽取字段，只返回 JSON 对象。

基础字段：
"customer"客户称呼、"phone"电话、没有则空、"community"小区名、"area"面积㎡、"layout"户型、
"budget"预算档位描述、"ecosystem"生态偏好（米家/HomeKit/不限）、
"needs"需求要点（中文顿号分隔）、"categories"建议关注的产品品类
（从 gateway/switch/sensor/light/curtain/security/appliance/audio/hvac 中选，逗号分隔）。

房屋与阶段（未提及填空串）：
"renoStage"取 ${RENO_STAGES.join('/')} 之一、"moveInDate"预计入住时间、
"city"城市、"district"区县、"address"项目地址、"store"门店或服务商名称。

生活需求（未提及填空串）：
"residents"谁会经常住在这里、"priority1"/"priority2"/"priority3"优先需求、
"exclusions"明确不做的内容、"habits"控制习惯、"nightHabits"睡前与夜间习惯、
"devicePrefs"已有设备或品牌偏好。

结构化数组（未提及就给空数组）：
"scenes"客户想体验的场景，取 ${SCENE_KEYS.join('/')} 中的 key，仅在客户明确表达时才列。

结构化对象（未提及就给空对象）：
"systems"每项形如 {"lighting":{"need":"yes|no|maybe","area":"应用区域","detail":"具体配置"}}，
need 取 yes/no/maybe，只列客户明确提到的系统 key（${SYSTEM_KEYS.join('/')}）。

预算（数字，未提及给 0）：
"budgetMin"理想预算起点（元）、"budgetMax"客户预算上限（元）、"budgetScope"预算包含范围。

只输出客户真实说过的内容，绝不推测未提及的系统需求或场景。`,
      prompt: rawInput,
      rag: { tenantId, userId, scene: 'order-intake' },
    });

    // 白名单过滤：模型偶尔会吐字典外的 key / 数组 / 值，直接当枚举写库会 500
    const scenes = (Array.isArray(parsed.scenes) ? parsed.scenes : [])
      .filter((s): s is SceneKey => (SCENE_KEYS as readonly string[]).includes(String(s)));
    const systems: Partial<SystemsMap> = {};
    if (parsed.systems && typeof parsed.systems === 'object' && !Array.isArray(parsed.systems)) {
      for (const [key, val] of Object.entries(parsed.systems as Record<string, unknown>)) {
        if (!(SYSTEM_KEYS as readonly string[]).includes(key) || !val || typeof val !== 'object') continue;
        const e = val as Record<string, unknown>;
        const need = e.need;
        if (need !== 'yes' && need !== 'no' && need !== 'maybe') continue;
        systems[key as SystemKey] = { need, area: String(e.area ?? '').slice(0, 120), detail: String(e.detail ?? '').slice(0, 240) };
      }
    }
    const renoStage = (RENO_STAGES as readonly string[]).includes(String(parsed.renoStage))
      ? (parsed.renoStage as RenoStage)
      : 'undecided';
    const num = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
    };
    const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

    // 产品匹配：按建议品类从产品库取候选（真实数据，非 LLM 幻觉）
    // 租户隔离：只取公共库（tenantId=null）+ 本租户的产品 ——
    // 不带这个条件会把**别的租户**的产品库也拉进来（客户能看见别家的产品与价格）
    const cats = text(parsed.categories, 300).split(',').map((c) => c.trim()).filter(Boolean);
    const products = cats.length
      ? await this.prisma.product.findMany({
          where: { category: { in: cats }, active: true, OR: [{ tenantId: null }, { tenantId }] },
          orderBy: { sortOrder: 'asc' },
          take: 12,
        })
      : [];

    // 与方案生成一致：解析成功才扣额（LLM 失败异常上抛，不白扣）
    await this.tokens.consume(tenantId, INTAKE_TOKENS, 'CONSUME', { kind: 'order-intake' }, userId);
    const dedupeTail = clientRequestId ? await this.idem.complete(tenantId, clientRequestId, 'order-intake', {}) : undefined;
    void dedupeTail;

    return {
      customer: text(parsed.customer, 64),
      phone: text(parsed.phone, 32),
      community: text(parsed.community, 64),
      area: text(parsed.area, 32),
      layout: text(parsed.layout, 32),
      budget: text(parsed.budget, 64),
      ecosystem: text(parsed.ecosystem, 64),
      needs: text(parsed.needs, 2000),
      renoStage,
      moveInDate: text(parsed.moveInDate, 64),
      city: text(parsed.city, 64),
      district: text(parsed.district, 64),
      address: text(parsed.address, 240),
      store: text(parsed.store, 120),
      residents: text(parsed.residents, 240),
      priority1: text(parsed.priority1, 120),
      priority2: text(parsed.priority2, 120),
      priority3: text(parsed.priority3, 120),
      exclusions: text(parsed.exclusions, 500),
      habits: text(parsed.habits, 500),
      nightHabits: text(parsed.nightHabits, 500),
      devicePrefs: text(parsed.devicePrefs, 500),
      scenes,
      systems,
      budgetMin: num(parsed.budgetMin),
      budgetMax: num(parsed.budgetMax),
      budgetScope: text(parsed.budgetScope, 240),
      categories: cats,
      products: products.map((p) => ({ id: p.id, name: p.name, category: p.category, priceMin: p.priceMin, priceMax: p.priceMax, perRoom: p.perRoom })),
    };
  }

  /** AI 跟进建议：基于当前状态 + 需求 + 最近跟进，给出下一步动作与话术要点 */
  async followupAdvice(tenantId: string, userId: string, id: string, clientRequestId?: string) {
    const claim = await this.idem.claim(tenantId, clientRequestId, 'order-followup');
    if (!claim.fresh) {
      return { advice: (claim.previous as { advice?: string } | null)?.advice ?? '这次跟进建议已在生成中，请稍候再试', deduped: true };
    }
    try {
      const out = await this.doFollowupAdvice(tenantId, userId, id, clientRequestId);
      return out;
    } catch (e) {
      await this.idem.release(tenantId, clientRequestId);
      throw e;
    }
  }

  private async doFollowupAdvice(tenantId: string, userId: string, id: string, clientRequestId?: string) {
    const order = await this.mustGet(tenantId, id);
    const recentNotes = order.notes.slice(-5).map((n) => n.content).join('；') || '（暂无跟进记录）';
    const { reply } = await this.llm.chat({
      model: DEFAULT_CHAT_MODEL,
      maxTokens: 400,
      systemPrompt: '你是智能家居门店的销售教练。根据线索状态与需求，给出下一步跟进建议：1 句核心动作 + 3 条要点（含话术方向）。控制在 120 字内，中文，不要 markdown。',
      prompt: `客户：${order.customer}（${order.community || '小区未知'} ${order.area || '面积未知'} ${order.layout || ''}）\n预算：${order.budget || '未知'}\n生态：${order.ecosystem || '未知'}\n需求：${order.needs || order.rawInput.slice(0, 200)}\n当前阶段：${STATUS_LABELS[order.status]}\n最近跟进：${recentNotes}`,
    });
    await this.tokens.consume(tenantId, FOLLOWUP_TOKENS, 'CONSUME', { kind: 'order-followup', orderId: id }, userId);
    const out = { advice: reply };
    await this.idem.complete(tenantId, clientRequestId, 'order-followup', out);
    return out;
  }
}
