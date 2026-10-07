import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import { TokenService } from '../billing/token.service.js';
import { LlmService } from '../llm/llm.service.js';

/**
 * 方案页结构（9 页标准方案模板）：
 * - type 决定幻灯片版式：cover 封面 / brand 品牌实力 / layout 空间动线 / needs 需求洞察 /
 *   ecosystem 生态规划 / scene 场景拆解 / budget 预算 / delivery 交付闭环
 * - narration 为"本页讲解稿"（客户阅读模式不显示，仅编辑/导出讲稿可见）
 */
export interface PlanPage {
  type: 'cover' | 'brand' | 'layout' | 'needs' | 'ecosystem' | 'scene' | 'budget' | 'delivery';
  heading: string;
  subtitle: string;
  body: string;
  bullets: string[];
  narration: string;
  /** 底部引言块（一页一句价值收束语） */
  quote?: string;
}

interface PlanInput {
  tenantId: string;
  userId: string;
  title: string;
  customer: string;
  area: string;
  budget: string;
  ecosystem: string;
  store: string;
  highlights: string;
  keySpaces: string;
  needs: string;
  style: string;
  edition: 'standard' | 'presale' | 'private';
  pageCount: number;
  floorplanAssetId?: string | null;
  layoutPoints?: unknown[] | null;
}

const STYLE_NAMES: Record<string, string> = {
  A: '暖咖家装咨询', B: '极简莫兰迪', C: '轻奢暗金色', D: '原木自然侘寂', E: '都市黑白高对比',
  F: '新中式雅韵', G: '奶油法式', H: '意式灰调', I: '深空科技', J: '祖母绿', K: '手绘水彩',
};

// 标准完整方案 9 页骨架；超出部分按空间页扩展
const BASE_SKELETON: { type: PlanPage['type']; name: string }[] = [
  { type: 'cover', name: '封面页' },
  { type: 'brand', name: '品牌与服务实力' },
  { type: 'layout', name: '空间动线与智能规划' },
  { type: 'needs', name: '家庭需求洞察' },
  { type: 'ecosystem', name: '全屋智能生态规划' },
  { type: 'scene', name: '核心场景拆解｜归家与客厅模式' },
  { type: 'scene', name: '核心场景拆解｜卧室与卫生间体验' },
  { type: 'budget', name: '预算规划与性价比方案' },
  { type: 'delivery', name: '落地交付与售后闭环' },
];

