import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';

/** 产品目录（全局共享）+ 点位布局图纸 CRUD */
@Injectable()
export class LayoutService {
  constructor(private readonly prisma: PrismaService) {}

  products() {
    return this.prisma.product.findMany({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
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
