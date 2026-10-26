import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';

/**
 * 素材文件流地址。
 *
 * 与 `POST /api/media/uploads` 返回的 url 字段**同一个约定**
 * （media.service.ts 里生成图片/上传图片都拼这一条），不在这里另立一套口径 ——
 * 前端拿到 url 直接就能塞进 <img> 或 fetch。
 */
export function assetFileUrl(assetId: string): string {
  return `/api/media/assets/${assetId}/file`;
}

/** 单条页型配图 */
export interface PageImageEntry {
  mediaAssetId: string;
  url: string;
}

/**
 * 方案页型配图（租户级）。
 *
 * 背景：PPT 方案每一页的配图此前是**按页型写死的本地图片**
 * （前端 PAGE_IMAGE，形如 /images/cases/c1.jpg），门店换不了自己的案例图。
 * 这里存「某个页型用哪张素材」，前端导出前读一次覆盖掉写死的常量。
 *
 * 为什么是租户级而不是部署级：每家门店自己的案例图不一样。
 */
@Injectable()
export class PlanPageImagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 本租户已配置的页型配图：{ pageType: { mediaAssetId, url } }。
   * 没配过的页型**不出现**在结果里 —— 前端据此判断「这个页型用兜底图」。
   */
  async list(tenantId: string): Promise<Record<string, PageImageEntry>> {
    const rows = await this.prisma.planPageImage.findMany({ where: { tenantId } });
    const out: Record<string, PageImageEntry> = {};
    for (const row of rows) {
      out[row.pageType] = { mediaAssetId: row.mediaAssetId, url: assetFileUrl(row.mediaAssetId) };
    }
    return out;
  }

  /**
   * 写入/更新某页型的配图（upsert：一个租户一个页型只有一条）。
   *
   * **必须校验素材属于当前租户**：
   * 不校验的话，A 租户能把 B 的素材 id 写进自己的配置，
   * 导出方案时就把别家的图放进自己的 PPT 里（既是版权问题，也是数据泄露）。
   */
  async set(tenantId: string, pageType: string, mediaAssetId: string): Promise<PageImageEntry> {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: mediaAssetId, tenantId } });
    if (!asset) throw new NotFoundException('PAGE_IMAGE_ASSET_NOT_FOUND');

    await this.prisma.planPageImage.upsert({
      where: { tenantId_pageType: { tenantId, pageType } },
      create: { tenantId, pageType, mediaAssetId },
      update: { mediaAssetId },
    });
    return { mediaAssetId, url: assetFileUrl(mediaAssetId) };
  }

  /**
   * 清除某页型的配图（回到写死的兜底图）。
   * 用 deleteMany 而不是 delete：没配过时不该报 404 —— 「清除」是幂等动作。
   */
  async clear(tenantId: string, pageType: string): Promise<void> {
    await this.prisma.planPageImage.deleteMany({ where: { tenantId, pageType } });
  }
}
