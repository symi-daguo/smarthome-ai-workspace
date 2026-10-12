import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { LlmService } from './llm.service.js';
import { ModelConfigService, type ConfigScope } from './model-config.service.js';
import { chatConfigSchema, imageConfigSchema, videoConfigSchema, type ChatConfigDto, type ImageConfigDto, type VideoConfigDto } from './model-config.schemas.js';

/**
 * 模型配置中心（仅 super_admin）：
 *   - GET   返回各能力（对话/生图/生视频）当前生效配置，API Key 一律脱敏，绝不回传明文
 *   - PUT   在线保存配置到数据库（即时生效，无需重启；优先级 DB > .env）
 *   - POST  连通性测试（对话发极短请求；生图/生视频按 provider 探测端点可达性）
 *   - DELETE 恢复 .env 默认（删除 DB 配置行）
 */
interface ProviderView {
  provider: string;
  /** provider 机器键（minimax/openai/comfyui/...），供前端表单绑定 */
  providerKey: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  keyMasked: string | null;
  /** 配置来源：db=在线保存生效，env=读取 .env 默认 */
  source: 'db' | 'env';
}

/** 固定短掩码（末四位可见）：既脱敏也不泄漏密钥长度 */
function maskKey(key: string | undefined | null): string | null {
  if (!key) return null;
  return `••••${key.slice(-4)}`;
}

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('admin/model-config')
export class ModelConfigController {
  constructor(
    private readonly llm: LlmService,
    private readonly modelConfig: ModelConfigService,
  ) {}

  @RequirePermissions('platform:billing:manage')
  @Get()
  async status(): Promise<{ chat: ProviderView & { comfyBaseUrl?: string; workflowPath?: string }; image: ProviderView & { comfyBaseUrl?: string; workflowPath?: string; promptNode?: string; negativeNode?: string; latentNode?: string; seedNode?: string }; video: ProviderView }> {
    const [chat, image, video] = await Promise.all([
      this.modelConfig.chatConfig(),
      this.modelConfig.imageConfig(),
      this.modelConfig.videoConfig(),
    ]);
    return {
      chat: {
        provider: chat.baseUrl.includes('minimax') ? 'MiniMax（OpenAI 兼容）' : 'OpenAI 兼容端点',
        providerKey: 'openai-compatible',
        baseUrl: chat.baseUrl,
        model: chat.model ?? '（跟随请求，默认 MiniMax-M3）',
        keyConfigured: Boolean(chat.apiKey),
        keyMasked: maskKey(chat.apiKey),
        source: chat.source,
      },
      image: {
        provider: image.provider === 'comfyui' ? 'ComfyUI（本地）' : image.provider === 'openai' ? 'OpenAI 兼容生图' : 'MiniMax image-01',
        providerKey: image.provider,
        baseUrl: image.baseUrl,
        model: image.model,
        keyConfigured: image.provider === 'comfyui' ? true : Boolean(image.apiKey),
        keyMasked: image.provider === 'comfyui' ? null : maskKey(image.apiKey),
        source: image.source,
        comfyBaseUrl: image.comfyBaseUrl,
        workflowPath: image.workflowPath,
        promptNode: image.promptNode,
        negativeNode: image.negativeNode,
        latentNode: image.latentNode,
        seedNode: image.seedNode,
      },
      video: {
        provider: video.provider === 'openai' ? 'OpenAI Sora（videos API）' : 'MiniMax Director',
        providerKey: video.provider,
        baseUrl: video.baseUrl,
        model: video.model,
        keyConfigured: Boolean(video.apiKey),
        keyMasked: maskKey(video.apiKey),
        source: video.source,
      },
    };
  }

  @RequirePermissions('platform:billing:manage')
  @Put('chat')
  async saveChat(@CurrentUser() user: AuthProfile, @Body(new ZodValidationPipe(chatConfigSchema)) dto: ChatConfigDto): Promise<{ ok: true }> {
    await this.modelConfig.save('chat', dto as Record<string, string>, user.id);
    return { ok: true };
  }

  @RequirePermissions('platform:billing:manage')
  @Put('image')
  async saveImage(@CurrentUser() user: AuthProfile, @Body(new ZodValidationPipe(imageConfigSchema)) dto: ImageConfigDto): Promise<{ ok: true }> {
    await this.modelConfig.save('image', dto as unknown as Record<string, string>, user.id);
    return { ok: true };
  }

