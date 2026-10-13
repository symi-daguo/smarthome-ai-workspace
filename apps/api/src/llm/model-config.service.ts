import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.module.js';

/**
 * 模型配置中心服务：
 *   - 配置来源优先级：数据库（前端「模型配置」页保存）> .env（部署者默认值）
 *   - DB 保存即时生效（生成链路每次运行时读取），无需重启容器
 *   - API Key 只进不出：保存后任何读取接口一律脱敏，绝不回传明文
 */

export type ConfigScope = 'chat' | 'image' | 'video' | 'knowledge';

export interface ChatRuntime {
  baseUrl: string;
  apiKey?: string;
  /** 显式锁定的模型名；undefined 表示跟随请求传入值 */
  model?: string;
  source: 'db' | 'env';
}

export interface ImageRuntime {
  provider: 'minimax' | 'openai' | 'comfyui';
  /** minimax/openai 的 images 端点 base url */
  baseUrl: string;
  apiKey?: string;
  model: string;
  comfyBaseUrl: string;
  workflowPath: string;
  promptNode: string;
  negativeNode: string;
  latentNode: string;
  seedNode: string;
  source: 'db' | 'env';
}

export interface VideoRuntime {
  provider: 'minimax' | 'openai';
  baseUrl: string;
  apiKey?: string;
  /** openai(sora) provider 的模型名（如 sora-2） */
  model: string;
  source: 'db' | 'env';
}

export interface KnowledgeRuntime {
  provider: 'none' | 'weknora' | 'obsidian';
  baseUrl: string;
  apiKey?: string;
  /** weknora: 限定知识库 id（逗号分隔，空=全部） */
  kbIds: string;
  enabled: boolean;
  source: 'db' | 'env';
}

interface DbChatConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}
interface DbImageConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  comfyBaseUrl?: string;
  workflowPath?: string;
  promptNode?: string;
  negativeNode?: string;
  latentNode?: string;
  seedNode?: string;
}
interface DbVideoConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}
interface DbKnowledgeConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  kbIds?: string;
  enabled?: string;
}

const SCOPES: ConfigScope[] = ['chat', 'image', 'video', 'knowledge'];

function clean(v: string | undefined): string {
  return (v ?? '').trim();
}

