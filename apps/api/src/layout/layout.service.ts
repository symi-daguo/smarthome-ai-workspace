import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { LlmService } from '../llm/llm.service.js';
import { MediaService } from '../media/media.service.js';
import { TokenService } from '../billing/token.service.js';
import { CATEGORY_META } from './category-meta.js';
import type { CreateProductDto, UpdateProductDto } from './layout.schemas.js';

/** 产品目录（公共库+我的库）+ 点位布局图纸 CRUD */
@Injectable()
export class LayoutService {
  private readonly logger = new Logger(LayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly media: MediaService,
    private readonly tokens: TokenService,
    private readonly idem: IdempotencyService,
  ) {}

  /** 布点/报价选品数据源：公共库 + 本租户我的库 */
  products(tenantId?: string) {
    return this.prisma.product.findMany({
      where: { active: true, OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])] },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  /** 品类字典：预置 24 类 + 本租户自定义（前端分类筛选/表单选项数据源） */
  categories(tenantId?: string) {
    return this.prisma.categoryDef.findMany({
      where: { active: true, OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])] },
      orderBy: [{ sortOrder: 'asc' }],
    });
  }

  /** 租户自定义分类（label 自动生成 key，同名幂等返回） */
  async createCategory(tenantId: string, dto: { label: string; icon: string; color: string }) {
    const label = dto.label.trim();
    if (!label) throw new BadRequestException('CATEGORY_LABEL_REQUIRED');
    const key = `c-${Buffer.from(label, 'utf8').toString('base64url').slice(0, 24)}`;
    const existing = await this.prisma.categoryDef.findFirst({ where: { tenantId, label } });
    if (existing) return existing;
    const max = await this.prisma.categoryDef.findFirst({ where: { tenantId }, orderBy: { sortOrder: 'desc' } });
    return this.prisma.categoryDef.create({
      data: { tenantId, key, label, icon: dto.icon, color: dto.color, sortOrder: (max?.sortOrder ?? 100) + 1 },
    });
  }

  /** 删除自定义分类（预置类不可删；仍有产品在用时拒绝） */
  async removeCategory(tenantId: string, id: string): Promise<void> {
    const row = await this.prisma.categoryDef.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('CATEGORY_NOT_FOUND');
    const inUse = await this.prisma.product.findFirst({ where: { tenantId, category: row.key, active: true } });
    if (inUse) throw new BadRequestException({ code: 'CATEGORY_IN_USE', message: `「${row.label}」下仍有产品，请先调整产品分类` });
    await this.prisma.categoryDef.delete({ where: { id } });
  }

  /** 校验品类 key 合法（预置 + 本租户自定义；security 兼容归并） */
  private async assertCategoryKey(tenantId: string, category: string): Promise<void> {
    const ok = await this.prisma.categoryDef.findFirst({
      where: { key: category, active: true, OR: [{ tenantId: null }, { tenantId }] },
    });
    if (!ok) throw new BadRequestException({ code: 'CATEGORY_INVALID', message: `未知品类「${category}」，请先创建自定义分类` });
  }

  /** 三级价格写回时同步旧参考价区间（min=工程价,max=指导价），兼容点位清单/旧报价 */
  private syncLegacyPriceRange(data: Record<string, unknown>, dto: Record<string, unknown>, cur?: { priceProject: number; priceRetail: number; priceMin: number; priceMax: number }): void {
    if (dto.priceRetail === undefined && dto.priceProject === undefined) return;
    const project = (dto.priceProject as number | undefined) ?? cur?.priceProject ?? 0;
    const retail = (dto.priceRetail as number | undefined) ?? cur?.priceRetail ?? 0;
    if (dto.priceMin === undefined) data.priceMin = project || cur?.priceMin || 0;
    if (dto.priceMax === undefined) data.priceMax = retail || cur?.priceMax || 0;
  }

  async createProduct(tenantId: string, dto: CreateProductDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('PRODUCT_NAME_REQUIRED');
    await this.assertCategoryKey(tenantId, dto.category);
    const dup = await this.prisma.product.findFirst({ where: { name, tenantId } });
    if (dup) throw new BadRequestException({ code: 'PRODUCT_DUPLICATE', message: `我的库已有「${name}」` });
    const data: Record<string, unknown> = {
      tenantId,
      name,
      category: dto.category,
      brand: dto.brand?.trim() ?? '',
      model: dto.model?.trim() ?? '',
      unit: dto.unit?.trim() || '台',
      priceMin: dto.priceMin ?? 0,
      priceMax: dto.priceMax ?? 0,
      perRoom: dto.perRoom ?? '',
      imageUrl: dto.imageUrl ?? '',
      // 产品级图标：空串=回退品类图标；同品类下不同产品用不同 key 区分
      iconKey: dto.iconKey ?? '',
      sku: dto.sku?.trim() ?? '',
      barcode: dto.barcode?.trim() ?? '',
      snRule: dto.snRule?.trim() ?? '',
      spec: dto.spec?.trim() ?? '',
      warranty: dto.warranty ?? 12,
      priceRetail: dto.priceRetail ?? 0,
      priceDealer: dto.priceDealer ?? 0,
      priceProject: dto.priceProject ?? 0,
      rebateL1: dto.rebateL1 ?? 0,
      rebateL2: dto.rebateL2 ?? 0,
      rebateDesigner: dto.rebateDesigner ?? 0,
      pricingMode: dto.pricingMode ?? 'per_unit',
    };
    this.syncLegacyPriceRange(data, dto as Record<string, unknown>);
    return this.prisma.product.create({ data: data as never });
  }

  async updateProduct(tenantId: string, id: string, dto: UpdateProductDto) {
    const row = await this.prisma.product.findFirst({ where: { id, tenantId } });
    if (row) {
      if (dto.category) await this.assertCategoryKey(tenantId, dto.category);
      const data: Record<string, unknown> = { ...dto };
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (dto.brand !== undefined) data.brand = dto.brand.trim();
      if (dto.model !== undefined) data.model = dto.model.trim();
      if (dto.sku !== undefined) data.sku = dto.sku.trim();
      if (dto.barcode !== undefined) data.barcode = dto.barcode.trim();
      if (dto.snRule !== undefined) data.snRule = dto.snRule.trim();
      if (dto.spec !== undefined) data.spec = dto.spec.trim();
      this.syncLegacyPriceRange(data, dto as Record<string, unknown>, row);
      return this.prisma.product.update({ where: { id }, data: data as never });
    }
    // 公共库行：仅允许更换产品图（每个部署者都是平台方，上传/AI 生成产品图完善公共种子）
    const pub = await this.prisma.product.findFirst({ where: { id, tenantId: null } });
    if (!pub) throw new NotFoundException('PRODUCT_NOT_FOUND');
    if (Object.keys(dto).some((k) => k !== 'imageUrl')) throw new BadRequestException('PUBLIC_PRODUCT_IMAGE_ONLY');
    return this.prisma.product.update({ where: { id }, data: { imageUrl: dto.imageUrl ?? '' } });
  }

  async removeProduct(tenantId: string, id: string): Promise<void> {
    const row = await this.prisma.product.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('PRODUCT_NOT_FOUND');
    await this.prisma.product.delete({ where: { id } });
  }

  /** 公共库产品复制到我的库 */
  async copyProductToMine(tenantId: string, id: string) {
    const src = await this.prisma.product.findFirst({ where: { id, tenantId: null } });
    if (!src) throw new NotFoundException('PUBLIC_PRODUCT_NOT_FOUND');
    const dup = await this.prisma.product.findFirst({ where: { name: src.name, tenantId } });
    if (dup) throw new BadRequestException({ code: 'PRODUCT_DUPLICATE', message: `我的库已有「${src.name}」` });
    return this.prisma.product.create({
      data: {
        tenantId, name: src.name, category: src.category, brand: src.brand, model: src.model, unit: src.unit,
        priceMin: src.priceMin, priceMax: src.priceMax, perRoom: src.perRoom,
        imageUrl: src.imageUrl, iconKey: src.iconKey,
        sku: src.sku, barcode: src.barcode, snRule: src.snRule, spec: src.spec, warranty: src.warranty,
        priceRetail: src.priceRetail, priceDealer: src.priceDealer, priceProject: src.priceProject,
        rebateL1: src.rebateL1, rebateL2: src.rebateL2, rebateDesigner: src.rebateDesigner,
        pricingMode: src.pricingMode,
      },
    });
  }

  /**
   * agent 批量处理产品：勾选的产品行（我的库 / 公共库均可）一次完成
   * ① LLM 补全缺失文案（品牌/型号/布置提示，仅我的库行写回）
   * ② 生图 provider 批量生成产品主图（产品图即点位图标），逐个扣生图额度
   * 单个失败不阻塞其余；生图 key 未配置时诚实降级为仅文案。全程写审计留痕。
   */
  async aiProcessProducts(tenantId: string, userId: string, ids: string[], clientRequestId?: string) {
    // 幂等：这一步会逐个调生图（每张都扣额度），用户重试不该把一整批图再生一遍。
    // 抢占必须在查产品之前，否则重复提交还会白跑一次 findMany。
    const claim = await this.idem.claim(tenantId, clientRequestId, 'product-enrich');
    if (!claim.fresh) {
      const prev = (claim.previous ?? {}) as { total: number; copyOk: number; imageOk: number; errors: unknown[] };
      return {
        total: prev.total ?? 0,
        copyOk: prev.copyOk ?? 0,
        imageOk: prev.imageOk ?? 0,
        errors: prev.errors ?? [],
        deduped: true,
      };
    }
    try {
      return await this.runAiProcess(tenantId, userId, ids, clientRequestId);
    } catch (e) {
      await this.idem.release(tenantId, clientRequestId);
      throw e;
    }
  }

  /** AI 批量处理的实际执行体（幂等抢占在 aiProcessProducts 里） */
  private async runAiProcess(tenantId: string, userId: string, ids: string[], clientRequestId?: string) {
    const rows = await this.prisma.product.findMany({
      where: { id: { in: ids }, active: true, OR: [{ tenantId: null }, { tenantId }] },
    });
    if (rows.length === 0) throw new NotFoundException('PRODUCT_NOT_FOUND');

    // ① 一次 LLM 调用批量补文案 + 品类归位（按传入顺序返回数组）
    let copyOk = 0;
    try {
      const catDict = await this.categories(tenantId);
      const catKeys = new Set(catDict.map((c) => c.key));
      const catList = catDict.map((c) => `${c.key}=${c.label}`).join('、');
      const list = rows.map((r) => ({ id: r.id, name: r.name, category: r.category, brand: r.brand, model: r.model, perRoom: r.perRoom }));
      const filled = await this.llm.chatJson<{ id: string; category?: string; brand?: string; model?: string; perRoom?: string }[]>({
        systemPrompt: `你是智能家居产品资料助理。为每个产品输出：category（从品类字典里选最贴切的 key，字典：${catList}）、brand（品牌，未知给空串）、model（型号，未知给空串）、perRoom（布置提示，如"每个窗帘位 1 台"）。已有且合理的值必须原样保留不得改写。返回与输入等长的 JSON 数组，每项 {id, category, brand, model, perRoom}。`,
        prompt: JSON.stringify(list),
        rag: { tenantId, userId, scene: 'product-enrich' },
      });
      const byId = new Map(filled.map((f) => [f.id, f]));
      for (const r of rows) {
        if (r.tenantId !== tenantId) continue; // 公共库行不改文案
        const f = byId.get(r.id);
        if (!f) continue;
        const data: Record<string, string> = {};
        if (!r.brand && f.brand) data.brand = f.brand.slice(0, 40);
        if (!r.model && f.model) data.model = f.model.slice(0, 40);
        if (!r.perRoom && f.perRoom) data.perRoom = f.perRoom.slice(0, 60);
        // 品类归位：仅当 LLM 给出字典内的不同 key 时修正
        if (f.category && catKeys.has(f.category) && f.category !== r.category) data.category = f.category;
        if (Object.keys(data).length) {
          await this.prisma.product.update({ where: { id: r.id }, data });
          copyOk += 1;
        }
      }
      await this.tokens.consume(tenantId, 3, 'CONSUME', { kind: 'product-enrich', count: rows.length }, userId);
    } catch (e) {
      this.logger.warn(`产品文案批量补全降级: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ② 逐个生成产品图（generateImage 内部扣额度+落盘）
    let imageOk = 0;
    const errors: { name: string; error: string }[] = [];
    for (const r of rows) {
      try {
        const label = CATEGORY_META[r.category]?.label ?? r.category;
        const res = await this.media.generateImage({
          tenantId,
          userId,
          prompt: `${label}设备产品图：${[r.brand, r.name, r.model].filter(Boolean).join(' ')}，白色纯净背景，产品居中，柔和投影，电商主图风格，高清细节，无文字水印`,
          size: '1024x1024',
          title: `产品图-${r.name}`.slice(0, 60),
        });
        await this.prisma.product.update({ where: { id: r.id }, data: { imageUrl: res.url } });
        imageOk += 1;
      } catch (e) {
        errors.push({ name: r.name, error: e instanceof Error ? e.message : String(e) });
      }
    }

    await this.auditProduct(tenantId, userId, `ids=${ids.length} copy=${copyOk} image=${imageOk} failed=${errors.length}`);
    const out = { total: rows.length, copyOk, imageOk, errors };
    // 结果摘要入幂等记录：批量结果含 errors 数组，原样存即可（不含产品实体，不大）
    await this.idem.complete(tenantId, clientRequestId, 'product-enrich', out);
    return out;
  }

  private async auditProduct(tenantId: string, actorId: string, target: string): Promise<void> {
    try {
    } catch {
      // 留痕失败不阻塞业务
    }
  }

  async create(tenantId: string, userId: string, dto: { title: string; mediaAssetId: string; points: unknown[] }) {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: dto.mediaAssetId, tenantId } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    return this.prisma.floorplanLayout.create({
      data: { tenantId, userId, title: dto.title, mediaAssetId: dto.mediaAssetId, points: dto.points as never },
    });
  }

  list(tenantId: string) {
    return this.prisma.floorplanLayout.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  async detail(tenantId: string, id: string) {
    const row = await this.prisma.floorplanLayout.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('LAYOUT_NOT_FOUND');
    return row;
  }

  async update(tenantId: string, id: string, dto: { title?: string; points?: unknown[] }) {
    await this.detail(tenantId, id);
    return this.prisma.floorplanLayout.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.points !== undefined ? { points: dto.points as never } : {}),
      },
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.detail(tenantId, id);
    await this.prisma.floorplanLayout.delete({ where: { id } });
  }

  /** 设备清单汇总：按产品名聚合数量与价格区间（导出 CSV 用，服务端口径校验） */
  async summary(tenantId: string, id: string) {
    const row = await this.detail(tenantId, id);
    const points = (Array.isArray(row.points) ? row.points : []) as { productId: string; name: string; category: string }[];
    const products = await this.prisma.product.findMany({ where: { id: { in: [...new Set(points.map((p) => p.productId))] } } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const agg = new Map<string, { name: string; category: string; qty: number; priceMin: number; priceMax: number }>();
    for (const p of points) {
      const prod = byId.get(p.productId);
      const key = p.productId;
      const cur = agg.get(key) ?? {
        name: prod?.name ?? p.name ?? '未知设备',
        category: prod?.category ?? p.category ?? '',
        qty: 0,
        priceMin: prod?.priceMin ?? 0,
        priceMax: prod?.priceMax ?? 0,
      };
      cur.qty += 1;
      agg.set(key, cur);
    }
    return [...agg.values()].sort((a, b) => a.category.localeCompare(b.category) || b.qty - a.qty);
  }
}
