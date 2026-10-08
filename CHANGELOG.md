# CHANGELOG

本项目遵循语义化版本（SemVer）。0.x 阶段 API 不做稳定性承诺。

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
