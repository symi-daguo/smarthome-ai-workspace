import {
  ConflictException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { withRetry } from '../common/retry.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.module.js';
import { TokenService } from '../billing/token.service.js';
import { LlmService } from '../llm/llm.service.js';
import { ModelConfigService } from '../llm/model-config.service.js';
import { generateViaComfyui, generateViaMinimax, generateViaOpenai } from '../media/image-provider.js';
import type { CreatePlanDto } from './plans.schemas.js';
import { buildQuoteSummary, quotePointsOf, type QuoteSummary } from './plan-quote.js';

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
  // 「补充需求与服务资料」9 项
  priorityNeeds: string;
  excludedItems: string;
  renovationStage: string;
  existingDevices: string;
  serviceEvidence: string;
  serviceScope: string;
  serviceContact: string;
  budgetItems: string;
  budgetSource: string;
  style: string;
  edition: 'standard' | 'presale' | 'private';
  floorplanTemplate: 'annotated' | 'compare' | 'render';
  markerTemplate: 'numbered' | 'icon' | 'dot';
  pageCount: number;
  floorplanAssetId?: string | null;
  /** createPlanSchema 给了默认值 []，这里声明为必填数组，服务层不必再判空 */
  extraFloorplanAssetIds: string[];
  floorplanFloors: string[];
  renderAssetIds: string[];
  renderAssetMeta: { clientId: string; room: string; roomConfirmed: boolean; useMode: 'generate' | 'provided'; sceneName: string; representative: boolean; fileName: string }[];
  /** 设备点位：x/y 为 0~1 归一化坐标（缩略图与原图通用） */
  layoutPoints?: { productId: string; name: string; category: string; x: number; y: number }[] | null;
  /** 提交幂等键：命中已有方案直接返回，避免重复调 LLM + 重复扣费 */
  clientRequestId?: string;
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

/** 效果图上限 */
const RENDER_MAX = 5;

/**
 * 效果图提交前校验。
 *
 * 为什么放在服务端而不是只在前端拦：前端校验能被绕过（改个 body 就行），
 * 而分组信息直接决定「哪张是方案主视觉」——漏了空间名，出图阶段才知道，
 * 那时 LLM 已经跑完、额度已经扣了。
 */
function assertRenderAssetsReady(
  ids: string[],
  meta: { room: string; roomConfirmed: boolean; useMode: string; sceneName: string; representative: boolean }[],
): void {
  if (!ids.length) return;
  if (ids.length > RENDER_MAX) throw new BadRequestException(`本方案已选择 ${RENDER_MAX} 张渲染图，请先移除一张`);
  const bad = meta.findIndex((m) => !m.room?.trim() || !m.roomConfirmed);
  if (bad >= 0) {
    throw new BadRequestException('请为每张渲染图指定它对应的空间并确认，同名即视为同一空间；跨楼层请注明属于几层。');
  }
  const noScene = meta.findIndex((m) => m.useMode === 'provided' && !m.sceneName?.trim());
  if (noScene >= 0) throw new BadRequestException('选择「按当前状态原样呈现」时，请填写该图对应的场景名称。');
  // 代表图互斥兜底：同一空间**被勾为代表图的**只能一张。
  // 只看房间是否重复是错的：同空间本来就允许放多张图，只是不允许都当主视觉。
  const repSeen = new Set<string>();
  meta.forEach((m) => {
    if (!m.representative) return;
    const room = m.room.trim();
    if (repSeen.has(room)) throw new BadRequestException(`空间「${room}」只能有一张代表图`);
    repSeen.add(room);
  });
}

/** 户型图上限 */
const FLOORPLAN_MAX_FILES = 3;
/** 单文件与总体积上限：户型图不压缩，超限直接拒而不是偷偷降质 */
const FLOORPLAN_FILE_MAX = 20 * 1024 * 1024;
const FLOORPLAN_TOTAL_MAX = 35 * 1024 * 1024;

/** 体积校验：返回可读报错，通过则返回 null */
export function checkFloorplanSizes(sizes: number[]): string | null {
  const over = sizes.findIndex((b) => b > FLOORPLAN_FILE_MAX);
  if (over >= 0) return `户型图第 ${over + 1} 张超过 20MB，请先压小体积再上传`;
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total > FLOORPLAN_TOTAL_MAX) return '户型图总大小不能超过 35MB，请减掉几个文件或压小后重传';
  return null;
}

