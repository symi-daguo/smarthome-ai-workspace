import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PlanPageImagesService } from './plan-page-images.service.js';
import { pageTypeSchema, setPageImageSchema, type SetPageImageDto } from './plan-page-images.schemas.js';

/**
 * 方案页型配图（租户级）。
 *
 * **为什么单独一个控制器**（而不是挂在 PlansController 上）：
 * 路由顺序。PlansController 里有 `@Get(':id')`，它会吃掉 `/api/plans/page-images`
 * （两段路径、单段通配）—— 请求会被当成「取 id=page-images 的方案」而 404。
 * Nest 按模块里 controllers 数组的**注册顺序**匹配路由，
 * 所以这个控制器必须排在 PlansController **前面**（见 plans.module.ts）。
 *
 * 权限口径：读用 content:read，写/删用 content:generate ——
 * 改配图会改变导出的交付件，属于「生成」这一类动作。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('plans/page-images')
export class PlanPageImagesController {
  constructor(private readonly pageImages: PlanPageImagesService) {}

  /**
   * 本租户已配置的页型配图：{ floorplan: { mediaAssetId, url }, ... }。
   * 没配过的页型不出现（前端据此用兜底图）。
   */
  @RequirePermissions('content:read')
  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.pageImages.list(user.activeTenantId as string);
  }

  /** 写入/更新某页型的配图 */
  @RequirePermissions('content:generate')
  @Put(':pageType')
  set(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('pageType', new ZodValidationPipe(pageTypeSchema)) pageType: string,
    @Body(new ZodValidationPipe(setPageImageSchema)) dto: SetPageImageDto,
  ) {
    return this.pageImages.set(user.activeTenantId as string, pageType, dto.mediaAssetId);
  }

  /** 清除某页型的配图（回到写死的兜底图） */
  @RequirePermissions('content:generate')
  @Delete(':pageType')
  async clear(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('pageType', new ZodValidationPipe(pageTypeSchema)) pageType: string,
  ): Promise<void> {
    await this.pageImages.clear(user.activeTenantId as string, pageType);
  }
}
