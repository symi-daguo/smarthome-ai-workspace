import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TokenService } from '../billing/token.service.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { llmTestSchema, type LlmTestDto } from './llm.schemas.js';
import { LlmService } from './llm.service.js';

/**
 * 平台层 LLM 测试入口，仅 super_admin 可调用
 * 用于本地验证 MiniMax API key 与连通性；后续 agent 工具调用复用 LlmService
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('admin/llm')
export class LlmController {
  constructor(private readonly llm: LlmService) {}

  @RequirePermissions('platform:billing:manage')
  @Post('test')
  test(@Body(new ZodValidationPipe(llmTestSchema)) dto: LlmTestDto) {
    return this.llm.chat({
      model: dto.model,
      prompt: dto.prompt,
      systemPrompt: dto.systemPrompt,
    });
  }
}

/** 工作台通用对话：租户成员按 content:generate 调用，扣费额度 env 可配（演示默认 3 token/次） */
const CHAT_TOKENS = Number(process.env.BILLING_CHAT_TOKENS ?? 3);

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('llm')
export class ChatController {
  constructor(
    private readonly llm: LlmService,
    private readonly tokens: TokenService,
  ) {}

  @RequirePermissions('content:generate')
  @Post('chat')
  async chat(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(llmTestSchema)) dto: LlmTestDto,
  ) {
    await this.tokens.consume(
      user.activeTenantId as string,
      CHAT_TOKENS,
      'CONSUME',
      { kind: 'chat', prompt: dto.prompt.slice(0, 80) },
      user.id,
    );
    return this.llm.chat({
      model: dto.model,
      prompt: dto.prompt,
      systemPrompt: dto.systemPrompt,
    });
  }
}
