import { Body, Controller, Delete, Get, Headers, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { brandName } from '../branding/branding.module.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { LlmService } from './llm.service.js';
import { DEFAULT_CHAT_MODEL } from './llm.constants.js';
import { ModelConfigService, type ConfigScope } from './model-config.service.js';
import { ModelCatalogService, type ModelListResult } from './model-catalog.service.js';
import { chatConfigSchema, imageConfigSchema, videoConfigSchema, modelListSchema, type ChatConfigDto, type ImageConfigDto, type VideoConfigDto, type ModelListDto } from './model-config.schemas.js';
import { describeUpstreamError } from '../common/upstream-timeout.js';

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

/**
 * ComfyUI 鉴权头：云端实例（RunPod / autodl 反代 / 自建网关）要求 Bearer，
 * 本机直连默认无鉴权（留空即完全不发该头，行为与此前一致）。
 */
function comfyHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** ComfyUI 连通探测结果文案：401/403 单独判，否则一律报"地址不对"会误导去改地址 */
function comfyProbeError(status: number, baseUrl: string): string {
  if (status === 401 || status === 403) return `ComfyUI 拒绝认证（${status}）：云端实例需在下方填写 ComfyUI API Key（${baseUrl}）`;
  return `ComfyUI 返回 ${status}，请确认 ComfyUI 已启动且地址正确（${baseUrl}）`;
}

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('admin/model-config')
export class ModelConfigController {
  constructor(
    private readonly llm: LlmService,
    private readonly modelConfig: ModelConfigService,
    private readonly catalog: ModelCatalogService,
  ) {}

  @RequirePermissions('platform:billing:manage')
  @Get()
  async status(): Promise<{ chat: ProviderView & { comfyBaseUrl?: string; workflowPath?: string }; image: ProviderView & { comfyBaseUrl?: string; comfyKeyConfigured?: boolean; comfyKeyMasked?: string | null; workflowPath?: string; promptNode?: string; negativeNode?: string; latentNode?: string; seedNode?: string }; video: ProviderView }> {
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
        model: chat.model ?? `（跟随请求，默认 ${DEFAULT_CHAT_MODEL}）`,
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
        comfyKeyConfigured: Boolean(image.comfyApiKey),
        comfyKeyMasked: maskKey(image.comfyApiKey),
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

  /**
   * 拉取对话服务商的可用模型清单（给「模型」下拉框供选）。
   *
   * body 里可以带**尚未保存**的 baseUrl / apiKey：管理员填完地址就想先看看有哪些模型，
   * 不必先点保存。不带就用服务端已保存的配置 —— 密钥只从服务端取，
   * 任何响应（含错误响应）都不含密钥明文。
   *
   * 拉不到不算保存失败：本端点是辅助能力，失败时返回明确错误码
   * （LLM_MODELS_UNSUPPORTED / LLM_MODELS_AUTH_FAILED / LLM_MODELS_FETCH_FAILED 等），
   * 前端据此提示"可手动填写"，保存配置的流程照走。
   */
  @RequirePermissions('platform:billing:manage')
  @Post('chat/models')
  async chatModels(@Body(new ZodValidationPipe(modelListSchema)) dto: ModelListDto): Promise<ModelListResult> {
    return this.catalog.listModels('chat', dto);
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
   * Agent 集成技能包：一键复制给外部智能体（任意具备 HTTP 调用能力的 AI 助手）使用的接入说明。
   * 纯静态模板 + 当前生效配置摘要（不含任何 Key），供「模型配置」页复制按钮使用。
   */
  @RequirePermissions('platform:billing:manage')
  @Get('agent-skillpack')
  async agentSkillPack(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Headers('host') host?: string,
    @Headers('x-forwarded-proto') forwardedProto?: string,
  ): Promise<{ text: string }> {
    const [chat, image, video] = await Promise.all([
      this.modelConfig.chatConfig(),
      this.modelConfig.imageConfig(),
      this.modelConfig.videoConfig(),
    ]);
    const origin = this.configOrigin(host, forwardedProto);
    const text = `# ${brandName()} · Agent 接入技能包（Skill Pack）

你可以通过 HTTP API 驱动本工作台的全部 AI 能力。以下协议对任意智能体（桌面助手、命令行工具、云端大模型平台、自建 Agent）通用。

## 0. 动手前先确认三件事（不做这三条，后面全白跑）

**① 地址**：下面所有示例里的 ${origin} 就是本工作台的当前地址，**照抄即可**。
它是按「你这次访问用的地址」算出来的；客户换域名或端口后，重新取一次技能包即可。

**② 模型密钥**：所有 AI 端点都要模型服务，没配密钥一律返回 503（LLM_KEY_MISSING）。
密钥放哪里有两条路，二选一：

- **管理员在线配置（推荐，客户自己就能做）**：打开工作台「系统管理 → 模型配置」页，
  填 Base URL 与 API Key → 点「保存配置」。存进数据库，**保存即生效，不用重启**，
  优先级高于 .env；页面上还有「测对话 / 测生图 / 测生视频」按钮可确认连通。
- **部署时写 .env（改完要重启容器）**：部署目录下的 .env 里
  \`LLM_BASE_URL\` / \`LLM_API_KEY\` / \`LLM_MODEL\`（对话，任意 OpenAI 兼容端点；
  不填则回退 \`MiniMax_BASE_URL\` / \`MiniMax_API_KEY\`）、
  \`IMAGE_PROVIDER\` / \`IMAGE_BASE_URL\` / \`IMAGE_API_KEY\` / \`IMAGE_MODEL\`（生图）、
  \`VIDEO_BASE_URL\` / \`VIDEO_API_KEY\` / \`VIDEO_MODEL\`（生视频）。
  仓库里的 .env.example 列了全部变量，也写了本地大模型（Ollama / LM Studio / vLLM）的填法。

配完用 GET /api/admin/model-config 查状态：\`keyConfigured=true\` 才算配好。

**③ 额度**：GET /api/tenants/current/tokens 查余额；AI 端点返回 402 就是额度不够。
本项目免费开源，额度由部署者按自己的模型成本设置，不涉及充值。

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

## 2. 先拿能力清单（强烈建议第一步）
能力清单是自描述的：返回全部可调用操作的路径、所需权限、风险等级与注意事项，
Agent 读它就知道自己能做什么、哪些操作会删数据，不必硬编码端点。

\`\`\`bash
# 索引模式：体积极小（几百 token），列出分组与操作摘要
curl -s "${origin}/api/agent/manifest?index=1" -H "Authorization: Bearer $TOKEN"
# 单组详情：按需拉某一组的完整操作说明（分组 id 见索引返回的 available 列表）
curl -s "${origin}/api/agent/manifest?group=quote" -H "Authorization: Bearer $TOKEN"
# 权限感知：只返回这把 Key 真的调得动的操作（换只读 Key 结果会明显变少）
curl -s "${origin}/api/agent/manifest?effective=1" -H "Authorization: Bearer $TOKEN"
\`\`\`

## 3. 核心能力端点

| 能力 | 方法与路径 | 请求体 | 说明 |
|---|---|---|---|
| AI 对话 | POST /api/llm/chat | {prompt, systemPrompt?} | 走当前激活模型方案（对话：${chat.baseUrl}） |
| AI 生图 | POST /api/media/images | {prompt, size?} | size=1024x1024/1536x1024/1024x1536（生图：${image.provider}） |
| 参考图反推提示词 | POST /api/media/images/reverse-prompt | {assetId} | 需多模态对话模型；读出参考图风格/色调/构图，输出可直接生图的中文描述，保证同风格出图 |
| AI 生视频 | POST /api/media/videos | {prompt, duration?, resolution?, ratio?, firstFrameAssetId?} | 生视频：${video.provider}；先用反推/生图拿首帧再传 firstFrameAssetId 即图生视频 |
| 智能方案 | POST /api/plans | {title, customer, ...资料字段, pageCount?} | 产出可编辑 PPT 方案。页数由 pageCount 定（9-16，默认 9）；**页数越多越吃模型输出预算**，超出模型上限会返回 PLAN_OUTPUT_TRUNCATED |
| 方案列表 | GET /api/plans | - | 历史方案（侧栏「历史对话」同款数据源） |
| 接单解析 | POST /api/orders/intake | {rawInput} | 客户原话→结构化需求（**只解析，不建档**）。返回字段与建档请求体一一对应 |
| 接单建档 | POST /api/orders | 上一步的返回值直接当请求体 | 解析完**必须再调这一步**，接单才会出现在「开始接单」列表里 |
| 接单列表 | GET /api/orders | - | 接待线索与状态（了解客户→需求确认→方案匹配→报价→成单） |
| 产品库 | GET /api/products | - | 公共库+我的库合并（含分类/品牌/产品图） |
| 品类字典 | GET /api/categories | - | 39 个预置品类+租户自定义分类 |
| 我的产品 | POST /api/products/mine | {name, category, brand?, model?, sku?, barcode?, snRule?, spec?, warranty?, priceRetail?, priceDealer?, priceProject?, rebateL1?, rebateL2?, rebateDesigner?} | 标准主数据：三级价格（指导/工程/经销，元）+ 三级返利（百分比 0-100）；保存三级价自动同步参考区间 |
| 产品编辑 | PATCH /api/products/:id | 同上（字段可选） | 仅本租户行；公共库行仅允许 PATCH imageUrl |
| 产品批量处理 | POST /api/products/ai-process | {ids:[...]} | agent 补文案+批量生成产品主图 |
| 设备点位图 | POST /api/layouts | JSON（见 §4.1） | 智能体可直接把产品按坐标布到户型图上 |
| 图纸列表 | GET /api/layouts | - | 已保存的点位图（含 points 设备坐标清单） |
| 知识库检索 | POST /api/knowledge/external/search | {query} | 外部 RAG（WeKnora/Obsidian） |
| 内容提取 | POST /api/content/extractions/upload | multipart file+docType | 产品资料→结构化入库并同步产品库 |
| 对标账号 | GET/POST /api/benchmark/accounts | {platform, accountName, homeUrl, groupTag?} | 配置要盯的对标账号（平台名自填，不限具体站点） |
| 采集契约 | GET /api/benchmark/collect-spec | - | 要采哪些字段、怎么算热度、怎么排序、保留多久 —— **Agent 按这份契约采，不要自己拍字段** |
| 提交采集内容 | POST /api/benchmark/contents | {items:[{accountId,title,text,sourceUrl,play?,like?,comment?,collect?,share?,publishedAt?}]} | 同一 sourceUrl 幂等（只更新不重复入库） |
| 热门内容 | GET /api/benchmark/contents | ?accountId=&sort=hotScore\|engagement\|views\|published | 四个排序维度可切换 |
| 映射分析 | POST /api/benchmark/analyze | {accountId?, topN?} | 把热门内容映射到自家业务，产出风格画像、场景卖点与差距清单，并投影进知识库供检索 |
| 产物库 | GET /api/media/assets | - | 我的资料库全部图片/视频产物 |
| 文件上传 | POST /api/media/uploads | multipart file | 图片落盘并返回 {id,url} |
| 额度查询 | GET /api/tenants/current/tokens | - | 调计费能力前自查余额（响应 402=额度不足），账本 GET /api/tenants/current/tokens/ledger |

> **关于对标情报的分工**：服务端**不代抓网站**（不做无头浏览器、不接管登录态）。
> 采集由**你这个 Agent** 用自带的浏览器能力完成，再按上面的采集契约把元数据 POST 回来。
> 服务端负责三件事：给字段契约、算热度与排序、把内容映射到客户自家业务并投影进知识库。
> 只采元数据与文案，不下载视频本体。

## 4. 模型方案切换（不同任务用不同模型）

\`\`\`bash
curl ${origin}/api/admin/model-config/profiles -H "Authorization: Bearer $TOKEN"
# [{id,name,active,scopes:{chat:{hasKey},...}}, ...]
curl -X POST ${origin}/api/admin/model-config/profiles/<id>/activate -H "Authorization: Bearer $TOKEN"
\`\`\`

## 5. 智能体自动布点（把产品放到户型平面图需要的位置）

坐标为相对户型图的归一化比例（左上角 0,0，右下角 1,1），跨分辨率稳定；productId 必须来自 GET /api/products。
**mediaAssetId 必填**（先上传户型底图拿 id），漏了会返回 400 VALIDATION_FAILED。

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

## 6. 规则与边界
- 计费：所有 AI 端点按额度扣费（响应 402 = 额度不足）；校验失败不扣费
- 权限：需 content:generate（生成类）/ knowledge:manage（知识库）等平台权限；越权返回 403
- 数据隔离：所有读写自动限定在当前租户；公共库产品只读（可复制到我的库）
- 审计：agent 触发的检索/批量处理均写入操作留痕（AuditLog）
- 限流：全局 ${process.env.RATE_LIMIT_GLOBAL ?? 300} 次/分钟/IP，认证接口 ${process.env.RATE_LIMIT_AUTH ?? 10} 次/分钟

## 7. 典型工作流（复制给智能体作为 system prompt 片段）
「你是智能家居门店运营助手。用上面的 API 完成：1) 把客户资料 POST /api/orders/intake 建档；
2) 用 GET /api/products 选品；3) 需要图时用 POST /api/media/images 生成；
4) 做平面图设计时，先 POST /api/media/uploads 上传户型图，再 POST /api/layouts 把选好的
产品按房间语义坐标（归一化 0-1）布到对应位置（网关居中高处、门锁在入户门、水浸在厨房/卫生间低点等）；
5) 全部产物自动落库到「我的资料库」，无需本地保存。」

「你是内容情报助手。1) GET /api/benchmark/collect-spec 拿到采集契约（字段、热度公式、排序维度、保留期）；
2) 用你自带的浏览器能力打开对标账号主页，滚动加载拿到热门内容的标题、正文与互动数；
3) POST /api/benchmark/contents 提交（带 accountId 与 sourceUrl，同一链接重复提交只更新不重复入库）；
4) GET /api/benchmark/contents?sort=hotScore 取当前最热的一批；
5) POST /api/benchmark/analyze 让系统把内容映射到门店自家业务，产出风格画像、场景卖点与差距清单；
6) 结论已自动进知识库，后续可用 POST /api/knowledge/docs/search 检索本地资料。

## 8. 遇到问题怎么办（提交给作者仓库）

**第一步：在本系统里留一条** —— 租户内的工单，本租户管理员能跟踪状态与回复：
POST /api/feedback { "category": "bug|feature|other", "title": "一句话描述", "detail": "详细情况（可选，≤2000字）" }

**第二步：提交到作者仓库** —— 作者在这里集中处理所有部署提上来的问题：
GET /api/feedback/{id}/issue-link → { "url": "...", "repo": "...", "title": "...", "body": "..." }
\`url\` 是 GitHub「新建 issue」的预填链接：标题与详情已经填好、仓库地址已经带上。
把它交给客户点开提交，或你有浏览器能力就自己打开提交。

**两步都要做**：第一步让本租户的管理员知道，第二步让作者知道。
只做第一步的话，作者在仓库里看不到这个问题。`;
    return { text };
  }

  /**
   * 技能包里的示例地址（origin）。
   *
   * 优先级：显式配置 > **从当前请求推导** > 开发缺省值。
   *
   * 为什么必须能从请求推导：
   *  - 客户从 `https://work.example.com` 访问，光靠 `PUBLIC_ORIGIN` 一旦没配，
   *    技能包里的示例就是 `http://localhost:5173` —— 客户拿自己的智能体去调，
   *    调的是**他自己机器上的 5173 端口**，必然连不上；
   *  - 桌面端的 API 端口是**每次启动随机**的（60988/60989…），
   *    `PUBLIC_ORIGIN` 根本填不出来，只能靠「这次请求打到了哪个 host」反推。
   *
   * 所以：**客户从哪个地址访问，智能体拿到的就是哪个地址**。
   */
  private configOrigin(host?: string, forwardedProto?: string): string {
    const configured = process.env.PUBLIC_ORIGIN?.trim();
    if (configured) return configured.replace(/\/+$/, '');
    if (host) {
      // 反向代理/ CDN 会把原始协议放在 x-forwarded-proto，可能是 "https,http" 这样的链，取第一个
      const proto = (forwardedProto ?? '').split(',')[0].trim() || 'http';
      return `${proto}://${host}`;
    }
    return 'http://localhost:5173';
  }

  /** 对话连通性测试：一条极短请求验证 Base URL 与 Key */
  @RequirePermissions('platform:billing:manage')
  @Post('test-chat')
  async testChat(): Promise<{ ok: boolean; model?: string; latencyMs?: number; error?: string }> {
    try {
      const r = await this.llm.chat({
        model: DEFAULT_CHAT_MODEL,
        prompt: 'ping',
        systemPrompt: '只回复 pong 两个字母，不要其他内容。',
        maxTokens: 16,
      });
      return { ok: true, model: r.model, latencyMs: r.latencyMs };
    } catch (e) {
      // Node 的原始报错是 "fetch failed"，直接给管理员看等于没给信息
      const d = describeUpstreamError(e, 'LLM', '对话模型服务', 15000);
      return { ok: false, error: d ? d.message : (e instanceof Error ? e.message : String(e)) };
    }
  }

  /** 生图连通性测试：不产生真实图片，仅探测端点可达（comfyui=/system_stats，openai=/models，minimax=Key 已配置即通过） */
  @RequirePermissions('platform:billing:manage')
  @Post('test-image')
  async testImage(): Promise<{ ok: boolean; detail?: string; error?: string }> {
    const cfg = await this.modelConfig.imageConfig();
    try {
      if (cfg.provider === 'comfyui') {
        const res = await fetch(`${cfg.comfyBaseUrl}/system_stats`, { headers: comfyHeaders(cfg.comfyApiKey), signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { ok: false, error: comfyProbeError(res.status, cfg.comfyBaseUrl) };
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
      const d = describeUpstreamError(e, 'IMAGE', '生图服务', 8000);
      return { ok: false, error: d ? d.message : `无法连接：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** ComfyUI 连通性测试：无论当前生图 provider 是谁，都直接探测 ComfyUI 地址的 /system_stats */
  @RequirePermissions('platform:billing:manage')
  @Post('test-comfy')
  async testComfy(): Promise<{ ok: boolean; detail?: string; error?: string }> {
    const cfg = await this.modelConfig.imageConfig();
    try {
      const res = await fetch(`${cfg.comfyBaseUrl}/system_stats`, { headers: comfyHeaders(cfg.comfyApiKey), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, error: comfyProbeError(res.status, cfg.comfyBaseUrl) };
      return { ok: true, detail: `ComfyUI 在线：${cfg.comfyBaseUrl}` };
    } catch (e) {
      const d = describeUpstreamError(e, 'IMAGE', 'ComfyUI 服务', 8000);
      return { ok: false, error: d ? d.message : `无法连接 ComfyUI（${cfg.comfyBaseUrl}）：${e instanceof Error ? e.message : String(e)}` };
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
        body: JSON.stringify({ model: DEFAULT_CHAT_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { ok: false, error: `MiniMax 返回 ${res.status}，请检查 Key 与账户状态` };
      return { ok: true, detail: 'MiniMax Key 有效，可提交 T2V/I2V 任务' };
    } catch (e) {
      const d = describeUpstreamError(e, 'VIDEO', '生视频服务', 15000);
      return { ok: false, error: d ? d.message : `无法连接：${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