@Injectable()
export class ModelConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** env 空串/空白视为未配置回退默认（compose 传 VAR= 空值时避免破坏请求） */
  private env(key: string, fallback = ''): string {
    const v = this.config.get<string>(key);
    return v && v.trim() ? v.trim() : fallback;
  }

  /** env 中的 key：replace-me 占位视为未配置 */
  private envKey(key: string): string {
    const v = this.env(key);
    return v === 'replace-me' ? '' : v;
  }

  private async read<T>(scope: ConfigScope): Promise<T | null> {
    const row = await this.prisma.modelSetting.findUnique({ where: { scope } });
    return row ? (row.config as T) : null;
  }

  async chatConfig(): Promise<ChatRuntime> {
    const db = (await this.read<DbChatConfig>('chat')) ?? {};
    const envBase = this.env('LLM_BASE_URL') || this.env('MiniMax_BASE_URL', 'https://api.minimaxi.com/v1');
    const envKey = this.envKey('LLM_API_KEY') || this.envKey('MiniMax_API_KEY');
    const baseUrl = clean(db.baseUrl) || envBase;
    const apiKey = clean(db.apiKey) || envKey || undefined;
    const model = clean(db.model) || this.env('LLM_MODEL') || undefined;
    return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, source: db.baseUrl || db.apiKey || db.model ? 'db' : 'env' };
  }

  async imageConfig(): Promise<ImageRuntime> {
    const db = (await this.read<DbImageConfig>('image')) ?? {};
    const providerRaw = clean(db.provider) || this.env('IMAGE_PROVIDER', 'minimax').toLowerCase();
    const provider: ImageRuntime['provider'] = providerRaw === 'openai' || providerRaw === 'comfyui' ? providerRaw : 'minimax';
    const minimaxBase = this.env('MiniMax_BASE_URL', 'https://api.minimaxi.com/v1');
    const fallbackBase =
      provider === 'openai' ? this.env('IMAGE_BASE_URL', 'https://api.openai.com/v1') : minimaxBase;
    const fallbackKey =
      provider === 'openai' ? this.envKey('IMAGE_API_KEY') : this.envKey('MiniMax_API_KEY');
    return {
      provider,
      baseUrl: (clean(db.baseUrl) || fallbackBase).replace(/\/+$/, ''),
      apiKey: clean(db.apiKey) || fallbackKey || undefined,
      model: clean(db.model) || this.env('IMAGE_MODEL') || (provider === 'openai' ? 'gpt-image-1' : provider === 'comfyui' ? '本地 SD 工作流' : 'image-01'),
      comfyBaseUrl: (clean(db.comfyBaseUrl) || this.env('COMFYUI_BASE_URL', 'http://127.0.0.1:8188')).replace(/\/+$/, ''),
      workflowPath: clean(db.workflowPath) || this.env('COMFYUI_WORKFLOW_PATH', 'comfyui-workflow.json'),
      promptNode: clean(db.promptNode) || this.env('COMFYUI_PROMPT_NODE', '6'),
      negativeNode: clean(db.negativeNode) || this.env('COMFYUI_NEGATIVE_NODE', '7'),
      latentNode: clean(db.latentNode) || this.env('COMFYUI_LATENT_NODE', '5'),
      seedNode: clean(db.seedNode) || this.env('COMFYUI_SEED_NODE', '3'),
      source: Object.values(db).some((v) => clean(v)) ? 'db' : 'env',
    };
  }

  async videoConfig(): Promise<VideoRuntime> {
    const db = (await this.read<DbVideoConfig>('video')) ?? {};
    const providerRaw = clean(db.provider) || this.env('VIDEO_PROVIDER', 'minimax').toLowerCase();
    const provider: VideoRuntime['provider'] = providerRaw === 'openai' ? 'openai' : 'minimax';
    const minimaxBase = this.env('MiniMax_BASE_URL', 'https://api.minimaxi.com/v1');
    const fallbackBase = provider === 'openai' ? this.env('VIDEO_BASE_URL', 'https://api.openai.com/v1') : minimaxBase;
    const fallbackKey = provider === 'openai' ? this.envKey('VIDEO_API_KEY') : this.envKey('MiniMax_API_KEY');
    const baseUrl = clean(db.baseUrl) || fallbackBase;
    const apiKey = clean(db.apiKey) || fallbackKey || undefined;
    // minimax 的视频模型名留空表示「按有无首帧自动选 T2V/I2V-01-Director」；
    // 填具体模型名（如 MiniMax-H3）则原样下发。之前这里默认填了 'T2V-01-Director / I2V-01-Director'
    // 这个「描述串」，它不是合法模型名，一旦被当模型名下发必然被上游拒绝。
    const model = clean(db.model) || this.env('VIDEO_MODEL') || (provider === 'openai' ? 'sora-2' : '');
    return { provider, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, source: Object.values(db).some((v) => clean(v)) ? 'db' : 'env' };
  }

  async knowledgeConfig(): Promise<KnowledgeRuntime> {
    const db = (await this.read<DbKnowledgeConfig>('knowledge')) ?? {};
    const providerRaw = clean(db.provider) || this.env('KNOWLEDGE_PROVIDER', 'none').toLowerCase();
    const provider: KnowledgeRuntime['provider'] = providerRaw === 'weknora' || providerRaw === 'obsidian' ? providerRaw : 'none';
    const fallbackBase = provider === 'obsidian' ? this.env('OBSIDIAN_BASE_URL', 'http://127.0.0.1:27124') : this.env('WEKNORA_BASE_URL', 'http://127.0.0.1:8080/api/v1');
    const fallbackKey = provider === 'obsidian' ? this.envKey('OBSIDIAN_API_KEY') : this.envKey('WEKNORA_API_KEY');
    const enabledRaw = clean(db.enabled) || this.env('KNOWLEDGE_ENABLED', 'true');
    return {
      provider,
      baseUrl: (clean(db.baseUrl) || fallbackBase).replace(/\/+$/, ''),
      apiKey: clean(db.apiKey) || fallbackKey || undefined,
      kbIds: clean(db.kbIds) || this.env('WEKNORA_KB_IDS'),
      enabled: provider !== 'none' && enabledRaw !== 'false',
      source: Object.values(db).some((v) => clean(v)) ? 'db' : 'env',
    };
  }

  /**
   * 保存配置：文本字段传空串表示清除（回退 .env）；
   * apiKey 传空串/缺省表示保持已存密钥不变（前端不回显明文，无法区分"没改"与"想清除"，
   * 清除密钥请用「恢复 .env 默认」整行重置）。
   */
  async save(scope: ConfigScope, dto: Record<string, string | undefined>, actorId: string): Promise<void> {
    if (!SCOPES.includes(scope)) throw new BadRequestException('UNKNOWN_SCOPE');
    const existing = (await this.read<Record<string, string>>(scope)) ?? {};
    const merged: Record<string, string> = { ...existing };
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      if (key === 'apiKey') {
        const v = clean(value);
        if (v) merged.apiKey = v;
        continue;
      }
      merged[key] = clean(value);
    }
    await this.prisma.modelSetting.upsert({
      where: { scope },
      create: { scope, config: merged as object, updated: actorId },
      update: { config: merged as object, updated: actorId },
    });
  }

  /** 恢复 .env 默认：删除该 scope 的 DB 配置行 */
  async reset(scope: ConfigScope): Promise<void> {
    if (!SCOPES.includes(scope)) throw new BadRequestException('UNKNOWN_SCOPE');
    await this.prisma.modelSetting.deleteMany({ where: { scope } });
  }

  // ---------- 命名模型方案（多套配置，不同需求用不同模型） ----------

  /** 方案列表（不含明文 key，仅返回 keyMasked 状态） */
  async listProfiles() {
    const rows = await this.prisma.modelProfile.findMany({ orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }] });
    return rows.map((r) => {
      const scopes = r.scopes as Record<string, { apiKey?: string }>;
      return {
        id: r.id,
        name: r.name,
        active: r.active,
        updatedAt: r.updatedAt.toISOString(),
        scopes: Object.fromEntries(
          Object.entries(scopes).map(([k, v]) => [k, { hasKey: Boolean(v?.apiKey) }]),
        ),
      };
    });
  }

  /** 把当前生效的 ModelSetting 各 scope 快照为命名方案（可覆盖同名）；无任何激活方案时新方案即当前 */
  async saveProfile(name: string, actorId: string) {
    const cleanName = name.trim().slice(0, 40);
    if (!cleanName) throw new BadRequestException('PROFILE_NAME_REQUIRED');
    const settings = await this.prisma.modelSetting.findMany();
    const scopes: Record<string, unknown> = {};
    for (const s of settings) scopes[s.scope] = s.config;
    const hasActive = await this.prisma.modelProfile.count({ where: { active: true } });
    const row = await this.prisma.modelProfile.upsert({
      where: { name: cleanName },
      create: { name: cleanName, scopes: scopes as object, active: hasActive === 0, updated: actorId },
      update: { scopes: scopes as object, updated: actorId },
    });
    return { id: row.id, name: row.name };
  }

  /** 激活方案：把快照写回 ModelSetting（即时生效，运行时链路零改动） */
  async activateProfile(id: string, actorId: string): Promise<void> {
    const row = await this.prisma.modelProfile.findUnique({ where: { id } });
    if (!row) throw new BadRequestException('PROFILE_NOT_FOUND');
    const scopes = row.scopes as Record<string, object>;
    await this.prisma.$transaction([
      this.prisma.modelProfile.updateMany({ where: { active: true }, data: { active: false } }),
      ...SCOPES.map((scope) =>
        scopes[scope]
          ? this.prisma.modelSetting.upsert({
              where: { scope },
              create: { scope, config: scopes[scope], updated: actorId },
              update: { config: scopes[scope], updated: actorId },
            })
          : this.prisma.modelSetting.deleteMany({ where: { scope } }),
      ),
    ]);
    await this.prisma.modelProfile.update({ where: { id }, data: { active: true } });
  }

  async removeProfile(id: string): Promise<void> {
    const row = await this.prisma.modelProfile.findUnique({ where: { id } });
    if (!row) throw new BadRequestException('PROFILE_NOT_FOUND');
    if (row.active) throw new BadRequestException({ code: 'PROFILE_ACTIVE', message: '当前生效方案不可删除，请先切换到其他方案' });
    await this.prisma.modelProfile.delete({ where: { id } });
  }

  /** 已存明文 key（仅服务端内部使用，绝不出现在任何响应中） */
  async storedKey(scope: ConfigScope): Promise<string> {
    const db = await this.read<{ apiKey?: string }>(scope);
    return clean(db?.apiKey);
  }
}
