# CHANGELOG

本项目遵循语义化版本（SemVer）。0.x 阶段 API 不做稳定性承诺。

## [0.1.28] - 2026-10-09

### Added（全局返回能力：任何子页面都能返回）

用户指出视频素材库「查看素材」点击后无法返回，要求任何可点击的菜单界面都要支持返回。

- **顶栏全局返回按钮** [MainLayout.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/layouts/MainLayout.tsx)：非工作台页一律显示「← 返回」（有历史 navigate(-1)，直达无历史回工作台），覆盖全部 15 个功能页
- **素材预览改应用内弹窗** [MaterialLibrary.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/MaterialLibrary.tsx)：「查看素材」不再 `window.open` 跳独立图片页（离开应用无法返回），改为 Modal 大图预览 + 底部「返回素材库」按钮，关闭即回列表 URL 不变

### Changed（个人中心布局标准化 + 全站布局执行标准）

用户批评个人中心卡片全挤左侧、层次不一。确立全站页面布局执行标准并落地：

- **布局标准**：① 顶层容器统一 `width:100%` 流式（0.1.25 已定）；② 功能页一律 PageHeader（标题+描述+右上操作区）；③ 多卡片页用 `Row gutter=[16,16] + Col xs=24 lg=12` 双栏网格、卡片 `height:100%` 等高，账本/表格类全宽收尾；④ 网格容器统一 16px 间距；⑤ 所有二级视图（弹窗/详情）必须提供应用内返回入口
- **TokenCenter 重排** [TokenCenter.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/TokenCenter.tsx)：账号卡全宽 → 行1「资料与偏好 + 我的额度」→ 行2「邀请好友 + 数据备份与存储治理」→ 行3「修改登录密码 + 账号安全（退出登录）」→ 账本明细全宽；1920 实测左右各 781px 等宽，768 自动单列堆叠

### Verified

- 门禁：typecheck + build + 冒烟 **88/88**（纯前端改动）
- 浏览器实测 5 项全 PASS：顶栏返回按钮（/products、/materials 实测回退，首页不显示）、素材预览弹窗可返回（URL 不变）、/tokens 双栏等宽网格（1920 各 49.5% / 768 单列无溢出）、**15 页逐页布局审查**（标题区正常、内容铺满 rightGap=0、间距统一 16、全页无横向溢出）、真实 Chrome 全程 console 0 error/warning

## [0.1.27] - 2026-10-09

### Changed（产品图方形裁切 + 全站导航文案统一）

用户指出产品图应正方形（比例不对要裁切），并要求各板块文字统一：AI 能力→AI 超能力、智能方案生成→智能方案、我的资料→我的资料库、优秀视频素材库→视频素材库、"资源与账户"并入"系统管理"（含个人中心 + 模型配置）。

- **方形裁切** [compress.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/compress.ts)：`compressImage(file, { square: true })` 等比 cover 后中心裁切为正方形（短边对齐 1024，小图不放大）——产品主图/点位图标 1:1 口径统一；户型图保持 `square: false` 原始比例（非方形图裁切会破坏户型）。实测 2400x1600 源图：产品图 → 1024x1024，户型图 → 1024x683
- **导航文案** [MainLayout.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/layouts/MainLayout.tsx)：分组重构为「AI 超能力 / 智能百宝箱 / 系统管理」三组；模型配置仍按 `platform:billing:manage` 权限动态加入系统管理组（个人中心人人可见）；页面标题与提示文案同步（MyAssets/MaterialLibrary 标题、ImageStudio/VideoStudio 的「我的资料」引用、README）

### Fixed

- /works 视频缩略 `<video>` 加 `preload="metadata"`，消除历史条目预加载被取消产生的 `net::ERR_ABORTED` 控制台日志（复验 5 路由 0 error、/file 请求 0 次 ABORTED）

### Verified

- 门禁：typecheck + build + 冒烟 **88/88**（纯前端改动）
- 浏览器实测 5 项全 PASS：侧栏三组文案、页面标题、产品图方形裁切（1024x1024）、户型图保持 3:2、console 应用自身 0 error/warning（trae-preview 注入脚本的 `<anonymous>` TypeError 与应用无关）
- 运行状态：docker stats 内存 api 139MB / web 10MB / db 50MB / redis 12MB 正常；api 日志 0 error/warn、web 访问日志 0 次 4xx/5xx

## [0.1.26] - 2026-10-09

### Fixed（传图不成功根因）