  @RequirePermissions('platform:billing:manage')
  @Put('video')
  async saveVideo(@CurrentUser() user: AuthProfile, @Body(new ZodValidationPipe(videoConfigSchema)) dto: VideoConfigDto): Promise<{ ok: true }> {
    await this.modelConfig.save('video', dto as Record<string, string>, user.id);
    return { ok: true };
  }

  @RequirePermissions('platform:billing:manage')
  @Delete(':scope')
  async reset(@Param('scope') scope: string): Promise<{ ok: true; scope: string }> {
    if (scope !== 'chat' && scope !== 'image' && scope !== 'video') {
      return { ok: true, scope: 'unknown' };
    }
    await this.modelConfig.reset(scope);
    return { ok: true, scope };
  }

  // ---------- 命名模型方案：多套配置，不同需求用不同模型 ----------

  @RequirePermissions('platform:billing:manage')
  @Get('profiles')
  profiles() {
    return this.modelConfig.listProfiles();
  }

  /** 把当前生效配置快照为命名方案（同名覆盖=更新该方案） */
  @RequirePermissions('platform:billing:manage')
  @Post('profiles/save')
  saveProfile(@CurrentUser() user: AuthProfile, @Body() body: { name?: string }) {
    return this.modelConfig.saveProfile(body.name ?? '', user.id);
  }

  @RequirePermissions('platform:billing:manage')
  @Post('profiles/:id/activate')
  async activateProfile(@CurrentUser() user: AuthProfile, @Param('id') id: string): Promise<{ ok: true }> {
    await this.modelConfig.activateProfile(id, user.id);
    return { ok: true };
  }

  @RequirePermissions('platform:billing:manage')
  @Delete('profiles/:id')
  async removeProfile(@Param('id') id: string): Promise<{ ok: true }> {
    await this.modelConfig.removeProfile(id);
    return { ok: true };
  }

