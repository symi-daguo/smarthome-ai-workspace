import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import type { CreateSceneDto, UpdateSceneDto } from './lighting.schemas.js';

/**
 * 智能灯光场景服务：灯具编排 + 手工时间轴 + 出片产物挂接。
 * 对所有登录成员开放（content:generate），数据按 activeTenantId 隔离。
 * 列表不返回 fixtures/timeline 大字段（列表页只需标题/画幅/状态），详情才返回全量。
 */
@Injectable()
export class LightingService {
  constructor(private readonly prisma: PrismaService) {}

  private async mustGet(tenantId: string, id: string) {
    const scene = await this.prisma.lightingScene.findFirst({ where: { id, tenantId } });
    if (!scene) throw new NotFoundException('SCENE_NOT_FOUND');
    return scene;
  }

  list(tenantId: string) {
    return this.prisma.lightingScene.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      // 列表页不回传 fixtures/timeline（灯具与时间轴是大对象，列表无需携带）
      select: { id: true, title: true, ratio: true, status: true, createdAt: true, videoAssetId: true },
    });
  }

  detail(tenantId: string, id: string) {
    return this.mustGet(tenantId, id);
  }

  create(tenantId: string, userId: string, dto: CreateSceneDto) {
    return this.prisma.lightingScene.create({
      data: {
        tenantId,
        userId,
        title: dto.title.trim(),
        ...(dto.sourceAssetId !== undefined ? { sourceAssetId: dto.sourceAssetId } : {}),
        ...(dto.ratio !== undefined ? { ratio: dto.ratio } : {}),
        fixtures: dto.fixtures,
        timeline: dto.timeline,
        ...(dto.videoAssetId !== undefined ? { videoAssetId: dto.videoAssetId } : {}),
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateSceneDto) {
    const owned = await this.mustGet(tenantId, id);
    return this.prisma.lightingScene.update({
      where: { id: owned.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.sourceAssetId !== undefined ? { sourceAssetId: dto.sourceAssetId } : {}),
        ...(dto.ratio !== undefined ? { ratio: dto.ratio } : {}),
        ...(dto.fixtures !== undefined ? { fixtures: dto.fixtures } : {}),
        ...(dto.timeline !== undefined ? { timeline: dto.timeline } : {}),
        ...(dto.videoAssetId !== undefined ? { videoAssetId: dto.videoAssetId } : {}),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const owned = await this.mustGet(tenantId, id);
    return this.prisma.lightingScene.delete({ where: { id: owned.id } });
  }
}