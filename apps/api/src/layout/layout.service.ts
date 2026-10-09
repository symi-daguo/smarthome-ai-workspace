import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';

/** 产品目录（公共库+我的库）+ 点位布局图纸 CRUD */
@Injectable()
export class LayoutService {
  constructor(private readonly prisma: PrismaService) {}

  /** 布点/报价选品数据源：公共库 + 本租户我的库（对齐参考站"我的产品库联动报价与点位"） */
  products(tenantId?: string) {
    return this.prisma.product.findMany({
      where: { active: true, OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])] },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async createProduct(tenantId: string, dto: { name: string; category: string; brand?: string; model?: string; unit?: string; priceMin?: number; priceMax?: number; perRoom?: string; imageUrl?: string }) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('PRODUCT_NAME_REQUIRED');
    const dup = await this.prisma.product.findFirst({ where: { name, tenantId } });
    if (dup) throw new BadRequestException({ code: 'PRODUCT_DUPLICATE', message: `我的库已有「${name}」` });
    return this.prisma.product.create({
      data: {
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
      },
    });
  }

  async updateProduct(tenantId: string, id: string, dto: Partial<{ name: string; category: string; brand: string; model: string; unit: string; priceMin: number; priceMax: number; perRoom: string; imageUrl: string }>) {
    const row = await this.prisma.product.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('PRODUCT_NOT_FOUND');
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  async removeProduct(tenantId: string, id: string): Promise<void> {
    const row = await this.prisma.product.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('PRODUCT_NOT_FOUND');
    await this.prisma.product.delete({ where: { id } });
  }

  /** 公共库产品复制到我的库（参考站"复制到我的库"联动规则） */
  async copyProductToMine(tenantId: string, id: string) {
    const src = await this.prisma.product.findFirst({ where: { id, tenantId: null } });
    if (!src) throw new NotFoundException('PUBLIC_PRODUCT_NOT_FOUND');
    const dup = await this.prisma.product.findFirst({ where: { name: src.name, tenantId } });
    if (dup) throw new BadRequestException({ code: 'PRODUCT_DUPLICATE', message: `我的库已有「${src.name}」` });
    return this.prisma.product.create({
      data: { tenantId, name: src.name, category: src.category, brand: src.brand, model: src.model, unit: src.unit, priceMin: src.priceMin, priceMax: src.priceMax, perRoom: src.perRoom, imageUrl: src.imageUrl },
    });
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