  /**
   * Agent 集成技能包：一键复制给外部智能体（Claude / GPT / Trae / Cursor 等）使用的接入说明。
   * 纯静态模板 + 当前生效配置摘要（不含任何 Key），供「模型配置」页复制按钮使用。
   */
  @RequirePermissions('platform:billing:manage')
  @Get('agent-skillpack')
  async agentSkillPack(@CurrentUser() user: AuthProfile & { activeTenantId?: string }): Promise<{ text: string }> {
    const [chat, image, video] = await Promise.all([
      this.modelConfig.chatConfig(),
      this.modelConfig.imageConfig(),
      this.modelConfig.videoConfig(),
    ]);
    const origin = this.configOrigin();
    const text = `# 智能家居 AI 工作台 · Agent 接入技能包（Skill Pack）

你可以通过 HTTP API 驱动本工作台的全部 AI 能力。以下协议对任意智能体（Claude / GPT / Trae / Cursor / 自建 Agent）通用。

## 1. 认证
所有请求携带 JWT Bearer Token（在工作台「个人中心」登录后获取，或调用登录接口）：

\`\`\`bash
curl -X POST ${origin}/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"phone":"<手机号>","password":"<密码>"}'
# 响应 { "token": "<JWT>", "user": {...} }，token 有效期 7 天，
# 过期后重新登录或调用 POST /api/auth/refresh 刷新（携带旧 token 即可换新）。
\`\`\`

后续请求统一加：\`-H "Authorization: Bearer $TOKEN"\`

## 2. 核心能力端点

| 能力 | 方法与路径 | 请求体 | 说明 |
|---|---|---|---|
| AI 对话 | POST /api/llm/chat | {prompt, systemPrompt?} | 走当前激活模型方案（对话：${chat.baseUrl}） |
| AI 生图 | POST /api/media/images | {prompt, size?} | size=1024x1024/1536x1024/1024x1536（生图：${image.provider}） |
| AI 生视频 | POST /api/media/videos | {prompt, duration?, resolution?, ratio?, firstFrameAssetId?} | 生视频：${video.provider} |
| 智能方案 | POST /api/plans | {title, customer, ...资料字段} | 产出 9 页可编辑 PPT 方案 |
| 方案列表 | GET /api/plans | - | 历史方案（侧栏「历史对话」同款数据源） |
| 接单解析 | POST /api/orders/intake | {rawInput} | 客户原话→结构化建档+产品推荐 |
| 接单列表 | GET /api/orders | - | 接待线索与状态（了解客户→需求确认→方案匹配→报价→成单） |
| 产品库 | GET /api/products | - | 公共库+我的库合并（含分类/品牌/产品图） |
| 品类字典 | GET /api/categories | - | 39 个预置品类+租户自定义分类 |
| 我的产品 | POST /api/products/mine | {name, category, brand?, model?, sku?, barcode?, snRule?, spec?, warranty?, priceRetail?, priceDealer?, priceProject?, rebateL1?, rebateL2?, rebateDesigner?} | 标准主数据：三级价格（指导/工程/经销，元）+ 三级返利（百分比 0-100）；保存三级价自动同步参考区间 |
| 产品编辑 | PATCH /api/products/:id | 同上（字段可选） | 仅本租户行；公共库行仅允许 PATCH imageUrl |
| 产品批量处理 | POST /api/products/ai-process | {ids:[...]} | agent 补文案+批量生成产品主图 |
| 设备点位图 | POST /api/layouts | JSON（见 §3.1） | 智能体可直接把产品按坐标布到户型图上 |
| 图纸列表 | GET /api/layouts | - | 已保存的点位图（含 points 设备坐标清单） |
| 知识库检索 | POST /api/knowledge/external/search | {query} | 外部 RAG（WeKnora/Obsidian） |
| 内容提取 | POST /api/content/extractions/upload | multipart file+docType | 产品资料→结构化入库并同步产品库 |
| 素材库 | GET /api/media/assets | - | 我的资料库全部图片/视频产物 |
| 文件上传 | POST /api/media/uploads | multipart file | 图片落盘并返回 {id,url} |
| 额度查询 | GET /api/tenants/current/tokens | - | 调计费能力前自查余额（响应 402=额度不足），账本 GET /api/tenants/current/tokens/ledger |

## 3. 模型方案切换（不同任务用不同模型）

\`\`\`bash
curl ${origin}/api/admin/model-config/profiles -H "Authorization: Bearer $TOKEN"
# [{id,name,active,scopes:{chat:{hasKey},...}}, ...]
curl -X POST ${origin}/api/admin/model-config/profiles/<id>/activate -H "Authorization: Bearer $TOKEN"
\`\`\`

### 3.1 智能体自动布点（把产品放到户型平面图需要的位置）

坐标为相对户型图的归一化比例（左上角 0,0，右下角 1,1），跨分辨率稳定；productId 必须来自 GET /api/products。

\`\`\`bash
# 1) 先上传户型底图，拿 mediaAssetId
curl -X POST ${origin}/api/media/uploads -H "Authorization: Bearer $TOKEN" \\
  -F file=@floorplan.png -F title=客户户型图
# -> { id: "<mediaAssetId>", url: "/uploads/xxx.png" }

# 2) 查产品库拿 productId（公共库+我的库）
curl ${origin}/api/products -H "Authorization: Bearer $TOKEN"

# 3) 提交点位图：产品+房间语义坐标，一次最多 200 点
curl -X POST ${origin}/api/layouts -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' -d '{
    "title": "140㎡三室两厅设备点位图",
    "mediaAssetId": "<mediaAssetId>",
    "points": [
      {"productId":"<网关id>","name":"全屋网关","category":"gateway","x":0.12,"y":0.18},
      {"productId":"<门锁id>","name":"智能门锁","category":"lock","x":0.08,"y":0.92}
    ]
  }'
\`\`\`

## 4. 规则与边界
- 计费：所有 AI 端点按额度扣费（响应 402 = 额度不足）；校验失败不扣费
- 权限：需 content:generate（生成类）/ knowledge:manage（知识库）等平台权限；越权返回 403
- 数据隔离：所有读写自动限定在当前租户；公共库产品只读（可复制到我的库）
- 审计：agent 触发的检索/批量处理均写入操作留痕（AuditLog）
- 限流：全局 ${process.env.RATE_LIMIT_GLOBAL ?? 300} 次/分钟/IP，认证接口 ${process.env.RATE_LIMIT_AUTH ?? 10} 次/分钟

## 5. 典型工作流（复制给智能体作为 system prompt 片段）
「你是智能家居门店运营助手。用上面的 API 完成：1) 把客户资料 POST /api/orders/intake 建档；
2) 用 GET /api/products 选品；3) 需要图时用 POST /api/media/images 生成；
4) 做平面图设计时，先 POST /api/media/uploads 上传户型图，再 POST /api/layouts 把选好的
产品按房间语义坐标（归一化 0-1）布到对应位置（网关居中高处、门锁在入户门、水浸在厨房/卫生间低点等）；
5) 全部产物自动落库到「我的资料库」，无需本地保存。」`;
    return { text };
  }