/** 额外户型图：去重 + 剔除主图 + 卡上限 */
function dedupeFloorplanExtras(mainId: string | null | undefined, extra?: string[] | null): string[] {
  const ids = [...new Set(extra ?? [])].filter((x) => x && x !== mainId);
  return ids.slice(0, Math.max(0, FLOORPLAN_MAX_FILES - 1));
}

/** 楼层名与图片数对齐：缺失补空串，避免「二层」贴到「一层」的图上 */
function alignFloorplanFloors(mainId: string | null | undefined, extra: string[] | null | undefined, floors?: string[] | null): string[] {
  const total = (mainId ? 1 : 0) + dedupeFloorplanExtras(mainId, extra).length;
  const list = [...(floors ?? [])].slice(0, total);
  while (list.length < total) list.push('');
  return list;
}

/** 「补充需求与服务资料」9 项 → 提示词行。只输出填写过的，空项不占篇幅 */
function salesBriefLines(input: CreatePlanDto): string[] {
  const rows: [string, string][] = [
    ['最看重的需求（按重要度排序）', input.priorityNeeds],
    ['明确不做的项目', input.excludedItems],
    ['装修阶段', input.renovationStage],
    ['现有设备与生态', input.existingDevices],
    ['过往案例或交付凭证', input.serviceEvidence],
    ['已确认服务范围', input.serviceScope],
    ['对接人与联系方式', input.serviceContact],
    ['已确认参考费用', input.budgetItems],
    ['费用来源与日期', input.budgetSource],
  ];
  const filled = rows.filter(([, v]) => v && v.trim());
  if (!filled.length) return [];
  const lines = filled.map(([label, v]) => `- ${label}：${v.trim()}`);
  const excluded = input.excludedItems.trim();
  return [
    '',
    '门店补充的事实（写方案时必须遵守，不要改写成推测，也不要臆造未提供的细节）：',
    ...lines,
    // 「明确不做的项目」是**约束**不是事实，混在事实堆里模型会当成背景信息带过。
    // 实测：不单独强调时，模型照样会在正文里提到客户明确排除的设备。
    ...(excluded
      ? ['', `硬性排除：方案正文、要点清单与讲解稿中都不得出现或推荐以下项目（客户已明确不做）：${excluded}`]
      : []),
    ...(input.budgetItems.trim() && !input.budgetSource.trim()
      ? ['注意：门店填了参考费用但没填来源与日期，请在方案里标明费用为参考、未最终确认。']
      : []),
  ];
}

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly llm: LlmService,
    private readonly modelConfig: ModelConfigService,
    private readonly config: ConfigService,
  ) {}

  private uploadDir(): string {
    return this.config.get<string>('UPLOAD_DIR', 'uploads');
  }

  private dayDir(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  /** LLM 生成多页方案（9 页标准骨架，pageCount 超出部分追加空间场景页） */
  async create(input: PlanInput) {
    // 幂等查询放在**最前面**：方案要先调 LLM 出页、再按页数扣费，
    // 是全项目最贵的一次提交，重放的代价远高于生图/生视频。
    if (input.clientRequestId) {
      const existing = await this.prisma.planProject.findFirst({
        where: { tenantId: input.tenantId, clientRequestId: input.clientRequestId },
      });
      if (existing) return { ...existing, deduped: true };
    }
    // 效果图校验放在**调 LLM 之前**：分组没填就重跑一次生成，代价是白扣一次额度。
    assertRenderAssetsReady(input.renderAssetIds, input.renderAssetMeta);
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
        extraFloorplanAssetIds: dedupeFloorplanExtras(input.floorplanAssetId, input.extraFloorplanAssetIds),
        floorplanFloors: alignFloorplanFloors(input.floorplanAssetId, input.extraFloorplanAssetIds, input.floorplanFloors),
        renderAssetIds: input.renderAssetIds,
        renderAssetMeta: input.renderAssetMeta as never,
        priorityNeeds: input.priorityNeeds,
        excludedItems: input.excludedItems,
        renovationStage: input.renovationStage,
        existingDevices: input.existingDevices,
        serviceEvidence: input.serviceEvidence,
        serviceScope: input.serviceScope,
        serviceContact: input.serviceContact,
        budgetItems: input.budgetItems,
        budgetSource: input.budgetSource,
        style: input.style,
        edition: input.edition,
        floorplanTemplate: input.floorplanTemplate,
        markerTemplate: input.markerTemplate,
        pageCount: pages.length,
        pages: pages as unknown as never,
        versionNo: 1,
        floorplanAssetId: input.floorplanAssetId ?? null,
        layoutPoints: (input.layoutPoints ?? null) as never,
        clientRequestId: input.clientRequestId ?? null,
      },
    });
  }

  /**
   * 绑定场景视频（分享页内联播放）。最多 2 条，逐条校验归属与类型 ——
   * 分享页是免鉴权端点，写错 id 会把别人的视频挂到公开页上。
   */
  async bindVideos(tenantId: string, userId: string, id: string, videoAssetIds: string[]): Promise<{ videoAssetIds: string[] }> {
    await this.detail(tenantId, id);
    const ids = [...new Set(videoAssetIds)].slice(0, 2);
    for (const vid of ids) {
      const asset = await this.prisma.mediaAsset.findFirst({ where: { id: vid, tenantId } });
      if (!asset) throw new BadRequestException('VIDEO_ASSET_NOT_FOUND');
      if (asset.kind !== 'video') throw new BadRequestException('VIDEO_ASSET_KIND_INVALID');
      if (asset.status !== 'ready') throw new BadRequestException('VIDEO_ASSET_NOT_READY');
    }
    const titles = await Promise.all(
      ids.map((vid) => this.prisma.mediaAsset.findUnique({ where: { id: vid }, select: { title: true } })),
    );
    await this.prisma.planProject.update({
      where: { id },
      data: { videoAssetIds: ids, videoTitles: titles.map((t) => t?.title ?? '') },
    });
    return { videoAssetIds: ids };
  }

  /** 挂接户型图与设备点位（点位编辑器产物 → 空间动线页配图） */
  async attachFloorplan(
    tenantId: string,
    id: string,
    dto: { floorplanAssetId: string; extraFloorplanAssetIds?: string[] | null; floorplanFloors?: string[] | null; layoutPoints?: unknown[] | null },
  ) {
    await this.detail(tenantId, id);
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: dto.floorplanAssetId, tenantId } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    // 额外户型图逐个校验归属；混入他人租户的资源要在这里挡住，不能只看主图
    const extraIds = [...new Set(dto.extraFloorplanAssetIds ?? [])].filter((x) => x && x !== dto.floorplanAssetId);
    if (extraIds.length) {
      const owned = await this.prisma.mediaAsset.count({ where: { id: { in: extraIds }, tenantId } });
      if (owned !== extraIds.length) throw new NotFoundException('ASSET_NOT_FOUND');
    }
    // 楼层名与图片一一对应；缺失补空串，避免数组错位导致「二层」贴到「一层」的图上
    const total = 1 + extraIds.length;
    if (total > FLOORPLAN_MAX_FILES) {
      throw new BadRequestException(`户型图最多 ${FLOORPLAN_MAX_FILES} 张，多余的那几张没有加进来`);
    }
    const floors = [...(dto.floorplanFloors ?? [])];
    while (floors.length < total) floors.push('');
    return this.prisma.planProject.update({
      where: { id },
      data: {
        floorplanAssetId: dto.floorplanAssetId,
        extraFloorplanAssetIds: extraIds,
        floorplanFloors: floors.slice(0, total),
        layoutPoints: (dto.layoutPoints ?? null) as never,
      },
    });
  }

  /**
   * AI 渲染精装修效果图：基于已挂接的客户户型平面图，按方案风格+生态生成智能家居精装版位图，
   * 落盘到 MediaAsset 并自动写回 PlanProject.renderedFloorplanAssetId。
   * ponytail: 复用 MediaService 的生图 provider（minimax/openai/comfyui）+ upload 落盘逻辑，
   * 不另开新轮子（避免重复维护 provider 适配）。代价：因服务依赖单向注入限制，
   * 这里直接拉取 cfg 与落盘 helper；如未来 MediaService 拆为更细粒度模块可接入。
   */
  async renderFloorplan(tenantId: string, userId: string, id: string): Promise<{ assetId: string; floorplanAssetId: string | null }> {
    const plan = await this.detail(tenantId, id);
    if (!plan.floorplanAssetId) throw new BadRequestException('PLAN_FLOORPLAN_REQUIRED');
    const original = await this.prisma.mediaAsset.findFirst({ where: { id: plan.floorplanAssetId, tenantId } });
    if (!original) throw new NotFoundException('FLOORPLAN_ASSET_NOT_FOUND');

    // 在扣费前校验：image-01 key 缺失直接拒绝，不白扣额度
    const cfg = await this.modelConfig.imageConfig();
    const apiKey = cfg.apiKey ?? '';
    if (cfg.provider !== 'comfyui' && !apiKey) {
      throw new ServiceUnavailableException({
        code: 'IMAGE_KEY_MISSING',
        message: cfg.provider === 'openai' ? '生图 API Key 未配置（provider=openai），请在「模型配置」页填写' : '生图 API Key 未配置，请在「模型配置」页填写 MiniMax Key',
      });
    }

    // 费用按精装修 = 1 倍生图（300 token），与单张效果图持平。
    //
    // 这里只**预检余额**，实际扣费移到生成成功之后。此前是「先扣后生成」：
    // 渲染一次要 20~30 秒、链路长失败率高，生成失败用户就白扣了额度。
    const RENDER_COST = 300;
    const bal = await this.tokens.balance(tenantId);
    if (bal.tokenBalance < RENDER_COST) throw new ForbiddenException('TOKEN_INSUFFICIENT');

    const styleName = STYLE_NAMES[plan.style] ?? plan.style;
    const ecosystem = plan.ecosystem || '主流智能家居';
    const prompt = [
      `${styleName}风格的高端精装修顶视平面图（top-down floorplan render）`,
      `融合${ecosystem}智能家居生态，户型参考原图的空间布局（房间分隔/门窗位置必须保持一致），`,
      `所有窗户加智能窗帘、卧室床头加床头灯与起夜灯带、客厅加灯带与天花筒灯、玄关加感应灯、`,
      `标注主要智能设备图标（网关/音箱/摄像头/传感器/智能开关），`,
      `4K 渲染、暖色灯光氛围、写实质感、真实样板房摄影视角。`,
    ].join('');

    // 生成走这里，失败会重试：只重试「再试一次有可能成功」的错误
    // （超时 / 连接重置 / 5xx / 429）；参数错与 key 无效（4xx）立刻抛出，
    // 重试多少次都一样，只会白让用户等。渲染类长耗时任务
    // 用「重试上限 6 次」是同一量级的思路。
    let img: { buffer: Buffer; mimeType: string; ext: string };
    img = await withRetry(async () => {
      if (cfg.provider === 'comfyui') {
        return generateViaComfyui({
          baseUrl: cfg.comfyBaseUrl,
          apiKey: cfg.comfyApiKey,
          workflow: await this.loadComfyWorkflow(cfg.workflowPath),
          prompt,
          width: 1536,
          height: 1024,
          promptNode: cfg.promptNode,
          negativeNode: cfg.negativeNode,
          latentNode: cfg.latentNode,
          seedNode: cfg.seedNode,
        });
      } else if (cfg.provider === 'openai') {
        return generateViaOpenai({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model || 'gpt-image-1',
          prompt,
          size: '1536x1024',
        });
      } else {
        return generateViaMinimax({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model || 'image-01',
          prompt,
          aspect: '16:9',
        });
      }
    }, { attempts: 3, baseDelayMs: 1500, timeoutMs: 180_000 });
    if (!img.buffer.length) throw new ServiceUnavailableException('ASSET_EMPTY');

    const rel = `uploads/${this.dayDir()}/${randomUUID()}.${img.ext}`;
    const abs = join(this.uploadDir(), rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, img.buffer);
    // 走到这里说明图真的出来了，现在才扣费
    await this.tokens.consume(
      tenantId,
      RENDER_COST,
      'CONSUME',
      { kind: 'plan-render-floorplan', planId: id },
      userId,
    );

    const asset = await this.prisma.mediaAsset.create({
      data: {
        tenantId,
        userId,
        kind: 'image',
        title: `${plan.title} · 精装修效果图`,
        prompt,
        filePath: rel,
        mimeType: img.mimeType,
        sizeBytes: img.buffer.length,
        status: 'ready',
      },
    });
    await this.prisma.planProject.update({
      where: { id },
      data: { renderedFloorplanAssetId: asset.id },
    });
    return { assetId: asset.id, floorplanAssetId: plan.floorplanAssetId };
  }

  /** 与 MediaService 同样读取 comfyui 工作流：失败抛 COMFYUI_WORKFLOW_MISSING */
  private async loadComfyWorkflow(path: string): Promise<Record<string, unknown>> {
    const fs = await import('node:fs/promises');
    const tryPaths = [path, join(this.uploadDir(), '..', 'comfyui-workflow.json')];
    for (const p of tryPaths) {
      try {
        const raw = await fs.readFile(p, 'utf8');
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // 继续尝试下一个候选
      }
    }
    throw new ServiceUnavailableException({
      code: 'COMFYUI_WORKFLOW_MISSING',
      message: `未找到 ComfyUI 工作流文件（COMFYUI_WORKFLOW_PATH=${path}）。内置模板位于 apps/api/comfyui-workflow.json，或在 ComfyUI 中「Workflow → Export(API)」导出后放到该路径`,
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
      // 补充资料：只在门店真填了才进提示词。九项全空时输出的是噪音，
      // 还会挤占预算区���真正有客户诉求的输入。
      ...salesBriefLines(input),
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

    // 模型偶尔会把 JSON 说到一半就停（输出长度撞上限或中途断流），
    // 直接抛错等于让门店反复手动重试。实测同一份提示重试一次即可通过，
    // 所以这里做一次重试再判定失败。
    // 显式给 null：strict 模式不允许「声明后未赋值就读取」
    let pages: PlanPage[] | null = null;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const raw = await this.llm.chatJson<unknown>({
          systemPrompt: '你是资深全屋智能方案设计师，为智能家居服务商撰写交付客户的方案文案。',
          prompt,
          maxTokens: 12000,
          rag: { tenantId: input.tenantId, userId: input.userId, scene: 'plan', query: `${input.title} ${input.customer} ${input.needs} ${input.keySpaces}` },
        });
        pages = this.sanitizePages(raw, skeleton);
        lastError = null;
        break;
      } catch (e) {
        lastError = e as Error;
        // 超时不再重试：一次就要等满上限，重试等于让门店白等两倍时间，
        // 而同一个慢响应第二次几乎还是慢。快速失败（格式异常等）才值得再试一次。
        const code = (e as { getResponse?: () => { code?: string } }).getResponse?.()?.code;
        if (typeof code === 'string' && code.endsWith('_TIMEOUT')) {
          this.logger.warn(`方案生成超时（不再重试）: ${lastError.message}`);
          break;
        }
        this.logger.warn(`方案生成失败（第 ${attempt} 次尝试）: ${lastError.message}`);
      }
    }
    if (!pages) {
      // 失败原因要如实反映：网络不通、超时、返回格式异常是三件不同的事。
      // 统一报「格式异常，请调整描述」会把人引到错误的操作上 ——
      // 网络不通时该做的是检查网络，重试或改描述都没用。
      const resp = (lastError as { getResponse?: () => unknown } | null)?.getResponse?.() as
        | { code?: string; message?: string }
        | undefined;
      if (resp?.code) {
        throw new ServiceUnavailableException({ code: resp.code, message: resp.message ?? '方案生成失败，请重试' });
      }
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
        floorplanTemplate: true, markerTemplate: true,
        pageCount: true, versionNo: true, shareToken: true, updatedAt: true,
      },
    });
  }

  async detail(tenantId: string, id: string) {
    const plan = await this.prisma.planProject.findFirst({ where: { id, tenantId } });
    if (!plan) throw new NotFoundException('PLAN_NOT_FOUND');
    // reviewedRevision 与 versionNo 相等 = 当前这版已逐页校对过。
    // 附一份给前端直接用的判定结果，省得每个调用点各写一遍比较逻辑。
    return {
      ...plan,
      reviewed: plan.reviewedRevision !== null && plan.reviewedRevision === plan.versionNo,
      quoteSummary: await this.quoteSummaryOf(tenantId, plan.layoutPoints),
    };
  }

  /**
   * 设备清单与报价：由「真实点位 + 产品库参考零售价」算出。
   *
   * 为什么在这算而不是各端各算：PPTX、讲稿、分享页三处都要这份清单，
   * 放前端会出现「分享页有价格、PPT 没价格」这类静默错位。
   * 点位为空就没有清单（不返回空表页）。
   *
   * 安装调试费率取当前租户的设置（默认 20%），
   * 门店的施工与调试成本不同，费率由门店自己定。
   */
  private async quoteSummaryOf(tenantId: string, layoutPoints: unknown): Promise<QuoteSummary | null> {
    const points = quotePointsOf(layoutPoints);
    if (!points.length) return null;
    const ids = [...new Set(points.map((p) => p.productId).filter((v): v is string => Boolean(v)))];
    const [products, tenant] = await Promise.all([
      ids.length
        ? this.prisma.product.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, category: true, priceRetail: true },
          })
        : Promise.resolve([]),
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { installRate: true } }),
    ]);
    return buildQuoteSummary(points, products, tenant?.installRate ?? 20);
  }

  /**
   * 逐页校对确认：把 reviewedRevision 盖到当前版本号上。
   *
   * 之后任何一次保存文案（versionNo +1）都会让两者不等，确认自动失效——
   * 不需要在前端手动取消勾选，也不会出现「勾完之后又改了内容、确认却还生效」。
   */
  async review(tenantId: string, id: string) {
    const plan = await this.prisma.planProject.findFirst({ where: { id, tenantId } });
    if (!plan) throw new NotFoundException('PLAN_NOT_FOUND');
    const updated = await this.prisma.planProject.update({
      where: { id },
      data: { reviewedRevision: plan.versionNo },
    });
    return { ...updated, reviewed: true, versionNo: plan.versionNo };
  }

  /** 逐页审稿编辑：更新单页并版本 +1 */
  async updatePage(
    tenantId: string,
    id: string,
    dto: {
      index: number;
      /** 乐观锁：客户端打开方案时看到的版本号。不一致说明期间有人改过 */
      versionNo?: number;
      heading?: string;
      subtitle?: string;
      body?: string;
      narration?: string;
      bullets?: string[];
      quote?: string;
    },
  ) {
    const plan = await this.detail(tenantId, id);
    const pages = plan.pages as unknown as PlanPage[];
    if (!Array.isArray(pages) || dto.index < 0 || dto.index >= pages.length) {
      throw new BadRequestException('PAGE_INDEX_OUT_OF_RANGE');
    }
    /**
     * 乐观锁：pages 是**整份 JSON 覆盖**，不比对版本的话，
     * A 改第 3 页保存后，B 基于旧版改第 5 页再保存，会把 A 的修改整份抹掉，
     * 而 versionNo 照常递增、界面一切正常 —— 静默丢数据，最难查的一种。
     *
     * 常见做法是存双份草稿快照让用户手动合并（409 冲突时把冲突副本落到
     * localStorage 的 `draft_conflict:{proj}:{ts}` 键）。
     * 这里不加草稿快照：409 里带回**服务端当前版本**，前端提示用户重新载入再改，
     * 至少保证「丢得明明白白」而不是「不知不觉没了」。
     */
    if (dto.versionNo !== undefined && dto.versionNo !== plan.versionNo) {
      throw new ConflictException({
        code: 'PLAN_VERSION_CONFLICT',
        message: `方案已被他人更新到 V${plan.versionNo}（你基于 V${dto.versionNo} 编辑），本次修改未保存`,
        currentVersionNo: plan.versionNo,
      });
    }
    pages[dto.index] = {
      ...pages[dto.index],
      ...(dto.heading !== undefined ? { heading: dto.heading.slice(0, 200) } : {}),
      ...(dto.subtitle !== undefined ? { subtitle: dto.subtitle.slice(0, 200) } : {}),
      ...(dto.body !== undefined ? { body: dto.body.slice(0, 8000) } : {}),
      ...(dto.narration !== undefined ? { narration: dto.narration.slice(0, 8000) } : {}),
      // 空行直接丢掉：TextArea 里多敲一个回车不该存成一条空要点
      ...(dto.bullets !== undefined ? { bullets: dto.bullets.map((b) => b.trim().slice(0, 300)).filter(Boolean) } : {}),
      ...(dto.quote !== undefined ? { quote: dto.quote.slice(0, 300) } : {}),
    };
    return this.prisma.planProject.update({
      where: { id },
      data: { pages: pages as unknown as never, versionNo: { increment: 1 } },
    });
  }

  /**
   * 改交付模版（户型图设计 / 产品放置）。
   *
   * 为什么单独一个端点而不是塞进 updatePage：模版不改正案页文字，
   * 但**会改变客户看到的东西**（户型页版式、点位标注样式、清单是否分页）。
   * 所以它必须像改页一样 bump versionNo 并让 reviewedRevision 失效 ——
   * 否则打完包改了模版，旧的交付链接还能下，客户端拿到的是旧模版，
   * 而门店以为已经更新了。
   *
   * 乐观锁与 updatePage 同理：期间有人改过案就直接 409，不做静默覆盖。
   */
  async updateTemplates(
    tenantId: string,
    id: string,
    dto: {
      floorplanTemplate?: 'annotated' | 'compare' | 'render';
      markerTemplate?: 'numbered' | 'icon' | 'dot';
      versionNo?: number;
    },
  ) {
    const plan = await this.detail(tenantId, id);
    if (dto.versionNo !== undefined && dto.versionNo !== plan.versionNo) {
      throw new ConflictException({
        code: 'PLAN_VERSION_CONFLICT',
        message: `方案已被他人更新到 V${plan.versionNo}（你基于 V${dto.versionNo} 操作），本次修改未保存`,
        currentVersionNo: plan.versionNo,
      });
    }
    const changed =
      (dto.floorplanTemplate !== undefined && dto.floorplanTemplate !== plan.floorplanTemplate) ||
      (dto.markerTemplate !== undefined && dto.markerTemplate !== plan.markerTemplate);
    if (!changed) return { ...plan, versionNo: plan.versionNo };
    return this.prisma.planProject.update({
      where: { id },
      data: {
        ...(dto.floorplanTemplate !== undefined ? { floorplanTemplate: dto.floorplanTemplate } : {}),
        ...(dto.markerTemplate !== undefined ? { markerTemplate: dto.markerTemplate } : {}),
        versionNo: { increment: 1 },
        // 改模版等于改交付内容，校对结论必须重新确认
        reviewedRevision: null,
      },
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
      floorplanTemplate: plan.floorplanTemplate,
      markerTemplate: plan.markerTemplate,
      versionNo: plan.versionNo,
      updatedAt: plan.updatedAt,
      pages: plan.pages,
      floorplanAssetId: plan.floorplanAssetId,
      renderedFloorplanAssetId: plan.renderedFloorplanAssetId,
      layoutPoints: plan.layoutPoints,
      // 设备清单与报价：分享页是免鉴权公开页，客户端拿不到产品库价格，
      // 所以在这里算好随方案一起下发，PPTX 与分享页看到的是同一份清单。
      quoteSummary: await this.quoteSummaryOf(plan.tenantId, plan.layoutPoints),
      // 分享页据此内联播放；显式挑字段而非整行返回，避免把 clientRequestId、
      // reviewedRevision 之类内部字段暴露到免鉴权端点上。
      videoAssetIds: plan.videoAssetIds,
      videoTitles: plan.videoTitles,
    };
  }
}