// 每页扣费额度 env 可配（演示默认：标准/售前 100 token/页，私宅 160 token/页）
const TOKENS_PER_PAGE: Record<string, number> = {
  standard: Number(process.env.BILLING_PLAN_TOKENS ?? 100),
  presale: Number(process.env.BILLING_PLAN_TOKENS ?? 100),
  private: Number(process.env.BILLING_PLAN_PRIVATE_TOKENS ?? 160),
};

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly llm: LlmService,
  ) {}

  /** LLM 生成多页方案（9 页标准骨架，pageCount 超出部分追加空间场景页） */
  async create(input: PlanInput) {
    const styleName = STYLE_NAMES[input.style] ?? input.style;
    const pages = await this.generatePages(input, styleName);
    const cost = pages.length * (TOKENS_PER_PAGE[input.edition] ?? 100);
    await this.tokens.consume(
      input.tenantId,
      cost,
      'CONSUME',
      { kind: 'plan', title: input.title, pageCount: pages.length, edition: input.edition },
      input.userId,
    );

    return this.prisma.planProject.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        title: input.title,
        customer: input.customer,
        area: input.area,
        budget: input.budget,
        ecosystem: input.ecosystem,
        store: input.store,
        highlights: input.highlights,
        keySpaces: input.keySpaces,
        needs: input.needs,
        style: input.style,
        edition: input.edition,
        pageCount: pages.length,
        pages: pages as unknown as never,
        versionNo: 1,
        floorplanAssetId: input.floorplanAssetId ?? null,
        layoutPoints: (input.layoutPoints ?? null) as never,
      },
    });
  }

  /** 挂接户型图与设备点位（点位编辑器产物 → 空间动线页配图） */
  async attachFloorplan(tenantId: string, id: string, dto: { floorplanAssetId: string; layoutPoints?: unknown[] | null }) {
    await this.detail(tenantId, id);
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: dto.floorplanAssetId, tenantId } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    return this.prisma.planProject.update({
      where: { id },
      data: { floorplanAssetId: dto.floorplanAssetId, layoutPoints: (dto.layoutPoints ?? null) as never },
    });
  }

  private async generatePages(input: PlanInput, styleName: string): Promise<PlanPage[]> {
    // 9 页骨架 + 超出部分追加 scene 页（按重点空间拆分）
    const skeleton = [...BASE_SKELETON];
    const extra = Math.max(0, input.pageCount - BASE_SKELETON.length);
    for (let i = 0; i < extra; i += 1) {
      skeleton.splice(7, 0, { type: 'scene', name: `核心场景拆解｜补充场景 ${i + 1}` });
    }

    const outline = skeleton.map((s, i) => `${i + 1}. ${s.name}（type=${s.type}）`).join('\n');
    const prompt = [
      `请为以下客户生成一份可直接交付浏览的全屋智能方案文案（按页输出）。`,
      `项目名称：${input.title}`,
      `客户称呼：${input.customer || '（未提供，用"您"）'}`,
      `面积：${input.area || '未提供'}`,
      `预算：${input.budget || '未提供（给出常见区间）'}`,
      `智能生态：${input.ecosystem || '米家 / 可扩展全屋智能'}`,
      `门店品牌：${input.store || ''}`,
      `服务亮点：${input.highlights || ''}`,
      `重点空间：${input.keySpaces || '客餐厅、主卧、玄关、全屋网络'}`,
      `客户需求：${input.needs || '（未提供，按常见三口之家假设）'}`,
      `方案视觉风格：${styleName}（文案语气与页面主题匹配该风格）`,
      '',
      `方案共 ${skeleton.length} 页，页序与类型固定如下：`,
      outline,
      '',
      '输出 JSON 数组，每个元素是一页：{type, heading, subtitle, body, bullets, narration, quote}。',
      '字段要求：',
      '- heading：该页大标题（封面页为"项目名｜面积 + 全屋智能生活方案"式主张句）；',
      '- subtitle：一句话副标题/引言行（20 字内，封面页为客户价值主张）；',
      '- body：该页核心说明（60-140 字，面向终端客户可读）；',
      '- bullets：3-6 条要点；封面页为 3 条价值卡（格式"标题：一句话"）；空间/场景页每条格式"要点名：说明"；预算页每条格式"分项名：下限-上限"（纯数字区间，单位元，如"智能灯光系统：6000-12000"，不要写"元"字）；交付页每条格式"阶段名｜一句话说明"（如"复测对接｜现场确认点位与预留"）；',
      '- narration：本页讲解稿（销售当面讲解用，80-150 字口语化，客户阅读模式不显示）；',
      '- quote：该页底部一句话引言（25 字内，价值收束语，如"把钱花在每天用得上的地方"）。',
      '',
      '硬性合规要求：不得出现未经确认的时效、质保、包入住承诺；价格一律用区间；预算页 body 末尾注明"以上为建议区间，实际报价以门店方案师现场确认为准"；文案专业克制、面向终端客户可直接阅读。',
    ].join('\n');

    let pages: PlanPage[];
    try {
      const raw = await this.llm.chatJson<unknown>({
        systemPrompt: '你是资深全屋智能方案设计师，为智能家居服务商撰写交付客户的方案文案。',
        prompt,
        maxTokens: 12000,
      });
      pages = this.sanitizePages(raw, skeleton);
    } catch (e) {
      this.logger.warn(`方案生成失败: ${(e as Error).message}`);
      throw new ServiceUnavailableException({
        code: 'PLAN_GEN_FAILED',
        message: '方案生成失败（模型返回格式异常），请重试或调整描述',
      });
    }
    if (pages.length < skeleton.length) {
      throw new ServiceUnavailableException({
        code: 'PLAN_INCOMPLETE',
        message: `方案页数不足（${pages.length}/${skeleton.length}），请重试`,
      });
    }
    return pages;
  }

  /** 校验并收敛模型输出：按骨架顺序对齐 type，丢弃非法页 */
  private sanitizePages(raw: unknown, skeleton: { type: PlanPage['type']; name: string }[]): PlanPage[] {
    const list = Array.isArray(raw) ? raw : (raw as { pages?: unknown[] })?.pages;
    if (!Array.isArray(list)) throw new Error('LLM_JSON_PARSE_FAILED');
    const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    return list
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p, i) => ({
        type: (skeleton[i]?.type ?? 'scene') as PlanPage['type'],
        heading: str(p.heading, 200),
        subtitle: str(p.subtitle, 100),
        body: str(p.body, 8000),
        bullets: Array.isArray(p.bullets)
          ? p.bullets.filter((b) => b != null).map((b) => str(b, 500)).filter(Boolean).slice(0, 8)
          : [],
        narration: str(p.narration, 8000),
        quote: str(p.quote, 60),
      }))
      .filter((p) => p.heading.length > 0);
  }

  list(tenantId: string) {
    return this.prisma.planProject.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true, title: true, customer: true, area: true, style: true, edition: true,
        pageCount: true, versionNo: true, shareToken: true, updatedAt: true,
      },
    });
  }

  async detail(tenantId: string, id: string) {
    const plan = await this.prisma.planProject.findFirst({ where: { id, tenantId } });
    if (!plan) throw new NotFoundException('PLAN_NOT_FOUND');
    return plan;
  }

  /** 逐页审稿编辑：更新单页并版本 +1 */
  async updatePage(
    tenantId: string,
    id: string,
    dto: { index: number; heading?: string; body?: string; narration?: string },
  ) {
    const plan = await this.detail(tenantId, id);
    const pages = plan.pages as unknown as PlanPage[];
    if (!Array.isArray(pages) || dto.index < 0 || dto.index >= pages.length) {
      throw new BadRequestException('PAGE_INDEX_OUT_OF_RANGE');
    }
    pages[dto.index] = {
      ...pages[dto.index],
      ...(dto.heading !== undefined ? { heading: dto.heading.slice(0, 200) } : {}),
      ...(dto.body !== undefined ? { body: dto.body.slice(0, 8000) } : {}),
      ...(dto.narration !== undefined ? { narration: dto.narration.slice(0, 8000) } : {}),
    };
    return this.prisma.planProject.update({
      where: { id },
      data: { pages: pages as unknown as never, versionNo: { increment: 1 } },
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.detail(tenantId, id);
    await this.prisma.planProject.delete({ where: { id } });
  }

  /** 客户分享：按 token 公开只读 */
  async byShareToken(token: string) {
    const plan = await this.prisma.planProject.findUnique({ where: { shareToken: token } });
    if (!plan) throw new NotFoundException('PLAN_NOT_FOUND');
    return {
      title: plan.title,
      customer: plan.customer,
      area: plan.area,
      store: plan.store,
      style: plan.style,
      edition: plan.edition,
      versionNo: plan.versionNo,
      updatedAt: plan.updatedAt,
      pages: plan.pages,
      floorplanAssetId: plan.floorplanAssetId,
      layoutPoints: plan.layoutPoints,
    };
  }
}
