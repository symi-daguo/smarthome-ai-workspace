import { Body, Controller, Delete, Get, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { z } from 'zod';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { KnowledgeService } from './knowledge.service.js';

const knowledgeConfigSchema = z.object({
  provider: z.enum(['none', 'weknora', 'obsidian']).optional(),
  baseUrl: z.string().trim().max(200).optional(),
  apiKey: z.string().trim().max(200).optional(),
  kbIds: z.string().trim().max(500).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});
const searchSchema = z.object({ query: z.string().min(1).max(500) });

/** 外部知识库（WeKnora / Obsidian）配置与检索（租户内，knowledge:manage） */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('knowledge/external')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @RequirePermissions('knowledge:manage')
  @Get()
  status() {
    return this.knowledge.status();
  }

  @RequirePermissions('knowledge:manage')
  @Put()
  async save(@CurrentUser() user: AuthProfile, @Body(new ZodValidationPipe(knowledgeConfigSchema)) dto: z.infer<typeof knowledgeConfigSchema>): Promise<{ ok: true }> {
    await this.knowledge.save(dto, user.id);
    return { ok: true };
  }

  @RequirePermissions('knowledge:manage')
  @Delete()
  async reset(): Promise<{ ok: true }> {
    await this.knowledge.reset();
    return { ok: true };
  }

  @RequirePermissions('knowledge:manage')
  @Post('test')
  test() {
    return this.knowledge.test();
  }

  @RequirePermissions('knowledge:manage')
  @Post('search')
  async search(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(searchSchema)) dto: { query: string },
  ): Promise<{ chunks: unknown[] }> {
    const chunks = await this.knowledge.search(user.activeTenantId as string, user.id, dto.query);
    return { chunks };
  }
}