用户报告产品传图失败。根因两处：① [nginx.conf](file:///Volumes/hasskit/codex/aisaas/apps/web/nginx.conf) 未设 `client_max_body_size`（默认 1m），手机照片普遍 >1MB 被反代直接 413 拒绝，Nest 侧 10MB 限制形同虚设——`/api/` 加 `client_max_body_size 12m`；② [api.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/api.ts) 封装无条件 `response.json()`，DELETE 等空响应体抛 `Unexpected end of JSON input`（分类删除报错的根因）——先 `text()` 空体返回 undefined。实测经 nginx 上传 1.25MB PNG 返回 201。

### Added（图片压缩 + lucide 图标库 + 品类字典 + 品牌管理 + 知识库联动）

- **上传压缩** [compress.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/compress.ts)：canvas 原生实现（零依赖），最长边 >1024 或体积 >800KB 时等比缩放（PNG 保透明、其余转 JPEG q0.85）；产品图与户型图上传前统一压缩，缩略图实测 naturalWidth=1024
- **图标库升级** [product-icons.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/product-icons.ts)：自绘 9 类 path 换为 [lucide](https://lucide.dev)（ISC 许可证免费商用）24 个物体样式线条图标（网关/路由/开关/面板/传感/人体存在/水浸/温湿度/灯/窗帘/门锁/摄像头/报警/家电/厨卫/扫地机/晾衣/音响/投影/暖通/循环扇/灌溉/宠物/插座），按需显式导入（包体 +0.09MB 而非全量 2129 图标）；stroke 渲染经 dataURL 进 canvas，预览/PNG/PPTX/分享四端一致
- **品类字典**：新表 `CategoryDef`（migration `category_def`；tenantId=null 预置 24 类，非空=租户自定义），[category-defs.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/layout/category-defs.ts) 单一事实源；`Product.category` 从 9 值 enum 放宽为自由字符串 + service 层白名单校验（未知品类 400 CATEGORY_INVALID）；旧 `security` 归并 `camera`（seed 迁移存量行 + 前端 LEGACY 映射兜底）；端点 `GET /api/categories`、`POST /categories/mine`（同名幂等）、`DELETE /categories/:id`（预置不可删、在用拒绝 CATEGORY_IN_USE）；备份清单纳入 categoryDef
- **前端 categoryStore**：字典单例 + 预置兜底（加载失败不阻塞），分类筛选/表单选项/表格徽章/点位分组全部中文化并支持自定义分类；「分类管理」弹窗可增删自定义分类（图标从 24 预置图标选择、颜色 ColorPicker）
- **品牌管理**：产品列表新增品牌筛选下拉（从现有产品 distinct 生成）；新增/编辑弹窗品牌改 AutoComplete（选已有或输入新品牌）
- **知识库 <-> 产品中心联动** [product-sync.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/layout/product-sync.ts)：「内容提取」product 类文档确认入库（人工 confirm 与自动确认两条路径）时按 name+租户查重同步到我的产品库——价格解析（¥/区间/千分位）、品类关键词推断（24 类中文关键词，兜底 appliance）、卖点/规格进布置提示；失败降级 warn 日志不阻塞提取链路
- **ai-process 品类归位**：agent 批量处理的 chatJson 提示词带品类字典，LLM 返回字典内 key 时自动修正产品分类（公共库行仍不改）

### Verified

- 门禁：typecheck + build + 冒烟 **88/88**（+10：品类字典 24 类/自定义分类 CRUD/同名幂等/产品用自定义分类/在用删除 400/预置不可删/知识库产品自动同步/品类推断非空）
- 浏览器实测：侧栏「产品中心」入口、24 中文分类下拉、分类管理增删（删除修复复验 PASS）、品牌筛选+AutoComplete、1.25MB 传图成功且压缩生效（naturalWidth=1024）、点位 lucide 线条图标（stroke-width=2 白色描边）、/content 正常、768/2560 无横向溢出、console 0 error

## [0.1.25] - 2026-10-09

### Changed（全站流式布局：卡片随视口拉宽铺满，杜绝宽屏留白）

用户两次指出宽屏响应式不达标：各页卡片忽宽忽窄，且拉宽窗口后卡片左右出现大片留白，要求"4K 也把卡片拉到对应宽度、每个板块统一、不可留白"。

- **根因**：各页顶层容器混用 `maxWidth 1080/1180/1280/全宽`，即便统一为 1380 居中，超宽视口下仍两侧留白
- **新基线** [tokens.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/theme/tokens.ts)：`pageContainerStyle` 去掉一切 maxWidth 封顶（`width:100%`），卡片/表格/网格一律铺满内容区（视口 − 侧栏 280 − 左右 padding 48），随视口等比拉宽；MainLayout 统一提供 padding，页面不再各自限宽
- **逐页放开**：ProductCenter/TokenCenter/ModelConfig/OrderStudio（原 1180/1280 居中）改 `pageContainerStyle`；MyAssets/QuoteStudio/AgentMarket/TreasureBox/DeviceLayout/ContentExtract 内联容器去封顶；Dashboard 内容区 `100%`；ImageStudio/VideoStudio 双列改 `flex: 1 1 46% / 54%` 随视口铺满（原右列锁死 460/420）；PlanStudio 步骤条去 1080 限宽；ContentExtract 表单去 720/820 限宽
- **保留合理窄元素**：表单输入框、TokenCenter 改密表单、Biography 引导等"内容本身就该窄"的元素仍限宽，但确保其父卡片 width:100% 铺满；PlanShareView 客户分享页幻灯片保持 960 居中（打印/微信阅读场景，非工作台板块）

### Added（产品中心补齐：侧栏入口 + 每产品可换图 + agent 批量处理）

- **侧栏入口** [MainLayout.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/layouts/MainLayout.tsx)：「AI 能力」分组新增「产品中心」菜单项（ShopOutlined），selectedKey 同步；此前只能从百宝箱卡片进入
- **每个产品可换图**：公共库行操作列新增「传图」按钮（`quickUploadImage` 直传 PNG/JPG/WebP 替换产品主图=点位图标），我的库行编辑弹窗含上传区；后端 [layout.service.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/layout/layout.service.ts) `updateProduct` 放宽——公共库行仅允许改 `imageUrl`（改文案返回 400），其余字段仍租户隔离
- **公共产品图跨租户可读** [media.service.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.service.ts)：新增 `resolveReadable`，文件流端点改用之——本租户资产放行，被任一启用产品 `imageUrl` 引用的资产跨租户可读（公共库对所有租户展示）
- **agent 批量处理** `POST /api/products/ai-process`：勾选产品（我的库/公共库均可，单次 ≤20）一次完成 ① `LlmService.chatJson` 批量补全缺失的品牌/型号/布置提示（仅我的库行写回）② 生图 provider 逐个生成白底产品主图（产品图即点位图标）；单个失败不阻塞其余，生图 key 未配置诚实降级为仅文案；全程写 `AuditLog`（action=product.ai-process）；前端「AI 批量处理」按钮带勾选计数 + 确认弹窗 + 结果提示
- **存储治理** [backup.controller.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/admin/backup.controller.ts)：清理未引用产物时把产品主图资产纳入引用集，防 30 天后误删

### Fixed

- `generateImage` 扣费前校验 API Key（原先扣后校验，批量生图失败会白扣额度，违反"校验在扣费前"硬约束）

### Verified

- 门禁：typecheck + build + 冒烟 **78/78**（+6：公共库改文案 400 / 公共库换图 200 / ai-process 空勾选 400 / 勾选不存在 404 / 公共产品图跨租户读取 404→200）
- 浏览器实测四档视口（768/1440/1920/2560）：/order 双栏合计铺满内容区（640+1576+16=2232）、/products 等 10 页主卡片宽 2217~2232 占内容区约 97%、无任何居中留白、全档无横向溢出、console 0 error

## [0.1.24] - 2026-10-09

### Added（产品中心独立板块：公共库/我的库双 tab + 产品图=点位图标 + 设置入口统一）

用户登录参考站实地审查后指出两点：底部「设置」不应重复造轮子弹弹窗、应与个人中心统一；图标库（产品中心）没有独立界面，要求对齐参考站的呈现与联动方式。

- **数据层租户化** [schema.prisma](file:///Volumes/hasskit/codex/aisaas/apps/api/prisma/schema.prisma)：`Product` 新增 `tenantId`（null=公共库）、`brand`/`model`/`unit`/`imageUrl`（产品主图），`name` 去全局 unique 改应用层查重（migration `product_tenant_fields`）；seed 改 findFirst+update/create 幂等
- **后端 products 全链路** [layout.service.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/layout/layout.service.ts)：`GET /api/products` 合并公共+我的（布点/报价选品数据源不变）；新增 `POST /products/mine`、`PATCH /products/:id`、`DELETE /products/:id`（findFirst {id,tenantId} 租户隔离，公共库行不可改删）、`POST /products/:id/copy-to-mine`（对齐参考站"复制到我的库"联动规则）；重名/非法品类返回 400
- **产品中心页** [ProductCenter.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/ProductCenter.tsx)：`/products` 路由 + 百宝箱「公共库与我的库」卡直达；公共库/我的库双 tab（带计数）、搜索+分类筛选、表格列（缩略图/名称/分类/品牌型号/参考价/布置提示/操作）、新增/编辑 Modal 含产品图上传（走 `/api/media/uploads`）、复制到我的库、顶部「智能报价/设备点位」联动入口
- **产品图=点位图标**（参考站核心模式）：布点时携带产品 `imageUrl` 存为点位 `iconUrl`；[pointOverlay.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/pointOverlay.ts) `compositePoints` 有图点位圆形裁剪绘制产品照片（白底 cover），无图/加载失败回退 0.1.23 品类 SVG；DeviceLayout 画布 DOM 点位同步。预览/PNG/PPTX/分享四端共用合成函数，全端一致

### Changed（设置入口统一，消灭重复轮子）

- 侧栏底部「设置」与顶栏「个人设置」→ 直接跳转 `/tokens` 个人中心，不再弹独立弹窗
- [TokenCenter.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/TokenCenter.tsx) 迁入原弹窗全部能力：「资料与偏好」卡（昵称/头像色 ColorPicker/主题三选/保存资料）+「数据备份与存储治理」卡（全库 JSON 导出/产物占用/清理 30 天前未引用产物，管理员可见）；删除 `ProfileSettings.tsx` 组件

### Verified

- 门禁：typecheck + build + 冒烟 **72/72**（+10：我的库 CRUD/应用层查重/复制到我的库/重复复制拒绝/编辑公共库 404 租户隔离/合并列表/删除后不可见/非法品类）
- 浏览器实测（1440/1920/768）：产品中心双 tab 计数、复制到我的库+1、新增弹窗含产品图上传、设置入口跳 /tokens、个人中心昵称保存成功、点位编辑器产品分组渲染、三档无横向溢出、console 0 error
- 修复部署回归：api 容器镜像仍为旧 seed（`product.upsert` 撞已删除的 name 唯一约束导致重启循环），`docker compose build api web` 重建后恢复

## [0.1.23] - 2026-10-08

### Added（产品图标库 + 户型图美化：补齐 PPT 空间动线页的图标布点表达）

用户指出产品图标库未开发，导致 PPT 方案的空间动线页只有圆点没有产品图标，且缺少"客户平面图上传→美化→按产品布图标"的完整链路。

- **产品图标库** [product-icons.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/product-icons.ts)：9 品类（网关/开关/传感器/灯光/窗帘/安防/家电/影音/暖通）内联 SVG 图标（24x24 viewBox，零外部依赖、可缩放），`categoryIconSvg()` 供 React 渲染、`categoryIconDataUrl()` 供 canvas 绘制
- **点位合成升级** [pointOverlay.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/pointOverlay.ts)：`compositePoints` 的彩色圆底从"首字"改为**白色品类图标**（按点位品类去重预加载）；`compositeLightPlan`（灯光徽章）与 `compositeHeatmap`（WiFi 信号源）同步换图标。由于预览（PlanSlide）、PNG 导出（DeviceLayout）、**PPTX 导出（planPptx）**、免登录分享页四端共用同一合成函数，图标自动全端一致
- **点位编辑器 UI**：DeviceLayout 画布 DOM 点位与右侧产品库列表按钮均渲染品类图标（彩色圆底+白色图标 / 品类色图标+名称）
- **户型图美化**：`enhanceFloorplan()` canvas 确定性增强（白底化 + 2% 截断对比度拉伸 + 中间调 S 曲线），DeviceLayout 新增「美化图纸」按钮——增强后重新入库替换底图，归一化点位不受影响。**刻意不用 AI 重绘**：AI 生图会篡改墙体位置与房间尺寸，对销售交付是危险的；需要 AI 彩平示意稿时走「AI 生图」板块自行生成（诚实边界，代码注释说明）

### Docs

- README 新增「知识库联动优势与场景」小节：对接 WeKnora/Obsidian 后，对话回答引用客户私有资料更准、接单 intake 能识别客户资料中的品牌型号、方案生成文案贴合客户话术库、检索失败自动降级不阻塞

### Verified

- 门禁：typecheck + build + 冒烟 **62/62**（图标为纯前端渲染层，无后端变更）
- 浏览器实测（/device-layout，1440/1920/768）：产品库 20 个按钮带 9 类彩色图标、布点画布为圆底+白色品类图标（DOM 验证 path fill=#ffffff 且无首字文本）、美化图纸成功替换底图且点位保留、导出 PNG 正常、三档无溢出、console 0 error

## [0.1.22] - 2026-10-08

### Added（外部知识库联动：兼容 WeKnora / Obsidian，各板块 agent 检索注入）

用户要求知识库支持客户本机部署的专业引擎（腾讯开源 WeKnora 或 Obsidian），电脑性能足够即可拉取最新仓库自行部署，让知识库真正发挥优势，且每个板块都能通过接口调用 agent 联动、权限合理、操作留痕。联网学习 WeKnora（Tencent/WeKnora，Go，REST `X-API-Key` 认证，`knowledge-search` 端点）与 Obsidian Local REST API（Bearer 认证，`/search/simple` + `/vault/{path}`）的接口协议，采用**纯 HTTP 适配器**接入（不引入任何框架/依赖，YAGNI + 许可证合规，与 ComfyUI 接入模式一致）。

- **双适配器** [knowledge-adapter.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/knowledge/knowledge-adapter.ts)：`searchWeknora`（`POST {base}/knowledge-search`，支持 `knowledge_base_ids` 限定库）、`searchObsidian`（`POST /search/simple?query=` 命中后回退 `GET /vault/{path}` 拉正文），统一返回 `KnowledgeChunk[]`；`pingExternalKnowledge` 连通探测（weknora=`GET /knowledge-bases`、obsidian=`GET /`，401/403 判 Key 无效）；`formatKnowledgeContext` 把片段拼为注入 system prompt 的参考上下文（最多 5 段、每段 1600 字）
- **配置持久化**：`ModelSetting` 新增 `knowledge` scope（provider/baseUrl/apiKey/kbIds/enabled），沿用 DB>.env、Key 只进不出（短掩码）、保存即生效、恢复 .env 默认；`.env` 提供 `KNOWLEDGE_PROVIDER` / `WEKNORA_*` / `OBSIDIAN_*` 模板，compose 透传并加 `extra_hosts: host.docker.internal:host-gateway` 让容器能访问宿主机上的 WeKnora/Obsidian/ComfyUI
- **各板块 agent 联动**（RAG 注入）：`LlmService` 新增 `RagContext` 入参，`chat`/`chatObject`/`chatJson` 传入 rag 时自动检索外部库并拼进 system prompt；已接入对话（`/api/llm/chat`）、接单 AI 解析（`order-intake`）、智能方案生成（`plan`）三条链路。**检索失败降级为无知识库模式**（异常上抛→捕获→空串 + warn 日志），主链路绝不因外部库不可用而中断
- **权限与留痕**：`/api/knowledge/external`（GET/PUT/DELETE/test/search）要求 `knowledge:manage` 权限（tenant_admin 具备、viewer 拒绝），检索按租户隔离；每次检索（含 agent 联动与降级）写 `AuditLog`（action=`knowledge.search`，target 记录场景+命中数/degraded）
- **前端知识库页**新增「外部知识库联动」卡：provider 单选（不使用/WeKnora/Obsidian，切换自动填默认地址）、服务地址 + API Key（留空保持不变）+ WeKnora 知识库 id 限定、保存/连通测试/恢复默认、检索演示（List 展示命中片段带来源标签）、启用开关；Alert 内嵌两引擎的部署指引（git clone + docker compose / 插件安装 + Key 获取位置）

### Fixed

- 实测反馈修复：provider 选「不使用」时增加「保存（关闭联动）」与「恢复 .env 默认」按钮（原无法经 UI 落库关闭）；检索空结果提示区分「启用开关未开」与「无命中」

### Verified

- 门禁：typecheck + build + 冒烟 **62/62**（新增 6 用例：外部库配置保存+Key 脱敏、响应不含明文、连通诚实报不可达、不可达检索 503、非法 provider 拒绝、恢复默认回退 none）
- 协议级验证：本机起 mock（模拟 WeKnora/Obsidian 协议），curl 经 `host.docker.internal:18099` 端到端跑通双适配器——WeKnora 返回"可见知识库 2 个"+命中片段、Obsidian 返回"在线"+笔记片段
- 浏览器实测（1440/1920/768）：WeKnora/Obsidian 配置→连通→检索命中→刷新持久化→恢复默认全流程通过，三档无横向溢出，console 0 error

## [0.1.21] - 2026-10-08

### Added（开始接单板块完整开发：AI 接待工作台）

联网调研 GitHub 开源 CRM（Twenty CRM、NextCRM、Headless CRM）的销售线索 pipeline 设计模式（均为 NestJS/Prisma/TypeScript 技术栈），**复用自有 NestJS + Prisma + LlmService 栈在项目内自建，不引入外部框架**（YAGNI + 许可证合规）。

- **数据层**：Prisma 新增 `OrderRequest`（客户/电话/小区/面积/户型/需求要点/原始描述/预算/生态偏好/状态/挂接方案 planId/失单原因）与 `OrderNote`（跟进纪要，级联删除），migration `add_order_requests`；新表纳入全库备份清单
- **状态机**：`new 了解客户 → qualified 需求确认 → proposed 方案匹配 → quoted 报价 → won 成单`，任意非终态可转 `lost`（记录失单原因）、lost 可重新激活回 new；非法跳跃（如 new→won）返回 400 `ILLEGAL_TRANSITION`
- **AI 接待解析 intake**（`POST /api/orders/intake`）：把客户微信原话/电话纪要等原始描述粘贴进来，`LlmService.chatObject` 抽取为结构化字段 + 需求要点 + 建议品类，再按品类从 `Product` 产品库查真实候选（非 LLM 幻觉）；**解析成功才扣额**（`BILLING_ORDER_INTAKE_TOKENS`，LLM 失败异常上抛不白扣）
- **AI 跟进建议**（`POST /api/orders/:id/followup`）：基于当前阶段 + 需求 + 最近 5 条跟进，生成下一步动作与话术要点（`BILLING_ORDER_FOLLOWUP_TOKENS`）
- **REST API**（`/api/orders`，权限 `order:manage`，tenant_admin / operator 具备）：列表 / 详情 / 创建 / 更新 / 状态流转 / 加跟进 / 删除；数据按租户隔离
- **前端 OrderStudio 从纯 UI 壳重写为真实工作台**：左侧接待列表按状态分组（Badge 计数）点击直达、右侧步骤条向导（五阶段进度可视化）、新接待弹窗（粘贴原始描述 → AI 解析建档 → 核对补全保存，展示推荐品类与候选产品）、跟进记录 Timeline、AI 跟进建议 Alert、方案匹配阶段挂接已生成的智能方案（复用 `GET /api/plans` 下拉）、失单/重新激活操作；移除原"0.3.0 上线"占位警告

### Verified

- 门禁：typecheck + build + 冒烟 **56/56**（新增 10 用例：创建 status=new、列表可查、非法跳跃 400、合法五步流转、跟进写入、详情 404、缺客户名校验、删除后 404、viewer 访问 403、tenant_admin 访问 200）
- 浏览器实测：A-J 全部通过——AI 解析建档（真实 MiniMax ~10s 返回，识别网关/照明/窗帘/安防 + 8 个候选产品）、状态机五步流转（new→qualified→proposed→quoted→won）+ 失单/重新激活、跟进记录 + AI 建议（~20s）、持久化刷新不丢、三档视口无溢出、console 0 error

## [0.1.20] - 2026-10-08

### Fixed（根治 /model-config 加载报错）

- **SyntaxError: missing ) after argument list + ERR_ABORTED**：根因是发版重建后浏览器命中旧 `index.html` 缓存，引用已失效的 hash chunk，SPA fallback 把 HTML 当 JS 返回导致解析报错。`nginx.conf` 给 `/index.html` 与 SPA 回退加 `Cache-Control: no-cache, no-store, must-revalidate`（带 hash 的 `/assets/` 仍 30d immutable），实测硬刷新 console 0 error/warning

### Added（开源自部署默认最高权限 + 个人设置 + 数据备份 + 磁盘治理）

- **模型配置默认对租户管理员开放**：`tenant_admin` 角色补 `platform:billing:manage` 权限（seed 幂等更新）。开源自部署每个用户都要配自己的 API Key/本地模型，注册即建租户并默认获得完整配置能力；会员/角色机制保留（viewer 等仍按 RBAC 隔离，冒烟用 viewer 验证 403）。前端权限判断由"仅 super_admin"改为按 `platform:billing:manage` 动态匹配，侧栏「系统管理」菜单随之对 tenant_admin 可见
- **侧栏个人卡三操作真实化**：头像可点（跳个人中心）+ 显示自定义底色；「设置」图标从原来的"循环切主题"升级为完整「个人设置」弹窗（`ProfileSettings`）——昵称/头像颜色（ColorPicker）/界面主题三选/修改密码，`PATCH /api/auth/profile` 持久化 `User.avatarColor`（Prisma 迁移 `add_user_avatar_color`）；「退出」保留 Popconfirm 确认。顶栏用户菜单同步加「个人设置」入口
- **数据备份**：`GET /api/admin/backup`（管理员）导出全库 18 表 JSON 快照并浏览器下载，同时在 `uploads/backups/` 留底，供升级迁移前保存；个人设置弹窗内置「导出全库数据备份」按钮
- **磁盘治理**：`GET /api/admin/storage` 产物占用/配额统计（`UPLOAD_QUOTA_MB` 默认 4096）；`POST /api/admin/storage/cleanup?beforeDays=N` 删除 N 天前且未被方案户型图/点位布局引用的产物（DB 行 + 本地文件），弹窗一键清理带二次确认，防长期运行挤爆磁盘
- **限流可配**：全局 `RATE_LIMIT_GLOBAL`（默认放宽到 300/min，自部署单机友好）、认证 `RATE_LIMIT_AUTH`（默认 10/min），compose 透传；docker-compose 给 api/web 加 `json-file` 日志轮转（10m×3）防日志无限增长

### Verified

- 门禁：typecheck + build + 冒烟 **46/46**（新增 个人设置保存/非法头像色拒绝/全库备份导出/存储统计/清理端点/viewer 访问备份 403 用例；原"普通用户 403"用例因 tenant_admin 已获权限，改用 viewer 角色验证 RBAC）
- 浏览器实测（1440/1920/768）：硬刷新 console 0 error；设置弹窗改昵称+头像色即时生效、主题切换、导出备份下载、清理确认、退出跳转全流程通过；新注册用户默认可见并可用「模型配置」四卡 + 备份按钮（默认最高权限成立）；三档无横向溢出

## [0.1.19] - 2026-10-08

### Added（生视频 provider 可选 + ComfyUI 配置常驻可见）

- **生视频不再写死 MiniMax**：`VIDEO_PROVIDER=minimax | openai`（WebSearch 核实 OpenAI Sora 2 videos API：`POST /videos → 轮询 GET /videos/{id} → GET /videos/{id}/content` 下载，seconds/size 参数映射自现有 时长/画质/比例）。新建 `video-provider.ts` 双路由适配（`generateViaMinimaxVideo` / `generateViaOpenaiVideo`），`VideoRuntime` 加 provider/model 字段，`generateVideo` 按 provider 分发；前端生视频卡加 Provider 单选（MiniMax Director / OpenAI Sora），标题动态显示当前 provider，模型名可填（sora-2 等），连通测试按 provider 探测（openai 走 `GET /videos`，401/403 判 Key 无效）
- **ComfyUI 配置提升为独立常驻卡片**：此前藏在生图 provider 切到 ComfyUI 后才显示，可发现性差；现在「ComfyUI 本地生图（工作流配置）」卡始终可见（地址/工作流 JSON/四节点映射 + 保存 + 专属 `POST test-comfy` 探测 `/system_stats`，与当前生效 provider 无关），生图卡选 ComfyUI 时出现指向该卡的引导提示
- 概览 API 三能力均返回 `providerKey` 机器键，前端表单绑定不再靠显示文案反推；compose 透传 `VIDEO_*` 四个 env；`.env.example` 生视频段改双 provider 模板

### Verified

- 门禁：typecheck + build + 冒烟 **40/40**（新增"生视频 provider 切换 openai(sora) 持久化""ComfyUI 独立配置持久化"用例）
- curl 真实 key：`test-video`（MiniMax Key 有效）、`test-image`（minimax 路径通过）、`test-comfy` 诚实报"无法连接 ComfyUI"（本机未运行，符合预期）
- 浏览器实测（1440/1920/768）：生视频卡 provider 切换→保存（标题动态变 Sora、Key 掩码）→连通测试失败态→恢复默认回退全流程通过；ComfyUI 常驻卡六字段齐全可编辑；三档无横向溢出；console error 0

## [0.1.18] - 2026-10-08

### Added（模型配置在线可编辑：从"只读 .env 展示"升级为"DB 持久化 + 即时生效"）

- **ModelSetting 表**（Prisma 迁移 `add_model_settings`）：chat/image/video 三条 JSON 配置行，管理员在页面上的修改持久化到数据库，重启不丢失；配置优先级 **DB（在线保存）> .env（部署者默认）**
- **ModelConfigService 统一解析层**：`LlmService`/`MediaService` 生成链路改为每次运行时读取解析结果（DB 覆盖 env、空值回退），**保存即生效、无需重启容器**；`isConfigured()` 改异步
- **配置 CRUD API**（仅 super_admin）：`PUT /api/admin/model-config/{chat|image|video}` 保存（Zod 校验：URL 格式、长度上限；apiKey 留空=保持原 Key，其余字段空串=清除回退 .env）；`DELETE /:scope` 恢复 .env 默认（整行删除含密钥）；`POST test-image`（comfyui=/system_stats、openai=/models、minimax=Key 检查）与 `POST test-video`（MiniMax ping）连通探测
- **前端 ModelConfig 页重构为可编辑表单**：对话/生图/生视频三卡各带 Base URL、API Key（Password 输入，回显仅 `••••末四位`，留空保持不变）、模型字段；生图 provider 单选切换（MiniMax/OpenAI 兼容/ComfyUI 显示地址+工作流路径+四节点映射）；每卡「保存配置（即时生效）/连通性测试/恢复 .env 默认」操作组 + 结果 Alert
- **接入引导可操作化**：云端 6 家与本地 3 家 provider 表格新增「选用」按钮，一键把 Base URL+推荐模型填入对话表单（原只读表格+`.env` 复制块移除）；ComfyUI 四步接入说明并入「本地大模型」Tab；底部保留「当前生效配置」速览
- **布局修复**：页面从"三概览卡+测试卡+Tabs 长表"改为纵向卡片流式布局，表单 `labelCol/wrapperCol` 窄屏自动转 vertical，表格 `scroll={{x}}` 收敛——实测 1440/1920/768 三档均无横向溢出

### Security

- API Key 只进不出：保存后任何读取接口一律短掩码（`••••`+末四位），响应体经冒烟断言不含明文；「恢复 .env 默认」为唯一清除已存密钥的路径（二次确认弹窗明示）

### Verified

- 门禁：typecheck + build + 冒烟 **38/38**（新增 7 用例：超管读取 200、保存 200、持久化生效 source=db+脱敏、响应无明文 Key、apiKey 留空保持/model 空串清除、未知 scope 拒绝、DELETE 恢复回退 env）
- 浏览器实测（super_admin，1440/1920/768）：三档无横向溢出、输入框可编辑、「选用」预填、保存即时生效、连通测试失败态正确渲染（伪造 Key 401）、刷新持久化、恢复默认回退 .env、生图 provider 切换字段联动，console error 0

## [0.1.17] - 2026-10-08

### Added（模型配置中心：客户自部署本地+云端大模型）

- **对话模型多 provider 抽象**：`LlmService` 从"MiniMax 直连"改为 OpenAI 兼容协议，env 驱动 `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`（未设置回退 `MiniMax_*`，向后兼容）；`resolveModel` 支持 `LLM_MODEL` 全局锁定或跟随请求。一套抽象覆盖国内外云端（DeepSeek/通义千问/智谱 GLM/Kimi/OpenAI/MiniMax）与本地（Ollama/LM Studio/vLLM，均 OpenAI 兼容）
- **生图三 provider 路由**：`IMAGE_PROVIDER=minimax | openai | comfyui`。`image-provider.ts` 独立适配层：`generateViaMinimax`（image-01）、`generateViaOpenai`（gpt-image-1/兼容网关，b64_json 或 url）、`generateViaComfyui`（本地 ComfyUI，按官方 Server API `POST /prompt → 轮询 /history → /view` 下载，工作流节点 id 由 `COMFYUI_*_NODE` 配置）；产物统一 Buffer 经 `saveBuffer` 落盘
- **ComfyUI 开箱模板**：项目内置 `comfyui-workflow.json`（SD1.5 工作流，节点 id 对齐默认值），compose 只读挂载进容器，`IMAGE_PROVIDER=comfyui` 即可用
- **模型配置中心 API**：`GET /api/admin/model-config`（仅 super_admin）返回对话/生图/生视频三能力的 provider 状态（Base URL/模型/Key 是否配置，Key **固定短掩码 `••••末四位`**，绝不回传明文与长度）；`POST /api/admin/model-config/test-chat` 发一条极短请求做连通性探测返回 model+延迟
- **前端 ModelConfig 页**（替换旧"模型测试"）：三张概览卡（绿/灰 Key 标签）+ 对话连通性测试（loading→成功/失败 Alert）+ 三 Tab 配置引导（云端 provider 表格含 Base URL/推荐模型/获取 Key 外链、本地 Ollama/LM Studio/vLLM 安装启动、ComfyUI 四步接入），每段附 `.env` 示例一键复制；路由 `/model-config`、侧栏"系统管理 - 模型配置"
- `.env.example` 扩为多 provider 模板（LLM_*/IMAGE_*/COMFYUI_* + 各主流 provider base_url/模型/Key 获取地址注释）；`docker-compose.yml` api 服务透传全部新 env

### Fixed

- **空串破坏请求**：compose 传 `LLM_MODEL=`/`IMAGE_MODEL=`/`COMFYUI_*_NODE=` 空值时，`ConfigService.get(key, default)` 对"存在但为空"返回空串（default 仅对 undefined 生效），会把 `model:""`、空节点 id 发给上游导致 chat/生图失败 → service 层加 `env()` 规范化（空串/空白回退默认）；curl 验证概览 model 字段不再为空
- **配置页横向溢出**：实测发现脱敏 Key 用 121 个圆点撑爆 Tag，1440/768 视口页面级横向滚动 → 改固定短掩码 `••••` + 末四位（顺带不泄漏密钥长度）+ 概览网格 `repeat(3, minmax(0,1fr))`；三档视口复测 scrollWidth 均无溢出、console 0 error
- 删除随 ModelTest 一起失效的孤儿 `LlmController`（`/api/admin/llm/test`）与 `ModelTest.tsx`，`ChatStore` 降级提示改"系统管理 - 模型配置"

### Verified

- 门禁：typecheck + build + 冒烟 31/31（新增"模型配置端点存在且普通用户 403"用例）
- 后端 curl：`GET model-config` 三能力状态正确、Key 短掩码；`test-chat` 连通（model=MiniMax-M3 延迟 ~1.3s）；生图 minimax 路径回归正常出图
- 浏览器实测（super_admin，1440/768/1920）：概览三卡/连通测试成功提示/三 Tab 引导表格与外链/复制按钮全部正常；Key 无明文泄漏、无空模型名、无死链；溢出修复复测通过；旧 /model-test 入口移除

## [0.1.16] - 2026-10-08

### Added（完整性审计后补齐 5 项待接功能）

- **AI 生视频首帧图生视频**（此前首帧上传是死功能：`beforeUpload={()=>false}` 文件不入库、"从我的资料选择"是无事件死链接）：首帧经 `POST /api/media/uploads` 真实落盘；`/api/media/videos` 新增 `firstFrameAssetId`（校验资产存在/属租户/为图片后读取本地文件转 base64 data URL，切换 `I2V-01-Director` 图生视频，MiniMax v1 API 原生支持）；新增"从「我的资料」选择首帧"真实弹窗（列图片资产网格点选）；移除后端不消费的假控件（模型/声音下拉），参数行收敛为时长/画质/比例（比例此前硬编码 16:9，现真实传递）
- **使用指引首次登录自动弹出**：按用户 id 的 localStorage 标记，每个用户仅自动弹一次（对齐参考站"每浏览器仅弹一次"行为），顶栏手动入口保留
- **我的资料过期占位态**：图片/视频 `onError` 降级为"原文件暂不可用"占位卡（此前非 ready 资产直接过滤、文件缺失显示裂图）
- **AI 生图原位翻页**：本次会话生成历史数组化，预览下方左右箭头+计数（"1 / 2（本次会话）"），回看不丢图
- **智能体市场"我的智能体"真实化**（此前永远空列表）：localStorage 持久化自建智能体（名称/简介/人设提示词）+ 新建弹窗 + 卡片删除；点卡片进工作台，人设经 `ChatStore.send(text, agent, systemPrompt)` 注入 LLM system prompt，会话续聊沿用原人设（`WorkbenchConversation.systemPrompt` 持久化）

### Fixed

- 视频首帧资产无效会在扣额后才报错（白扣额度）→ 校验前置到 `tokens.consume` 之前；冒烟新增 2 用例（首帧资产 404 且余额不变、非法比例 400）= 30/30
- 自建智能体删除按钮事件冒泡：Popconfirm 弹层经 portal 渲染、React 事件沿组件树冒泡到卡片 onClick，确认删除会误触发跳转工作台 → 删除控件移出可点击卡片（网格单元 position:relative + 按钮绝对定位），复测通过
- 新建智能体表单两处 Promise/类型问题：`validateFields` 校验失败 rejection 未捕获（console Uncaught）→ try/catch；选填简介未填时 `v.description.trim()` 抛 TypeError → `?.trim() ?? ''` 且 `CreateForm.description` 类型改可选，复测 0 console error
- 页面 `<title>` 与登录页脚仍残留旧仓库名"增强型智能家居 AI SaaS 平台"→ 统一为产品名"智能家居 AI 工作台"，页脚改"开源自部署 · 模型自选"

### Removed（清理）

- `theme/tokens.ts` 三个零引用导出（`BRAND_GRADIENT_DEEP`/`ACCENT_TEAL`/`BLACK_PILL_STYLE`，grep 交叉验证全项目无消费方）
- 过时截图：`replica/clone-screens/S03-home.png` 与 `replica/diffs/S03-home.png`（0.1.15 工作台重设计前所拍旧版 960px 布局，已失真；新截图待浏览器截图工具可写工作区时补）
- 空目录 `replica/design/`

### Verified

- 门禁：typecheck + build + 冒烟 30/30
- 浏览器实测（1440×900）：首帧选择/资料弹窗/缩略图回显正常；生图 2 张翻页计数正确；指引自动弹一次+刷新不再弹；自建智能体创建/持久化/删除/人设对话全链路通过；MiniMax 上游 529 过载时降级说明正常（重试即恢复）
- 审计结论存档：百宝箱 18 工具中 14 个真实路由+4 个本就人工服务，无 stub；后端无孤儿模块、TokenLedger userId 记账完整（共享额度+个人可追溯天然成立）；0.2.0/0.3.0 标记项为计划内预留

## [0.1.15] - 2026-10-07

### Changed（开源就绪整改）

- **品牌脱敏（clean-room 合规）**：清除所有第三方品牌/商标/具名/凭据/域名/备案号痕迹——侧栏品牌名改"智能家居 AI 工作台"，历史对话默认智能体改"智居助手 · 通用对话"，素材库品牌字段改"演示门店"，接单页与短视频页去第三方品牌字样统一"智居 AI 工作台"，源码注释"复刻目标站/与目标站对齐"等表述中性化；参考站截图目录（`.ref-site/`、`replica/screens/`）与采集记录（含测试凭据）整体移出 git 跟踪并加入 `.gitignore`（仅本地留存）；`replica/recon.md` 域名/品牌/手机号/备案号通用化
- **收费去自定定价**：扣费额度全部改为环境变量驱动（`BILLING_CHAT_TOKENS`/`BILLING_IMAGE_TOKENS`/`BILLING_VIDEO_TOKENS`/`BILLING_PLAN_TOKENS`/`BILLING_PLAN_PRIVATE_TOKENS`，`.env.example` 附说明）；前端移除写死的具体价格（对话"¥0.03"、生图"¥3/张"、方案"¥1/页"、套餐"¥299/¥2980/¥19800"、单价 chip 等），统一"按额度计费/单价由部署者配置/按部署者定价"口径；产品硬件参考价区间保留（非平台收费）
- **工作台首页重设计（宽屏响应式 + 精美度）**：内容区由锁死 960px 改为流式 `clamp(720px, 86%, 1380px)`（对话态）/ 断点递进（新对话页 960→1200→1380）；新增品牌渐变光晕背景；快捷卡 `repeat(auto-fit, minmax(230px,1fr))` 宽屏铺满（5 列一行）+ 图标色块 + 悬浮层次；能力标签行；chip 点击填入输入框
- **README 重写**：完整功能地图（账户多租户/工作台/生成链路/智能体市场/百宝箱工具集/内容与资料/其他）、开源自部署定位（本地 ComfyUI/Ollama + 云端大模型自选）、模型与计费配置、安全与限流、路线图；去"目标站复刻/具体价格"表述

### Fixed

- **antd 静态 message/Modal 脱离 App 上下文**（浏览器实测偶发 `e.success is not a function`）：根节点包裹 antd `<App>`，全站 11 个页面 + MainLayout 的静态 `message.*`/`Modal.confirm`/`Modal.info` 统一迁移到 `App.useApp()` 的 `message`/`modal` 实例（跟随主题、消除告警与竞态）；`<Modal>` 组件用法保留

### Security（限流与高并发/部署审查）

- `main.ts` 开启 `trust proxy`：nginx 反代后 throttler 按真实客户端 IP 计数（否则所有请求同算代理 IP，限流失效/误伤）
- 注册/登录接口加严限流 `@Throttle 10 次/分钟/IP`（防暴力破解，全局仍 120/分钟）
- 生产环境（`NODE_ENV=production`）启动校验：默认 `JWT_SECRET`/默认管理员密码直接拒绝启动；Swagger 文档生产关闭（避免云服务器泄露 API 面）
- `docker-compose.yml`：api 服务 `JWT_SECRET`/`SEED_ADMIN_PHONE`/`SEED_ADMIN_PASSWORD` 改 `${VAR:?}` 强制注入（缺失即报错），补 `NODE_ENV`、`CORS_ORIGIN` 可配
- 高并发正确性复核：额度扣减事务内 `updateMany` 余额条件原子完成（无超扣竞态）、文件流路径穿越防护、上传 MIME+大小校验、nginx 反代头与超时确认

### Verified

- 全站浏览器实测（1920×1080 + 2560/1280/768 多分辨率）：品牌脱敏 16 路由零命中第三方字样；message/modal 四类（warning/confirm/info/组件）全部正常无 console 报错；收费文案已去具体价格、产品参考价保留；各页宽屏合理利用无横向滚动/溢出，工作台达 1380px 居中 + 5 卡一行 + 光晕
- 门禁：typecheck + build + 冒烟 28/28 通过

## [0.1.14] - 2026-10-07

### Added

- **百宝箱剩余可补齐 stub 工具真实化**（复用 0.1.13 Product/FloorplanLayout 数据与 `pointOverlay` 合成管线，零新增依赖）：
  - **WiFi 热力图**：`compositeHeatmap()` 以网关/AP 点位为热源，additive 径向光斑叠加（红=强/黄/绿=弱）+ 信号源徽章 + 渐变图例；`DeviceLayout` 三模式（设备点位/灯光点位/WiFi 热力）经 `?mode=` 直达，产品库按模式过滤（WiFi 仅网关类）
  - **灯光点位效果图**：`compositeLightPlan()` 灯具点位暖色光晕+徽章+名称标签
  - **智能报价**：`QuoteStudio`（`/quote`）产品库选品配单、数量步进、参考价区间自动算价、导出报价单 CSV（BOM 兼容 Excel，含"实际报价以门店方案师现场确认为准"合规说明）；不建报价表（YAGNI，纯前端算价导出）
  - 百宝箱 `wifi-heat`/`light-plan`/`quote` 三工具从"开发中"stub 变真实路由

### Fixed

- 合成图导出扩展名与内容不符（`toDataURL('image/jpeg')` 写成 `.png` 文件）→ 三处统一改 `toDataURL('image/png')`，`file` 命令验证为真 PNG

### Verified（内部浏览器实测 + 导出文件解剖）

- WiFi 热力：布 3 网关源→导出 1600×900，光斑叠加+图例正常；灯光点位：布 3 吸顶灯→暖光晕+标签清晰；WiFi/灯光模式正确隐藏设备清单/挂接按钮
- 智能报价：加 3 产品→合计 ¥1,797-4,097（与手算一致）→导出 CSV 行/小计/合计/合规说明全部正确
- 诚实边界：平面图转彩平图/生效果图受 MiniMax image-01 `subject_reference` 仅支持人像参考的模型限制，保留跳 AI 生图页（不造假）
- 门禁：typecheck+build+smoke 28/28 通过

## [0.1.13] - 2026-10-07

### Added

- **智能设备点位布局（完整闭环，补齐百宝箱核心 stub 工具）**：上传客户户型平面图 → 产品库点选布点 → 拖拽微调 → 导出标注图纸 PNG + 设备清单 CSV → 挂接方案空间动线页
  - 数据层：Prisma 新增 `Product`（20 条米家生态种子：网关/开关/传感器/灯光/窗帘/安防/家电/影音/暖通，含品类、参考价区间、每空间数量提示，按 name 幂等 upsert）与 `FloorplanLayout`（图纸+归一化点位 JSON）；`PlanProject` 加 `floorplanAssetId`/`layoutPoints`
  - 后端：`GET /api/products`；`POST /api/media/uploads`（multipart 本地图片落盘 uploads 卷+写 MediaAsset，复用 `?token=` 文件流）；`/api/layouts` CRUD+summary；`PATCH /api/plans/:id/floorplan` 挂接；公开分享页 `GET /api/public/plans/:token/floorplan`（凭 shareToken 免鉴权）
  - 前端：`DeviceLayout` 编辑器（原生 pointer 事件拖拽，零新依赖）；`pointOverlay.ts` 共享合成模块（compositePoints 徽章+名称标签），预览/PNG 导出/PPTX 三处同一份像素
  - 方案集成：空间动线页（web 预览+分享页+PPTX）检测到挂接即把左图换成"客户户型·设备点位图"（PPTX 白底竖框 contain 适配保持原比例不拉伸）；步骤 3 该页右上出现"户型图布点"入口直达编辑器；百宝箱 `device-layout` 工具从 stub 变真实路由

### Fixed

- LayoutModule 只 import 未加入 `@Module imports` 导致 `/api/products` 404（nest build 无报错，靠路由日志排查）

### Verified（curl 全链路 + 内部浏览器 + LibreOffice 渲染）

- 后端链路：登录→products(20)→uploads 落盘→layouts 创建→plans 挂接→`?token=` 文件流 200→公开 floorplan 免鉴权 200→summary 聚合正确；测试数据已清理还原
- 浏览器：编辑器渲染（20 产品按 9 类分组）；方案空间动线页显示合成点位图+布点入口；PPTX 导出该页渲染核对白底框+标注图正常
- 冒烟新增 4 用例（产品目录/底图 404/坐标越界 400/挂接 404），28/28 通过；typecheck+build 通过

## [0.1.12] - 2026-10-07

### Fixed

- **PPTX 导出图片全部拉伸变形**（用户实测发现；根因：pptxgenjs 浏览器版 `sizing:cover` 不读取原图 intrinsic 尺寸，srcRect 恒写 `0 0 0 0`，等效直接拉伸——PowerPoint/LibreOffice 均变形，此前仅 unzip 结构验证未做视觉渲染漏检）：`planPptx.ts` 新增 `coverCrop()`，导出前用 canvas 按各页实际图框比例预裁剪（center/焦点），`addImage` 去掉失效 sizing；解剖验证 8 页嵌入图宽高比与放置框完全一致
- 需求洞察/场景页暗图带在 PPTX 中提亮层 transparency 语义修正（0=不透明，原值 20 会把图刷白，改 62）
- 逐页渲染核对确认第 1/2 页内容均在 16:9 画框内、无越界形状（python-pptx 全形状边界审计 0 越界）

### Verified

- LibreOffice headless 逐页渲染 PPTX 截图核对：封面/品牌/动线/需求/生态/场景×2 图片比例全部正常、无超框；暗金主题（C）抽查 web+PPTX 双端正常后恢复原风格
- 11 套主题共用同一 composition 代码（tokens 仅换色），亮/暗代表主题（A/D/C/I）实测通过
- jingmei-ppt skill 更新：`pptxgenjs-implementation.md` 沉淀"浏览器版 sizing 失效必须 canvas 预裁剪+宽高比解剖验证"与"暗图处理诚实原则（transparency 语义、死黑像素不可提亮救回、换图或焦点裁剪）"
- 门禁：typecheck+build+smoke 24/24 通过

## [0.1.11] - 2026-10-07

### Improved

- 智能方案幻灯片**全面视觉重设计**（按 jingmei-ppt skill 方法论落地，零新增依赖）：
  - 设计系统分层：`planThemes.ts` 新增页型→本地实景图映射（`PAGE_IMAGE`/`sceneImage()`，实景图为内容而非装饰）+ 阴影 token（`CARD_SHADOW`/`CARD_SHADOW_SOFT`）+ 暗图提亮/取景函数（`imgFilter`/`imgPosition`）
  - 预览 `PlanSlide.tsx`：8 类页型各自独立 composition（沉浸式图页与分析卡页轮廓交替），每页配实景图+阴影卡，Folio 页眉/Claim 主张/PointCard/QuoteBar/Footer 原语统一，垂直节奏消除底部空带
  - PPTX `planPptx.ts` 同构：每页 `addImage` 实景图+`shadow` 对象，预算页保留原生可编辑 `addChart` 条形图，交付页圆点时间轴，暗图叠加半透明白层等效提亮
- 逐页核对修复：品牌页 2×2 卡加幽灵序号水印+强调条消除空带；生态页改纵向三段布局（文/图+卡列收拢）；交付页时间轴卡固定高度垂直居中+底部大序号水印；需求页暗图换明亮暖光餐厅实景（c5）、卧室场景换感应灯暖光带（c3）——c4 夜间卧室死黑区不可作背景

### Verified（内部浏览器逐页实测 + 下载 PPTX 解压解剖）

- "光谷国际 140㎡"9 页逐页截图核对：每页含实景配图+阴影卡+引言块，无空带、无死黑图；分享页同步
- PPTX 解剖：8 页含 `<p:pic>` 实景图（嵌入图 md5 与源图一致），slide8 含 `c:barChart` 原生可编辑图表，各页 4–28 个 `a:outerShdw` 阴影，slide4/6/7 含提亮层
- 门禁：typecheck+build+smoke 24/24 通过

## [0.1.10] - 2026-10-07

### Added

- 智能方案逐页视觉补齐至"全面优于目标站"（用户要求消除 0.1.9 对比中的持平/略逊项；按指示联网调研后**复用已装 pptxgenjs@4.0.1，零新增依赖**）：
  - 后端 `PlanPage` 新增 `quote` 底部引言字段；prompt 约束预算页 bullets 为"分项名：下限-上限"纯数字区间、交付页为"阶段名｜说明"，sanitize 收敛（JSON 列，无需迁移）
  - 预览 `PlanSlide` 新增 3 类专用版式：预算页横向条形图（宽度按金额占比 + 左正文 + 合规小字）、交付页 6 阶段横向流程（编号圆点 + 连接线 + 去前导编号的干净阶段名）、全内页底部引言块
  - **PPTX 导出用 `addChart(ChartType.bar)` 生成原生可编辑 clustered 条形图**（下限/上限双系列 + 主题色 + 数据标签）——客户在 PowerPoint 里可直接改数据/配色/图表类型；交付页用原生 `chevron` 流程形状（179 种 ShapeType 之一）。目标站这两页均为整页 PNG 拍平，此维度形成代差

### Fixed

- 预算页模型输出 8 分项导致预览条形图溢出压住引言块 → 预览与导出统一限 6 条
- 交付页阶段名残留"｜"分隔符（模型输出三段式）→ `parseStages` 取首段为名称、其余归说明
- 内页要点卡 rest 为空时显示悬空冒号 → 无内容时整条按原文渲染
- 侧栏历史切换同页不同方案不刷新（`?id=` 只在 mount 时读一次）→ `useEffect` 依赖 `planId`

### Verified（内部浏览器实测 + 下载 PPTX 解压解剖）

- 实测"光谷国际 140㎡ 四室两厅"9 页方案：预览四类版式（封面/内页引言/预算条形图/交付流程）全部正常，分享页同步
- PPTX 解剖：9 页 + 9 notesSlides；slide8 含 `c:barChart` 原生图表与真实数值（10000…18000 可编辑）；slide9 含 6 个 `prst="chevron"` 形状 + 干净阶段名；引言文本入形状、讲解稿入备注
- 逐页判定：9/9 在"可编辑性"上全胜（对方整页 PNG），版式已补齐图表/流程/引言三要素；typecheck+build+冒烟 24/24 通过

## [0.1.9] - 2026-10-07

### Fixed

- 修复"PPT 入口不可发现"：与目标站逐项对比后确认，此前方案记录藏在 PlanStudio 的"历史方案"抽屉里，侧栏"历史对话"只显示工作台会话，用户找不到查看/修改 PPT 的位置（目标站方案即会话、侧栏直接可见）
  - `MainLayout` 侧栏"历史对话"改为会话与方案按更新时间混排（`GET /api/plans`），方案条目显示"智能方案 · N 页 · 文案版本 X · 时间"，点击直达审稿视图，`⋮` 菜单支持删除方案（分享链接同步失效）
  - `PlanStudio` 支持 `?id=` 深链（react-router `useSearchParams`），从侧栏历史直接打开对应方案继续编辑；侧栏条目在当前打开的方案上高亮

### Improved

- PlanStudio 步骤 2"逐页审稿"卡片顶部加入真实 16:9 幻灯片缩略图（此前纯文字卡片，与"给客户 PPT"的预期脱节）
- `PlanSlide` 字号单位从 `vw` 改为容器查询单位 `cqw`（`containerType: inline-size`），同一组件在缩略图（~280px）与大图预览（~1100px）下自动缩放，分享页版式不受影响

### Verified（内部浏览器走查）

- 侧栏历史显示 2 条方案记录，点击直达步骤 2；步骤 2 九页缩略图渲染正常；步骤 3 大图预览与分享页回归正常；全仓 typecheck 通过

## [0.1.8] - 2026-10-07

### Added

- 智能方案交付物升级为真正的 PPT（0.1.7 的纯文本 HTML 分页不符合"交付客户方案 PPT"的业务预期）：
  - 实地登录参考站走通方案全流程并下载真实 PPTX 解剖核对（发现 8）：参考站交付 = 9 页 16:9 .pptx，每页整页 PNG 拍平；据此重构我们的实现
  - 后端 plans 升级为 9 页标准模板（封面/品牌与服务实力/空间动线与智能规划/家庭需求洞察/全屋智能生态规划/核心场景拆解×2/预算规划与性价比/落地交付与售后闭环），每页新增 `narration` 讲解稿字段；新增 `keySpaces` 重点空间、`needs` 客户需求字段与 `pageCount` 页数参数（9/10/12，迁移 `plan_extra_fields`）；方案版本扩为 3 种（standard/presale/private）
  - 前端新增 `lib/planPptx.ts`（pptxgenjs@4.0.1，MIT）：从方案数据生成**原生可编辑 16:9 幻灯片**（29 个文本形状/页 vs 目标站整页 1 图），封面含实景配图+价值卡，内页含页眉/大标题/左正文/右编号要点卡/页脚，讲解稿写入 PPT 备注（放映者视图可见，客户阅读模式不显示）——比目标站"拍平 PNG"更优，客户拿到可直接编辑
  - 新增 `components/PlanSlide.tsx` 共享 16:9 幻灯片预览组件；PlanStudio 步骤 3 改为左页列表+右幻灯片预览+讲解稿展开+修改当前页；步骤 4 交付页对齐目标站：下载方案 PPTX / 下载完整讲稿 / 全屏播放 / 复制分享链接 / 客户视角
  - 分享页 `PlanShareView` 从纯文本流改为 16:9 幻灯片画布逐页呈现（讲解稿对客户隐藏），支持保存 PDF/打印
  - 风格卡缩略图升级为真实封面配图（复用本地生成图 public/images/cases），不再纯色块

### Fixed

- 修复方案步骤 1 字段不全：补齐目标站的重点空间、客户需求、方案页数（9/10/12）、3 种方案版本，主按钮文案对齐"生成方案文案"

### Verified（内部浏览器完整走查 + 下载文件解剖比对目标站）

- 实测生成"东湖珉章 128㎡ 三口之家"方案：9 页全部产出，内容与客户需求（回家亮灯/观影沉浸/起夜不刺眼）贴合，合规（价格区间+现场确认声明）
- 步骤 3 幻灯片预览版式与目标站 slide-03 对齐（页眉 Slide N | 页名、左正文、右编号圆点卡、页脚品牌）
- 下载 PPTX 解剖验证：9 页、16:9（12191695x6858000 EMU）、每页 29 个原生文本形状、notesSlides 含讲解稿
- 分享页客户视角：16:9 幻灯片逐页渲染正常，讲解稿不显示；账本正确记录 -900（9 页 × ¥1）

## [0.1.7] - 2026-10-06

### Added

- 智能方案生成真实链路（此前仅有 UI 骨架，4 步向导点击无逻辑）：
  - 后端新增 `apps/api/src/plans/` 模块：`POST /api/plans`（MiniMax-M3 生成 8 页结构化方案：封面 + 5 空间页 + 场景联动页 + 预算汇总页，按页扣额度：标准 ¥1/页、私宅 ¥1.6/页）、`GET /api/plans`（历史列表）、`GET /api/plans/:id`、`PATCH /api/plans/:id/pages/:index`（逐页审稿编辑，版本 +1）、`DELETE /api/plans/:id`、`GET /api/public/plans/:token`（客户分享只读，无鉴权）
  - Prisma 新增 `PlanProject` 表（客户资料、风格 A-K、版本 standard/private、pages JSON、shareToken、versionNo）
  - `LlmService.chatJson()`：返回任意 JSON（含数组），用于多页方案结构化生成；模型输出经 sanitize 收敛（非法页丢弃、bullets 限 20 条）
  - 合规约束内置 prompt：价格一律区间、禁止未确认的时效/质保承诺、预算页尾注"实际报价以门店方案师现场确认为准"
- 前端 PlanStudio 4 步真实流转：步骤 1 客户资料+11 风格+版本选择 → 生成初稿（约 30-60s）→ 步骤 2 逐页审稿卡片（点击任意页编辑标题/正文并保存，文案版本递增）→ 步骤 3 整册预览（风格主题贯穿，支持打印/下载 PDF）→ 步骤 4 交付客户（分享链接+复制+客户视角预览）；历史方案抽屉可独立打开继续编辑或删除
- 客户分享页 `PlanShareView`（`/share/plan/:token`，无需登录，微信内直接打开）：11 套自有风格主题（`data/planThemes.ts`）按页渲染，封面渐变+空间页+场景联动+预算汇总+页脚合规声明
- 冒烟新增 4 项（方案列表/字段校验/详情 404/公开 token 404），23/23 通过

### Fixed

- 修复逐页编辑 PATCH 400：schema 误要求 body 携带 index（实际来自 URL 路径参数），移除后编辑保存正常（文案版本 1→2 实测）

### Verified（内部浏览器完整走查）

- 真实生成"东湖玖章 128㎡ 三室两厅"方案：8 页全部产出（封面/客厅/主卧/餐厨/玄关走廊/卫浴阳台/场景联动/预算），深空科技主题正确应用；逐页编辑保存版本递增；历史方案打开正常；分享链接客户视角渲染完整；账本正确记录 -800（8 页 × ¥1）

## [0.1.6] - 2026-10-06

### Added

- 生成链路真实接通（MiniMax 代理，产物全部本地落盘，不依赖外链）：
  - 后端新增 `apps/api/src/media/` 模块：`POST /api/media/images`（image-01 文生图，扣 ¥3/张）、`POST /api/media/videos`（T2V-01-Director 文生视频，扣 ¥15/条，轮询+下载）、`GET /api/media/assets`、`GET /api/media/assets/:id/file`（Range 流，支持视频拖动）、`POST /api/media/materials/purchase`（素材购买，扣 ¥1，幂等）
  - 产物写入 `UPLOAD_DIR`（Docker 卷 `api-uploads` 持久化），`MediaAsset` 表记录 kind/路径/大小/状态
  - 工作台对话接入 `POST /api/llm/chat`（MiniMax-M3，扣 ¥0.03/次），按智能体名注入 system prompt（朋友圈/短视频脚本/直播/小红书/投流/诊断/方案/传记 9 类人设）
- 本地图片资产：`apps/web/public/images/` 19 张（智能体封面 12 + 案例库 5 + 素材库 2），全部经 MiniMax image_generation 生成并落盘，替换原色块占位；百宝箱堆叠图复用本地案例图
- 文件流认证：`JwtQueryGuard` 支持 `?token=` 查询参数（img/video 标签无法携带 Authorization 头，本地单机部署形态下可接受）
- 二级菜单真实化：
  - 智能体市场：卡片封面显示本地实拍图；点击进入对话并携带人设
  - 百宝箱 18 工具卡：已具备能力的（文案仿写/生图类/生视频/知识库/定制智能体）跳转对应页面并预填提示词；未上线工具与人工服务给出明确提示，不再是死卡片
  - 素材库：查看/购买/下载闭环，已购买 Tab 持久化（MediaAsset kind=material）
  - 知识库：删除按钮接通 `DELETE /api/content/extractions/documents/:id`
  - 我的资料：真实展示后端产物（图片缩略图/视频首帧+播放/下载链接），不再只有对话派生文案
  - 为你立传：按钮接入工作台传记访谈人设
- 冒烟测试新增 4 项（素材购买扣款/幂等/产物列表），19/19 通过；seed 为平台运营租户补演示额度 ¥1000（幂等）

### Changed

- 宽屏响应式：主内容区去除 1400px 居中限制，全页撑满侧栏右侧；ImageStudio/VideoStudio 表单列放宽至 760、预览列 460；TokenCenter 放宽至 1180、ModelTest 960、PlanStudio 步骤条 1080；KnowledgeBase 去 860 限制
- 生图/生视频按钮文案标注真实耗时与单价；首页底部"离线演示"文案更新为"对话与生图/生视频已接通 MiniMax 模型"

### Fixed

- 修复生成结果图 401：文件流端点改走 JwtQueryGuard，前端 `fileUrl()` 统一附加 token
- 修复 KnowledgeBase 文档列表 URL 与后端路由不一致（`/api/content/documents` → `/api/content/extractions/documents`）
- 修复 ChatStore 遗留 timerRef 未清理导致的 lint 隐患（改真实异步后移除）

### Verified（内部浏览器逐屏走查，1920x1080）

- 登录/首页/智能体市场/AI 生图/AI 生视频/智能方案/百宝箱/知识库/我的资料/素材库/开始接单/个人中心/模型测试/为你立传 全部渲染正常
- 实测：生图 HTTP 201 出图并入库；生视频 HTTP 201 出 mp4 并入库；对话返回 MiniMax 真实报价话术；素材购买扣款 ¥1；账本正确记录 -300/-1500/-100 消费

## [0.1.5] - 2026-10-06

### Added

- 安装 replica-skill（MIT，11 技能复刻流水线）到 `.claude/skills/`，按 recon→design→build→diff 方法论重建复刻基线：
  - `replica/recon.md`：15 屏清单、8 条流程、组件表、13 实体数据模型、实测设计 token
  - `replica/features.csv`：50 项功能矩阵（must/should/could），clone 列如实标注
  - `replica/screens/`：13 页参考截图（1920x1080）；`replica/clone-screens/`：10 页实现截图；`replica/diffs/`：imgdiff 布局对比图
- 功能页完整复刻（差距表 ⑥–⑬⑮ 的 UI 层全部交付）：
  - `pages/AgentMarket.tsx`：分类 pill、热度、启用开关、卡片网格、点击进入对话（携带智能体名）
  - `pages/ImageStudio.tsx`：参考图上传、17 场景 chip（选 1–3）、模型/尺寸/质量/格式/背景参数、右预览、案例库横滚
  - `pages/VideoStudio.tsx`：首帧上传+从资料选择、尾帧折叠、预设场景自动填描述、时长/画质/比例/声音
  - `pages/PlanStudio.tsx`：4 步向导、7 字段客户表单（含合规提示）、11 风格卡横滚、方案版本
  - `pages/TreasureBox.tsx`：4 组 18 工具卡（堆叠图+角标）
  - `pages/KnowledgeBase.tsx`：启用开关+多文件上传入库（复用 S2 提取管道）+已入库列表
  - `pages/MyAssets.tsx`：分类 pill+日期分组+缩略图网格+过期占位
  - `pages/MaterialLibrary.tsx`：三 Tab+创作者收益卡+下载 1 元素材卡
  - `pages/OrderStudio.tsx`：5 步接待向导整页布局（左窄栏+历史方案）
  - `pages/BiographyStudio.tsx`：为你立传 IP 档案页
  - 个人中心增强：额度进度条、单价 chip、邀请码卡（复制链接）、修改密码表单、退出登录
- 后端：`POST /api/auth/change-password`（argon2 校验原密码，错误 401）
- 侧栏对齐目标站：10 入口分组（AI 能力 5 + 智能百宝箱 4 + 资源与账户 + 系统管理）、渐变"短视频工作台"按钮
- MiniMax 真实 key 已配置并实测连通：`POST /api/admin/llm/test` HTTP 201，MiniMax-M3 回复正常（latency ~3s）

### Fixed

- 品牌渐变修正为实测值 `#5B5BF0→#8E7BF6`（原为猜测值 #7C5CFC→#5B3FD6），统一收口到 `theme/tokens.ts`
- 首页内容块垂直居中与输入卡 960px 宽度对齐实测值（imgdiff 布局分 28.8→44.4）

### Verified

- `pnpm typecheck && pnpm build && pnpm smoke`：全绿（冒烟 15/15）
- replica-diff：功能一致度 **84.8/100**（must 29/35；剩余 6 项为生成链路后端逻辑，属 S3/0.3.0 范围）
- 内置浏览器逐页走查：智能体市场、短视频工作台渲染正确；改密端点错误原密码返回 401
- Docker 全栈重建：web:200、api health ok

## [0.1.4] - 2026-10-06

### Added

- 目标站全量实测采集基线：13 页面/流程、18 节文字记录落盘 `.ref-site/采集记录.md`（0.1.5 起参考截图永久保留于 `replica/screens/`）
- 前端复刻第一批（对齐采集记录 §13 差距项 ①–⑤⑭⑯）：
  - MainLayout 重构：白色侧栏 + 分组导航（AI 能力 / 智能百宝箱 / 系统管理）+ 紫色渐变"+ 新对话"按钮 + 历史对话内嵌侧栏（标题 + "智居助手 · 通用对话 · MM/DD HH:mm"，悬停删除菜单）+ 底部个人中心卡（额度 / 设置 / 退出）+ 侧栏可折叠（折叠态 48px 窄条）
  - Dashboard 重构：居中头像 + "Hi，欢迎回来 ✦" + 大输入卡（4 个功能 chip：上传附件/图生图/生视频/生方案 + 黑色圆形发送按钮）+ 5 张快捷卡（生成智能方案/做一张海报/出一条视频/文案仿写/找个智能体），对话态保留 Bubble.List + 底部 Sender
  - 新增 `components/TaskBall.tsx` 任务球：黑色圆球 + 红点角标（未读完成任务数）、可拖拽、Esc 收起、Home 复位右下角、展开面板含任务队列 / 清空已结束 / 查看全部历史
  - 新增 `store/ChatStore.tsx`：会话与生成任务队列提升为全局 Context（侧栏历史、任务球、工作台共享）；`useWorkbenchChat.ts` 合并删除
  - 额度展示 ¥ 化（差距 ④）：新增 `lib/money.ts`（100 token = ¥1 显示层换算，记账单位仍为 token，符合规划 §11.2）；顶栏 TokenPill 与额度中心统计卡改为 `¥xx.xx`；顶栏新增青色"使用指引"弹窗（计费单价 + 多账号共享额度公告）
  - 登录页（差距 ⑭）：《用户协议》《隐私政策》勾选拦截（未勾选提交给出错误提示）+ 品牌区"已服务 1000+ 智能家居服务商"信任背书；实景照片背景因版权风险保留纯色品牌区
- 规划文档同步：§2.4 UI 规范按实测修正、新增 §2.6 复刻差距清单（16 项 + 移植状态）、§2.5 计费实测补充、§7.3 新增 generation_tasks / ip_profiles / referrals 表规划

### Fixed

- 侧栏折叠态布局 bug：折叠分支误用普通 div 替代 Layout.Sider，antd Layout 检测不到 Sider 改为纵向堆叠，主区被顶出视口（agent-browser 截图发现，改回 Sider width=48 修复并复验）

### Verified

- `pnpm typecheck && pnpm build && pnpm smoke`：全绿（冒烟 15/15）
- agent-browser 端到端（1920x1080，Docker 重建后 http://127.0.0.1:5173）：登录协议拦截 → 登录跳转 → 首页布局/输入卡/5 快捷卡 → 发送消息进入对话 → 任务球计数与展开面板 → 侧栏历史内嵌与删除菜单 → 新对话空态 → 侧栏折叠/展开 → 额度中心 ¥ 展示 → 内容提取/模型测试路由回归 → console 无报错，全部通过

### Pending（明示边界，按 §7.4 排期）

- 差距 ⑥⑧⑨⑩⑫（智能体市场/生图/生视频/方案向导/百宝箱/我的资料）：0.2.0 与 S3
- 差距 ⑪ 知识库 UI：S4；差距 ⑬ 接单向导：0.3.0；差距 ⑮ 短视频工作台：0.3.0+
- 后端 generation_tasks 表与任务队列轮询/WS：0.2.0（当前任务球为前端队列）

## [0.1.3] - 2026-09-27

### Added

- S2 内容提取系统：五张数据表（extraction_jobs/documents/fields/deficiencies/review_confirmations）与 pending→extracting→reviewing→confirmed/rejected/failed 状态机
- P1 上传解析：TXT/MD/CSV/JSON/HTML 原生、DOCX（mammoth，BSD-2）、XLSX（exceljs，MIT）、PDF（pdfjs-dist，Apache-2.0），单文件 20MB 限制
- P2 网页抓取：http/https scheme 白名单、15s 超时、@mozilla/readability + jsdom（MIT）正文抽取，JS 渲染/登录页明确报错
- P3 对话纪要：LLM JSON 结构化抽取（chatObject，白名单键接收），未配置 MiniMax key 时自动降级规则通道
- 质量评估：按文档类型（产品资料/会议纪要/通用文本）的必需字段集做完整性校验，评分=必填完整率 70%+置信度 30%；缺失生成 deficiency 待确认任务
- API：POST /content/extractions/{upload,url,transcript}、GET 列表/详情/documents、POST :id/confirm（字段白名单防注入、确认快照入库）
- 前端「内容提取」页：三源 Tab 提交、任务/已入库双列表、720px 评审 Drawer（评分进度条、缺失告警、字段人工修正、原文预览、确认/驳回）
- LlmService 新增 isConfigured() 与 chatObject()，chat 支持 maxTokens

### Fixed

- ContentService 对 LlmService 使用 import type 导致 DI token 丢失（运行时静默退出）
- ContentModule 补导入 RbacModule（PermissionsGuard 依赖 AbilityFactory）
- 评审字段按文档类型规格顺序展示，替代字母序
- 任务列表失败/驳回态的缺失列不再误显示对号

### Verified

- 冒烟 15/15（新增完整资料自动入库、残缺资料待确认、人工补全入库、文档列表 4 个用例）
- 浏览器实测：纪要抽取 95 分自动入库；容器内网页抓取 example.com 94 分入库；file:// 被拦截返回 400；未认证 401
- Docker 镜像重建，全栈 5173/3080 端到端验证通过

## [0.1.0] - 2026-09-24

### Added

- 平台层 LLM 测试入口：`POST /api/admin/llm/test`（仅 super_admin）
  - `apps/api/src/llm/{llm.module,llm.service,llm.controller,llm.schemas}.ts`
  - 直连 MiniMax OpenAI 兼容端点（`MiniMax_BASE_URL` / `MiniMax_API_KEY`），用于本地验证 API key
  - 0.2.0 将切到 LiteLLM 网关调用，统一多模型路由 / 预算 / Guardrails
- 前端模型测试页面：`/model-test`（仅 super_admin 可见，菜单出现"模型测试"项）
  - `apps/web/src/pages/ModelTest.tsx`
  - 表单（MiniMax-M3 / Text-01 / M2 三档）+ 回复区 + latency 显示
- `docker/litellm-config.yaml` 新增 MiniMax-M3 模型条目（OpenAI 兼容，`api_base` / `api_key` 均由环境变量注入）
- `.env.example` 与 `.env` 新增 `MiniMax_BASE_URL=https://api.minimaxi.com/v1` 与 `MiniMax_API_KEY=replace-me` 占位

### Verified

- `pnpm typecheck && pnpm build` 全绿
- `pnpm smoke`：11/11 全绿
- API 路由注册：`POST /api/admin/llm/test` 已 Mapped
  - 无 token：401 ✓
  - 有 admin token 但 MiniMax_API_KEY 未配置：503 `LLM_KEY_MISSING` ✓
- Docker 状态：db-1 / redis-1 双 healthy；pgvector 扩展已启用；8 张业务表 + 2 个 migration

### Pending

- 用户填入真实 `MiniMax_API_KEY` 后实测模型调用与流式响应

### 未实现能力（明示边界）

按规划文档 §12 / §7.4 对照：当前版本仅完成 S1 骨架，下列能力**未实现**：

- S2 三源内容提取管道（PDF / 网页 / 视频抓取）
- S3 LiteLLM 网关接入（compose `gateway` profile 已写未启）
- S3 AI 生图（ComfyUI）、文案改写、方案生成
- S4 pgvector 知识库 RAG、品牌知识库双层隔离
- 0.2.0 agent 工具调用 MCP
- 0.4.0 运营后台 / 英文 i18n

Dashboard 当前显示离线演示回复（`useWorkbenchChat.ts:offlineReply`），等待 LiteLLM 网关接入后接真实模型。

## [0.1.1] - 2026-09-24

### Fixed

- `AuthService.sign` 不再重复注入 JWT secret / expiresIn（`JwtModule.registerAsync` 已配），避免多处默认值漂移
- `apps/api/src/auth/auth.controller.ts` `/auth/me` 路由去除双 guard 重复（同时挂 `AuthGuard('jwt')` 与空壳子类 `JwtAuthGuard`），改用单一 `AuthGuard('jwt')`
- 删除空壳 `apps/api/src/auth/jwt-auth.guard.ts` 与引用同步清理
- `TenantsController.activeTenantId` 去除 `TenantGuard` 已保证必填后的不可达 fallback 分支
- `apps/web/src/pages/Login.tsx` 移除与后端 zod `phoneSchema` 重复的 `^1[3-9]\d{9}$` 前端正则；后端为契约真相源
- `apps/web/src/lib/api.ts` 去除无消费者使用的 `ApiError` 自定义类，改用原生 `Error`，调用方仅消费 `message`
- `apps/web/src/layouts/MainLayout.tsx` 三张 `THEME_LABEL / NEXT_THEME / THEME_ICON` 查找表合并为单张 `THEME_META` + `nextTheme(m) = THEME_ORDER[(i+1) % n]`
- `apps/api/test/_probe.ts` 删除（一次性调试探针，smoke 已覆盖相同路径）
- `apps/api/tsconfig.json` 移除未引用的 `"@/*": ["src/*"]` 路径别名

### Added

- `apps/api/prisma/migrations/20260924160000_enable_pgvector` 启用 pgvector 扩展，为 S4 知识库 RAG 落地做准备

### Verified

- `pnpm typecheck && pnpm build && pnpm smoke`：全绿
- Docker Compose 起 Postgres 18（含 pgvector）+ Redis 8，迁移 2 个版本全部 apply，seed 5 角色 + 15 权限点 + 平台管理员
- API 端到端冒烟：health、register、login、me、tenants/mine、tenants/current、tenants/current/tokens、tenants/current/tokens/ledger、tenants/current/tokens/grant、跨租户 403、Swagger /api/docs 全部正确
- Web 端到端（agent-browser）：登录页 / 工作台 / token 中心实际渲染，无 React 报错，账本明细正确展示发放记录

## [0.1.0] - 2026-09-24

### Added

- pnpm monorepo 脚手架（apps/api + apps/web）
- Docker Compose 基础服务：PostgreSQL 18 + pgvector、Redis；LiteLLM、MinIO 以 profile 按需启动
- NestJS 12 API 骨架：Prisma schema（租户/用户/角色/权限/成员关系/token 账本/审计日志）
- 认证：注册（自动建租户并授予 tenant_admin）、登录（JWT）、me
- 租户解析守卫（X-Tenant-Id，默认首个成员关系）
- RBAC 五角色权限体系（@casl/ability + 权限点守卫）
- token 计费：TokenService 事务扣减/发放、余额查询、账本明细
- React 19 + Ant Design 6 前端骨架：亮/暗/跟随系统三态主题、全宽响应式布局、登录页与主框架
- 冒烟脚本：health、注册、登录、me、token 扣减与余额不足拒绝
