import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { LayoutService } from './layout.service.js';
import {
  createLayoutSchema,
  createProductSchema,
  createCategorySchema,
  aiProcessProductsSchema,
  updateLayoutSchema,
  updateProductSchema,
  type CreateLayoutDto,
  type CreateProductDto,
  type CreateCategoryDto,
  type AiProcessProductsDto,
  type UpdateLayoutDto,
  type UpdateProductDto,
} from './layout.schemas.js';

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller()
export class LayoutController {
  constructor(private readonly layout: LayoutService) {}

  /** 产品目录（公共库+我的库合并，布点/报价选品数据源） */
  @RequirePermissions('quote:read')
  @Get('products')
  products(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.layout.products(user.activeTenantId);
  }

  /** 品类字典（预置 24 类 + 本租户自定义） */
  @RequirePermissions('quote:read')
  @Get('categories')
  categories(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.layout.categories(user.activeTenantId);
  }

  /** 新增自定义品类（同名幂等） */
  @RequirePermissions('quote:read')
  @Post('categories/mine')
  createCategory(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(createCategorySchema)) dto: CreateCategoryDto,
  ) {
    return this.layout.createCategory(user.activeTenantId as string, dto);
  }

  /** 删除自定义品类（预置不可删，在用拒绝） */
  @RequirePermissions('quote:write')
  @Delete('categories/:id')
  removeCategory(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.removeCategory(user.activeTenantId as string, id);
  }

  /** 我的产品库：新增 */
  @RequirePermissions('quote:write')
  @Post('products/mine')
  createProduct(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(createProductSchema)) dto: CreateProductDto,
  ) {
    return this.layout.createProduct(user.activeTenantId as string, dto);
  }

  /** 公共库产品复制到我的库 */
  @RequirePermissions('quote:write')
  @Post('products/:id/copy-to-mine')
  copyProduct(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.copyProductToMine(user.activeTenantId as string, id);
  }

  /** 我的产品库：编辑（仅本租户行） */
  @RequirePermissions('quote:write')
  @Patch('products/:id')
  updateProduct(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) dto: UpdateProductDto,
  ) {
    return this.layout.updateProduct(user.activeTenantId as string, id, dto);
  }

  /** 我的产品库：删除（仅本租户行） */
  @RequirePermissions('quote:write')
  @Delete('products/:id')
  removeProduct(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.removeProduct(user.activeTenantId as string, id);
  }

  /** agent 批量处理产品：补全文案 + 批量生成产品图（勾选行，含公共库） */
  @RequirePermissions('content:generate')
  @Post('products/ai-process')
  aiProcess(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(aiProcessProductsSchema)) dto: AiProcessProductsDto,
  ) {
    return this.layout.aiProcessProducts(user.activeTenantId as string, user.id, dto.ids, dto.clientRequestId);
  }

  @RequirePermissions('content:generate')
  @Post('layouts')
  create(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(createLayoutSchema)) dto: CreateLayoutDto,
  ) {
    return this.layout.create(user.activeTenantId as string, user.id, dto);
  }

  @RequirePermissions('content:read')
  @Get('layouts')
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.layout.list(user.activeTenantId as string);
  }

  @RequirePermissions('content:read')
  @Get('layouts/:id')
  detail(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.detail(user.activeTenantId as string, id);
  }

  @RequirePermissions('quote:read')
  @Get('layouts/:id/summary')
  summary(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.summary(user.activeTenantId as string, id);
  }

  @RequirePermissions('content:read')
  @Patch('layouts/:id')
  update(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateLayoutSchema)) dto: UpdateLayoutDto,
  ) {
    return this.layout.update(user.activeTenantId as string, id, dto);
  }

  @RequirePermissions('content:generate')
  @Delete('layouts/:id')
  remove(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.remove(user.activeTenantId as string, id);
  }
}
