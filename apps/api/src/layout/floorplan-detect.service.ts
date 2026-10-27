import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { PrismaService } from '../prisma/prisma.module.js';
import { LlmService } from '../llm/llm.service.js';
import { MediaService } from '../media/media.service.js';
import { TokenService } from '../billing/token.service.js';
import { quoteUnitPrice } from '../plans/plan-quote.js';
import { assignByRoom, normalizeRooms, placeByRoom, type DetectCandidate, type DetectedPoint, type DetectedRoom } from './floorplan-points.js';

/**
 * 户型图「AI 识别并布点」：读图 → 房间矩形 → 设备落位。
 *
 * ## 为什么是「模型只认房间，点位本地算」
 *
 * 试过两条路：
 *
 * 1. **让模型直接给 24 个设备坐标**：token 多一个量级，而且相邻房间
 *    （主卫/客卫、四个阳台）必然串位 —— 客户一眼就能看出「开关画到隔壁房间了」。
 * 2. **让模型既认房间又选设备**：房间准，但模型要为「哪个房间配哪台设备」推理很久，
 *    实测耗时在 180 秒到 240 秒之间波动，**还会超时**。交付一个时快时慢、
 *    偶尔失败的功能给门店用，不可接受。
 *
 * 所以最终拆成两级，各取所长：
 * - **房间矩形**交给模型：看图是它的强项，实测 140㎡ 户型 13 个房间
 *   边界误差小于 1%，且只要 40 秒上下；
 * - **装什么设备、装在哪**由本地规则算（`floorplan-points.ts` 的标准配置表
 *   + 品类典型位置），**确定性**：同样的户型永远得到同一套点位与坐标。
 *
 * 人工微调仍由编辑器承担（拖拽即可）—— AI 出的是建议稿，不是终稿。
 */

/** 扣费：一次读图出整套点位，与「生成一页方案文案」同量级 */
const DETECT_TOKENS = Number(process.env.BILLING_FLOORPLAN_DETECT_TOKENS ?? 100);

export interface FloorplanDetectResult {
  rooms: DetectedRoom[];
  points: DetectedPoint[];
}

@Injectable()
export class FloorplanDetectService {
  private readonly logger = new Logger(FloorplanDetectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly media: MediaService,
    private readonly tokens: TokenService,
  ) {}

  async detect(tenantId: string, userId: string, floorplanAssetId: string): Promise<FloorplanDetectResult> {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: floorplanAssetId, tenantId } });
    if (!asset) throw new NotFoundException('FLOORPLAN_ASSET_NOT_FOUND');
    if (asset.kind !== 'image') throw new BadRequestException('FLOORPLAN_ASSET_NOT_IMAGE');
    if (asset.status !== 'ready') throw new BadRequestException('FLOORPLAN_ASSET_NOT_READY');

    const candidates = await this.candidates(tenantId);
    if (!candidates.length) throw new BadRequestException('PRODUCT_CATALOG_EMPTY');

    // 读图转 dataURL：图片走多模态，模型能「看」
    const buf = await readFile(this.media.resolveSafe(asset.filePath));
    if (!buf.length) throw new BadRequestException('FLOORPLAN_ASSET_EMPTY');
    const dataUrl = `data:${asset.mimeType || 'image/png'};base64,${buf.toString('base64')}`;

    const raw = await this.llm.chatJson<unknown>({
      systemPrompt: '你是全屋智能方案设计师，看客户户型图后做房间识别。',
      prompt: this.prompt(),
      // 视觉推理本身就慢，超时给足 240s（不挂知识库 —— 这是「看图」任务，检索无益）
      timeoutMs: 240_000,
      // 图片必须挂上：只给文字的话模型会明确回「未收到户型图图片」
      attachments: [{ name: asset.filePath, dataUrl }],
    });

    const rooms = normalizeRooms(raw);
    if (!rooms.length) {
      // 把模型原文记进日志：识别失败时只有原文能说明是「没认出来」还是「格式没对上」
      this.logger.warn(`户型图房间识别为空，模型原文：${JSON.stringify(raw).slice(0, 800)}`);
      throw new ServiceUnavailableException({
        code: 'FLOORPLAN_ROOMS_NOT_FOUND',
        message: '没能从户型图里识别出房间，请确认图纸清晰（深线白底、房间名可见）后重试',
      });
    }
    // 装什么设备、装在哪：本地标准配置表（确定性），不交给模型
    const points = placeByRoom(rooms, assignByRoom(rooms, candidates), candidates);
    if (!points.length) {
      throw new ServiceUnavailableException({
        code: 'FLOORPLAN_POINTS_EMPTY',
        message: '识别到房间但产品库里没有可布点的设备，请先导入产品库',
      });
    }

    await this.tokens.consume(
      tenantId,
      DETECT_TOKENS,
      'CONSUME',
      { kind: 'floorplan-detect', assetId: floorplanAssetId, roomCount: rooms.length, pointCount: points.length },
      userId,
    );
    this.logger.log(`户型图识别完成：${rooms.length} 个房间 / ${points.length} 个点位`);
    return { rooms, points };
  }

  /**
   * 候选产品清单：公共库 + 本租户库。
   *
   * **不再截断**：这份清单不再进提示词（模型只认房间，不选设备），
   * 选型在本地做，所以整库都能用 —— 截断反而会让「亖米一键开关」这类
   * 具体型号挑不到。唯一过滤是**没有价格的条目**：报价页取的是参考零售价，
   * 挑中 0 价产品会让客户看到一排 ¥0。
   */
  private async candidates(tenantId: string): Promise<DetectCandidate[]> {
    const rows = await this.prisma.product.findMany({
      where: { active: true, OR: [{ tenantId: null }, { tenantId }] },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, category: true, perRoom: true, tenantId: true, priceRetail: true, priceMax: true },
    });
    const out: DetectCandidate[] = [];
    for (const r of rows) {
      // 单价口径与报价单、前端一致（priceRetail 为 0 时回退 priceMax），别再各写一遍 ||
      const price = quoteUnitPrice(r);
      if (!price) continue;
      out.push({
        id: r.id,
        name: r.name,
        category: r.category,
        perRoom: r.perRoom || '',
        own: r.tenantId === tenantId,
        price,
      });
    }
    return out;
  }

  /**
   * 提示词：只做房间识别。
   *
   * 刻意**不**把产品清单塞进来：多一段清单模型就要多推理一轮，
   * 实测耗时从 40 秒涨到 3 分钟还不稳定，而选型本地做更准更快。
   */
  private prompt(): string {
    return [
      '这是一张住宅户型平面图。请识别图中的每一个房间，并给出它在图上的矩形范围。',
      '',
      '坐标定义：x 从左到右 0→1，y 从上到下 0→1，原点为图片左上角。',
      'box 形如 [x1, y1, x2, y2]，只取房间内部区域（不含房间外空白与图框）。',
      '',
      '要求：',
      '- 房间名用中文（客厅/餐厅/厨房/卫生间/阳台/书房/主卧/次卧/玄关等），',
      '  带方位或功能后缀也照写（如「入户玄关」「生活阳台」「主卫」），后续要按名字配设备；',
      '- 必须覆盖图中的全部房间，不遗漏也不编造图上没有的房间；',
      '- 不要输出任何说明文字。',
      '',
      '只输出一个 JSON 数组，不要 markdown 代码块：',
      '[{"name":"客厅","box":[0.02,0.02,0.31,0.36]},{"name":"主卧","box":[0.01,0.39,0.27,0.73]}]',
    ].join('\n');
  }
}
