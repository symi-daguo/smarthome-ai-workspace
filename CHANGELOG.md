# CHANGELOG

本项目遵循语义化版本（SemVer）。0.x 阶段 API 不做稳定性承诺。

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
