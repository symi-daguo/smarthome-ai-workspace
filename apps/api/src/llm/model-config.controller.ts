import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { LlmService } from './llm.service.js';

/**
 * 模型配置中心（仅 super_admin）：
 *   - GET  返回当前 env 中各能力（对话 / 生图 / 生视频）的 provider 配置状态，API Key 一律脱敏（末四位 + 长度），绝不回传明文
 *   - POST 发起一次极小的对话请求做连通性探测，返回延迟与模型名
 * 配置本身只读展示，修改由部署者直接编辑 .env（开源自部署，密钥不进前端）。
 */
interface ProviderStatus {
  provider: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  keyMasked: string | null;
}

/** 固定短掩码（末四位可见）：既脱敏也不泄漏密钥长度，避免超长圆点撑爆 UI */
function maskKey(key: string | undefined): string | null {
  if (!key || key === 'replace-me') return null;
  return `••••${key.slice(-4)}`;
}

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('admin/model-config')
export class ModelConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly llm: LlmService,
  ) {}

  /** env 空串/空白视为未配置回退默认（compose 传 VAR= 空值时展示生效默认而非空） */
  private env(key: string, fallback: string): string {
    const v = this.config.get<string>(key);
    return v && v.trim() ? v : fallback;
  }

  private chatStatus(): ProviderStatus {
    const key = this.config.get<string>('LLM_API_KEY') || this.config.get<string>('MiniMax_API_KEY');
    const usesLlmEnv = Boolean(this.config.get<string>('LLM_BASE_URL'));
    return {
      provider: usesLlmEnv ? 'openai-compatible' : 'MiniMax',
      baseUrl: this.llm.baseUrl,
      model: this.llm.configuredModel ?? '（跟随请求，默认 MiniMax-M3）',
      keyConfigured: Boolean(key && key !== 'replace-me'),
      keyMasked: maskKey(key),
    };
  }

  private imageStatus(): ProviderStatus & { comfyBaseUrl?: string; comfyWorkflow?: string } {
    const provider = (this.config.get<string>('IMAGE_PROVIDER') ?? 'minimax').toLowerCase();
    if (provider === 'comfyui') {
      return {
        provider: 'comfyui',
        baseUrl: (this.config.get<string>('COMFYUI_BASE_URL') || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
        model: this.env('IMAGE_MODEL', '本地 SD 工作流'),
        keyConfigured: true,
        keyMasked: null,
        comfyWorkflow: this.env('COMFYUI_WORKFLOW_PATH', 'comfyui-workflow.json'),
      };
    }
    if (provider === 'openai') {
      const key = this.config.get<string>('IMAGE_API_KEY');
      return {
        provider: 'openai-images',
        baseUrl: (this.config.get<string>('IMAGE_BASE_URL') || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        model: this.env('IMAGE_MODEL', 'gpt-image-1'),
        keyConfigured: Boolean(key && key !== 'replace-me'),
        keyMasked: maskKey(key),
      };
    }
    const key = this.config.get<string>('MiniMax_API_KEY');
    return {
      provider: 'MiniMax image-01',
      baseUrl: (this.config.get<string>('MiniMax_BASE_URL') || 'https://api.minimaxi.com/v1').replace(/\/+$/, ''),
      model: this.env('IMAGE_MODEL', 'image-01'),
      keyConfigured: Boolean(key && key !== 'replace-me'),
      keyMasked: maskKey(key),
    };
  }

  private videoStatus(): ProviderStatus {
    const key = this.config.get<string>('MiniMax_API_KEY');
    return {
      provider: 'MiniMax Director',
      baseUrl: (this.config.get<string>('MiniMax_BASE_URL') || 'https://api.minimaxi.com/v1').replace(/\/+$/, ''),
      model: 'T2V-01-Director / I2V-01-Director',
      keyConfigured: Boolean(key && key !== 'replace-me'),
      keyMasked: maskKey(key),
    };
  }

  @RequirePermissions('platform:billing:manage')
  @Get()
  status(): { chat: ProviderStatus; image: ProviderStatus; video: ProviderStatus } {
    return { chat: this.chatStatus(), image: this.imageStatus(), video: this.videoStatus() };
  }

  @RequirePermissions('platform:billing:manage')
  @Post('test-chat')
  async testChat(): Promise<{ ok: boolean; model?: string; latencyMs?: number; error?: string }> {
    try {
      const r = await this.llm.chat({
        model: 'MiniMax-M3',
        prompt: 'ping',
        systemPrompt: '只回复 pong 两个字母，不要其他内容。',
        maxTokens: 16,
      });
      return { ok: true, model: r.model, latencyMs: r.latencyMs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }
}
