# CHANGELOG

本项目遵循语义化版本（SemVer）。0.x 阶段 API 不做稳定性承诺。

## [0.1.32] - 2026-10-12

### Added（全站马尾辫审查：token 安全 / iOS PWA / 部署一致性 / 版本同步）

按马尾辫 7 级决策阶梯做全站审查（联网核对官方最新版本 → 安全 → 板块闭环 → 多租户 → agent → 多端 → 仓库卫生），只修真实问题、不造重复轮子。

- **改密即作废旧 JWT（tokenVersion）**：`User.tokenVersion` + migration `20261012030000_user_token_version`；JWT payload 携带 `tv`，[jwt.strategy.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/auth/jwt.strategy.ts) 每请求与数据库实时比对，不匹配返回 401 TOKEN_REVOKED；改密自增版本号，旧 token **连 /auth/refresh 也无法换新**；前端个人中心改密成功后 800ms 自动登出引导重登；图片 ?token= 链接同步失效
- **iOS Safari PWA 兼容**：[index.html](file:///Volumes/hasskit/codex/aisaas/apps/web/index.html) 加 `viewport-fit=cover` + apple-mobile-web-app-capable/status-bar-style/title + mobile-web-app-capable；manifest 补 scope/orientation 与 `purpose: any maskable`（SVG 满幅底+居中 logo 天然满足 80% 安全区）；[styles.css](file:///Volumes/hasskit/codex/aisaas/apps/web/src/styles.css) 仅 standalone 模式应用 env(safe-area-inset-*) 顶栏/侧栏/底部安全区
- **ComfyUI 模板部署一致性修复**：`comfyui-workflow.json` 从仓库根 git mv 到 `apps/api/`（此前 Dockerfile 只 COPY apps/api，容器内模板 ENOENT，与模型配置页"内置模板可直接用"承诺不符）；[media.service.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.service.ts) 新增多候选路径解析（显式配置/CWD/apps/api/模块相对），容器与本地 dev 两形态均命中；JSON 非法时给 COMFYUI_WORKFLOW_INVALID 明确报错；前端文案同步
- **Agent 技能包补额度自查**：skillpack 端点表新增 `GET /api/tenants/current/tokens` 与账本端点，agent 调计费能力前可自查余额（402 闭环）
- **仓库卫生**：git rm `.codex-review/`（2 个含本机绝对路径的陈旧 skill 笔记，内容已并入 AGENTS.md 马尾辫规则）
- **依赖同步官方稳定版**（npm registry 核对）：@nestjs/core·common·platform-express 12.1.0→12.1.2、vite 8.3.0→8.3.4、lucide 1.53.0→1.55.0；react 19.3.0 / antd 6.6.5 / prisma 7.10 / @ant-design/x 2.9 保持最新；prisma 8 与 typescript 7 为 RC/大版本跳跃，按 YAGNI 不追（5.9.3 稳定无安全压力，TS7 升级独立评估）

### 审查通过项（无需改动）

- 安全：argon2 密码哈希+统一 INVALID_CREDENTIALS 防用户枚举；生产 fail-fast（JWT_SECRET/SEED_ADMIN_PASSWORD）；Swagger 生产关闭；CORS env 限定；trust proxy 1；全局限流 300/min + 认证 10/min；CASL RBAC 权限每请求实时加载；TenantGuard 校验 X-Tenant-Id 成员归属；业务表（产品/方案/图纸/订单/内容/素材）删除全部有租户归属前置校验
- 多租户：业务数据 tenantId 隔离完整；ModelSetting/ModelProfile 为 0.1.19 既定的平台级自部署架构（注册即部署者持 platform:billing:manage），SaaS 化运营时再租户化（0.2.0 演进项，本轮不擅自改架构）
- 板块闭环：17 路由 ↔ 57 条前端 API 调用 ↔ 11 controller 全部对应；百宝箱 16 张工具卡真实跳转；无 TODO/FIXME/console.log/原生 alert 死码
- 多端：PWA manifest/icon 经 nginx 200 + 正确 MIME；768/1440/1920/2560 响应式前轮实测无横向溢出

### Verified

- 门禁：typecheck ✓ / build ✓ / **smoke 106/106**（新增 5 条：改密成功/旧 token 立即 401/旧 token 不能刷新/新密码登录/新 token 恢复，RBAC 用例同步改用改密后新 token）
- 浏览器实测：PWA 6 个 apple/viewport meta 与 manifest maskable 就位；产品中心 11 列标准表头正确；模型配置 ComfyUI 新文案渲染；console 无 JS error/warn（仅 2 条 antd 表单 a11y issue 级框架提示）
- 部署核验：容器内 `/repo/apps/api/comfyui-workflow.json` 存在；api 日志 0 error；内存 api ~230MB / web 18MB / db 91MB / redis 76MB

## [0.1.31] - 2026-10-10

### Added（产品中心标准主数据 + 智能报价标准口径）

用户指出产品中心表格不是标准完整表格，价格定价不会定价、多级返利未体现、产品无 SN 码/编码；要求按标准 ERP/PIM 口径补齐，字段正确匹配。

- **Prisma Product 标准主数据** [schema.prisma](file:///Volumes/hasskit/codex/aisaas/apps/api/prisma/schema.prisma#L296-L340)：新增 `sku`/`barcode`/`snRule`/`spec`/`warranty` + 三级价格 `priceRetail/priceProject/priceDealer` + 多级返利 `rebateL1/rebateL2/rebateDesigner` 共 11 字段；migration `20261010030000_product_master_data` 已部署；`@@index([sku])`
- **zod 标准校验** [layout.schemas.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/layout/layout.schemas.ts)：返点 0-100、价格 0-10,000,000 整数上界；非法返点 400 拒绝；字段长度统一约束
- **Service 透传 + 旧参考价兼容** [layout.service.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/layout/layout.service.ts#L66-L128)：create/update/copy 完整持久化新字段；写入 priceRetail+priceProject 自动同步 `priceMin=工程`、`priceMax=指导`，保留点位清单兼容
- **内容提取价格同步** [product-sync.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/layout/product-sync.ts)：资料区间 min→project、max→retail；spec 入库；与布局点位 API 同源
- **Seed 21 款补全标准主数据** [seed.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/prisma/seed.ts#L124-L181)：每款含 SKU（如 GW-1001）+ 13 位店内码（21 前缀 EAN 保留段，非真实品牌码）+ SN 自有前缀（`SJ-GW-`/`SJ-LK-`）+ 规格 + 24-60 月质保 + 经销价 ≈ 工程价 × 0.9（小件 8/4/5%、中件 10/5/6%、大件 12/6/8% 三级返利）
- **产品中心标准宽表** [ProductCenter.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/ProductCenter.tsx#L342-L412)：11 列固定：产品（含 SKU）/分类/品牌·型号/商品条码/SN 码规则/规格参数/质保/指导价·工程价·经销价（三行）/多级返利（蓝·geekblue·紫 tag）/布置提示/操作；scroll x=1680 横向滚动防溢出
- **产品中心分组编辑表单** [ProductCenter.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/ProductCenter.tsx#L429-L526)：4 段（基本信息 / 编码标识 / 价格体系与多级返利 / 产品图），720px Modal，左右双列布局；保存前校验 `dealer ≤ project ≤ retail`，否则 message.warning
- **智能报价标准报价单** [QuoteStudio.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/QuoteStudio.tsx)：切换「官方指导价/工程价」计价口径 Segmented；每行 SKU/条码/SN/规格/单位/成本·对外单价/小计·毛利；底部 6 卡 auto-fit（对外报价合计/经销成本/毛利/三级返利测算）；导出 CSV 列含 SKU/条码/SN 规则/规格/质保/返点百分比
- **SkillPack 文档同步** [model-config.controller.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/llm/model-config.controller.ts)：POST /api/products/mine 与 PATCH /api/products/:id 新字段全部列入表格；agent 创建产品可直接带 sku/barcode/snRule/spec/warranty + 三价 + 三返利
- **短视频工作台宽屏布局** [BiographyStudio.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/BiographyStudio.tsx)：移除 MainLayout 对 /biography 的 padding 特判；pageContainerStyle 统一流式；三种专访方式三卡 auto-fit；当前方式选区 primary 描边/背景；IP 档案按 agent 字段真实读取 ChatStore

### Verified

- 门禁：typecheck ✓ / build ✓ / **smoke 101/101**（+4：标准主数据完整落库/三级价同步旧区间/返点 > 100% 被拒/标准字段 PATCH 同步）
- 端到端 API 实测：admin 登录 → GET /api/products → 21 行公共库产品全部带 sku/barcode/snRule/spec/warranty/三价/三返；POST /api/products/mine 写入 11 字段全数持久化
- 运行：api 日志 0 error，内存 api 128MB / web 8.7MB / db 87MB / redis 76MB 正常

## [0.1.30] - 2026-10-09

### Added（工作台输入区与真实能力对齐）

用户反馈工作台首页 4 个 div chip（上传附件 / 图生图 / 生视频 / 生方案）只是装饰、文字只追加到输入框、不触发功能；右侧发送位置无法选择模型；要求整个工作台每个功能都要正确可用、匹配真实数据和交互。

- **共享激活模型上下文** [configStore.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/configStore.tsx)：一次性拉取 `model-config` + `model-config/profiles`，向全应用暴露 `{ profileName, chatBaseUrl, chatModel, chatKeyConfigured, imageProvider, videoProvider, refresh }`；启动 + 发送后自动 refresh
- **聊天 store 使用真实 chatModel** [ChatStore.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/store/ChatStore.tsx)：`send()` 不再硬编码 `'MiniMax-M3'`，改用 `useActiveConfig().config.chatModel || 'MiniMax-M3'`，与命名方案激活/切换实时联动
- **Sender header 模型方案下拉** [Dashboard.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/Dashboard.tsx#L367-L405)：输入卡顶部显示「当前模型 · 方案 · 模型名」药丸按钮，Dropdown 显示当前激活项（不可点）+ 「去配置/切换方案」跳 `/model-config`
- **Sender footer 4 chip + 附件上传 + 缩略带 + 大图预览**
- **能力状态条可点击导航** CAPABILITY_TAGS 全部改为 `div role="button"` + keydown
- **TS 语法修复**：regex `\/` 后紧跟 `/` 歧义改写为 `\/` 紧跟非 `/`

### Verified

- 门禁：typecheck ✓ / build ✓ / smoke **96/96**
- 浏览器实测 http://localhost:5173/：`/` 200 text/html

## [0.1.29] - 2026-10-09

### Added（模型方案多套配置 + Agent 技能包 + Token 刷新 + PWA）

- **多套命名模型方案** `ModelProfile` 表（migration `model_profile`）：把当前对话/生图/ComfyUI/生视频/知识库各 scope 的配置整体快照为命名方案
- **Agent 集成技能包** `GET /api/admin/model-config/agent-skillpack`
- **JWT 刷新** `POST /api/auth/refresh` + `AuthContext.renewToken`
- **PWA 多端应用** index.html + manifest.webmanifest + icon.svg

### Verified

- 门禁：typecheck + build + 冒烟 **96/96**

## [0.1.28] - 2026-10-09

### Added（全局返回能力：任何子页面都能返回）

- 顶栏全局返回按钮 [MainLayout.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/layouts/MainLayout.tsx)
- 素材预览改应用内弹窗 [MaterialLibrary.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/MaterialLibrary.tsx)

## [0.1.27] - 2026-10-09

### Added（产品图方形裁切 + 全站导航文案统一）

## [0.1.26] - 2026-10-09

### Added（传图根因修复 + 图片压缩 + lucide 图标库 + 品类字典 + 品牌管理 + 知识库联动）

## [0.1.25] - 2026-10-09

### Added（全站流式布局无留白 + 产品中心补齐）
