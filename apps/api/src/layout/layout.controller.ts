import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { LayoutService } from './layout.service.js';
import { ProductTransferService } from './product-transfer.service.js';
import { BrandImportService } from './brand-import.service.js';
import { FloorplanDetectService } from './floorplan-detect.service.js';
import {
  createLayoutSchema,
  createProductSchema,
  createCategorySchema,
  aiProcessProductsSchema,
  updateLayoutSchema,
  updateProductSchema,
  exportProductsSchema,
  importProductsSchema,
  brandFetchSchema,
  floorplanDetectSchema,
  type CreateLayoutDto,
  type CreateProductDto,
  type CreateCategoryDto,
  type AiProcessProductsDto,
  type UpdateLayoutDto,
  type UpdateProductDto,
  type ExportProductsDto,
  type ImportProductsDto,
  type BrandFetchDto,
  type FloorplanDetectDto,
} from './layout.schemas.js';

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller()
export class LayoutController {
  constructor(
    private readonly layout: LayoutService,
    private readonly transfer: ProductTransferService,
    private readonly brandImport: BrandImportService,
    private readonly floorplanDetect: FloorplanDetectService,
  ) {}

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

  /** 新增自定义品类（同名幂等）：写操作，要 quote:write（同模块 DELETE 的口径） */
  @RequirePermissions('quote:write')
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

  /**
   * 导出产品库（CSV / JSON）。
   *
   * 返回文件而不是 JSON —— 目的是让人能直接下载、给 Excel 打开、
   * 或者喂给别的系统继续处理。
   */
  @RequirePermissions('quote:read')
  @Get('products/export')
  async exportProducts(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Query(new ZodValidationPipe(exportProductsSchema)) q: ExportProductsDto,
    @Res() res: Response,
  ) {
    const rows = await this.transfer.exportRows(user.activeTenantId as string, q.scope);
    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="products-${stamp}.json"`);
      res.send(this.transfer.toJson(rows));
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="products-${stamp}.csv"`);
    res.send(this.transfer.toCsv(rows));
  }

  /**
   * 导入格式契约：客户自己的 Agent 照着这份定义去品牌官网取数、按格式填好再导进来。
   *
   * 返回：字段清单与约束、当前可用的品类字典、CSV 模板表头、JSON 示例、导入规则。
   * 「取哪个品类 key」这件事必须由服务端给 —— 品类字典是租户可自定义的，
   * 客户端猜不到，猜错就整批被拒。
   */
  @RequirePermissions('quote:read')
  @Get('products/import-format')
  importFormat(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.transfer.importFormat(user.activeTenantId as string);
  }

  /**
   * 导入产品库（JSON 行 或 CSV 文本）。
   *
   * 整批原子：任何一行不合法就整批不落库，并把每行的问题报出来。
   */
  @RequirePermissions('quote:write')
  @Post('products/import')
  async importProducts(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(importProductsSchema)) dto: ImportProductsDto,
  ) {
    const rows = dto.rows?.length ? dto.rows : dto.csv ? this.transfer.csvToRows(dto.csv) : [];
    return this.transfer.importRows(user.activeTenantId as string, rows, {
      updateExisting: dto.updateExisting,
    });
  }

  /**
   * 从品牌官网抓产品（preview=只看不写 / import=直接落库）。
   */
  @RequirePermissions('quote:write')
  @Post('products/fetch-brand')
  async fetchBrand(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(brandFetchSchema)) dto: BrandFetchDto,
  ) {
    if (dto.mode === 'import') {
      return this.brandImport.fetchAndImport(
        user.activeTenantId as string,
        user.id,
        dto.siteUrl,
        dto.brand,
        { updateExisting: dto.updateExisting },
      );
    }
    return this.brandImport.preview(user.activeTenantId as string, dto.siteUrl, dto.brand);
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

  /**
   * 户型图「AI 识别并布点」：读图识别房间 + 选设备，返回落好位的点位坐标。
   *
   * 结果只是**建议**：前端回填到点位编辑器，人可继续拖拽微调后再挂接方案。
   * 消耗算力，按 content:generate 计费。
   */
  @RequirePermissions('content:generate')
  @Post('floorplan/detect')
  detectFloorplan(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(floorplanDetectSchema)) dto: FloorplanDetectDto,
  ) {
    return this.floorplanDetect.detect(user.activeTenantId as string, user.id, dto.floorplanAssetId);
  }

  /** 改布局（点位/标题）：写操作，要 content:generate（同模块 POST/DELETE 的口径） */
  @RequirePermissions('content:generate')
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