  /** 请求来源（compose 部署即 web 容器同源地址） */
  private configOrigin(): string {
    return process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173';
  }

  /** 对话连通性测试：一条极短请求验证 Base URL 与 Key */
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
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 生图连通性测试：不产生真实图片，仅探测端点可达（comfyui=/system_stats，openai=/models，minimax=Key 已配置即通过） */
  @RequirePermissions('platform:billing:manage')
  @Post('test-image')
  async testImage(): Promise<{ ok: boolean; detail?: string; error?: string }> {
    const cfg = await this.modelConfig.imageConfig();
    try {
      if (cfg.provider === 'comfyui') {
        const res = await fetch(`${cfg.comfyBaseUrl}/system_stats`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { ok: false, error: `ComfyUI 返回 ${res.status}，请确认本机 ComfyUI 已启动且地址正确` };
        return { ok: true, detail: `ComfyUI 在线：${cfg.comfyBaseUrl}` };
      }
      if (cfg.provider === 'openai') {
        if (!cfg.apiKey) return { ok: false, error: '生图 API Key 未配置' };
        const res = await fetch(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { ok: false, error: `端点返回 ${res.status}，请检查 Base URL 与 Key` };
        return { ok: true, detail: `OpenAI 兼容端点可达：${cfg.baseUrl}` };
      }
      if (!cfg.apiKey) return { ok: false, error: 'MiniMax API Key 未配置' };
      return { ok: true, detail: 'MiniMax Key 已配置（对话连通性测试可验证同一 Key）' };
    } catch (e) {
      return { ok: false, error: `无法连接：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** ComfyUI 连通性测试：无论当前生图 provider 是谁，都直接探测 ComfyUI 地址的 /system_stats */
  @RequirePermissions('platform:billing:manage')
  @Post('test-comfy')
  async testComfy(): Promise<{ ok: boolean; detail?: string; error?: string }> {
    const cfg = await this.modelConfig.imageConfig();
    try {
      const res = await fetch(`${cfg.comfyBaseUrl}/system_stats`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, error: `ComfyUI 返回 ${res.status}，请确认本机 ComfyUI 已启动且地址正确（${cfg.comfyBaseUrl}）` };
      return { ok: true, detail: `ComfyUI 在线：${cfg.comfyBaseUrl}` };
    } catch (e) {
      return { ok: false, error: `无法连接 ComfyUI（${cfg.comfyBaseUrl}）：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 生视频连通性测试：minimax 走对话 ping 验证 Key；openai 走 GET /videos 探测端点可达 */
  @RequirePermissions('platform:billing:manage')
  @Post('test-video')
  async testVideo(): Promise<{ ok: boolean; detail?: string; error?: string }> {
    const cfg = await this.modelConfig.videoConfig();
    if (!cfg.apiKey) return { ok: false, error: '生视频 API Key 未配置' };
    try {
      if (cfg.provider === 'openai') {
        const res = await fetch(`${cfg.baseUrl}/videos`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(8000) });
        // 4xx 中 401/403 视为 Key 无效；其余（含 200/400 空列表）视为端点可达
        if (res.status === 401 || res.status === 403) return { ok: false, error: `OpenAI 返回 ${res.status}，Key 无效或权限不足` };
        return { ok: true, detail: `Sora videos 端点可达：${cfg.baseUrl}` };
      }
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { ok: false, error: `MiniMax 返回 ${res.status}，请检查 Key 与账户状态` };
      return { ok: true, detail: 'MiniMax Key 有效，可提交 T2V/I2V 任务' };
    } catch (e) {
      return { ok: false, error: `无法连接：${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
