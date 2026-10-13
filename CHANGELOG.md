# CHANGELOG

本项目遵循语义化版本（SemVer）。0.x 阶段 API 不做稳定性承诺。

## [0.1.43] - 2026-10-13

### Feat（按 REA 逆向结论补齐功能）

对参考站做静态逆向（21 条路由 / 10 个端点 / 3 个懒加载模块，含 `ai-canvas.js`、`lighting-scene.js`、`route-loader.js`）后比对，发现并补齐：

- **工作台智能意图识别**（新增 `lib/intent.ts`）：输入时实时识别关键词并给出「前往某板块」的可点建议。
  覆盖生图/生视频/方案/报价/资料库/知识库 6 类。**刻意不照抄参考站的「发送即跳转」**——那会在用户只想聊天时把人强行带走；这里改为可忽略的建议条，并优先把问句（「怎么做…」「是什么…」）判为直接对话。实测 12 条样例全部命中预期。
- **生图「适配视频」参数**：`fitVideo` 真实生效——出图统一按 16:9 画幅，并在提示词追加「保持参考图构图不被硬裁切」，可直接把成图用作生视频首帧。
- **生图「背景」参数**：`transparent` / `white` 写进提示词约束（上游图像接口无独立背景参数，这是唯一可靠通道），`auto` 不干预。
- **参考图可从「我的资料库」选择**：与视频页首帧选择器同源实现（`/api/media/assets`），不重复造轮子。

### Fix（假控件：选了不生效）

- **生图「模型」下拉是假控件**：前端提供「精修 / 快速出图」两档，但后端 `generateImage` 从未使用 `dto.model`，实际用的是「模型配置」页配置的模型名——选哪档结果完全一样。已删除该下拉，改为**只读展示真实生效的模型名**并提供「去切换」入口。同时清理后端 `model` / `quality` 两个从不生效的参数。
- **生图参数区的三个禁用下拉**（质量/格式/背景，各只有一个选项且 `disabled`）是纯装饰。格式转换需要引入新的原生依赖（sharp），与其做一个选了不生效的下拉，不如：背景改为真参数、质量与格式整块移除。

### Chore（清理无效文件与死配置）

经全仓核实为**零引用**后删除：

- **compose 的 `redis` 服务**：`apps/**` 中 **0 个文件**引用它，却默认启动并占用一个容器与 6379 端口。已连同 `REDIS_URL`、`depends_on` 一并移除。
- **compose 的 `minio` 服务**（`profiles: storage` 从未启动）、**`litellm` 服务**（`profiles: gateway` 从未启动）及 `docker/litellm-config.yaml` 配置文件、`LITELLM_*` 注入项：同样零引用。
- 死导出：`categoryDictLoaded`（含只服务于它的 `loaded` 变量）、`normalizeCategory`。
- `docker/` 目录随之清空。

### Style（界面风格独立化）

此前品牌渐变 `#5B5BF0→#8E7BF6` 与主色 `#6D4DF6` **直接取自对标站**，视觉上难以区分。改为自有视觉语言：

- 主色改靛蓝 `#4F46E5`，渐变改 `#4F46E5 → #6D3BEF`（更沉更冷）；
- 新增青绿点缀色 `#0FB5A5` 与两级卡片阴影（冷调，不用中性黑灰）；
- 正文墨色 `#1C1B2E`（比纯黑柔和，长文更舒适）；转角 8 → 12。

信息架构与交互模式保持对齐，视觉语言独立——开源后一眼能看出是自有产品。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **150/150**
- 意图识别逻辑经 12 条真实样例逐条复核（含问句与过短输入的不打扰行为）
- `docker compose config` 校验通过，服务收敛为 `db` / `api` / `web` 三个

## [0.1.42] - 2026-10-12

### Fix（构建可靠性：registry 未固定导致容器构建偶发失败）

根因：项目 `.npmrc` 未声明 registry，容器内走官方源 `registry.npmjs.org`；本机全局
`~/.npmrc` 配的国内镜像**不进镜像**，导致 `pnpm install --frozen-lockfile` 在容器里偶发
`error (23)` 失败、重跑即恢复。硬编码国内镜像会连累 CI 与海外部署者，故改为可配置 + 多层加固。

- **registry 改为构建参数**：两个 Dockerfile 加 `ARG NPM_REGISTRY`，compose 通过
  `${NPM_REGISTRY:-}` 透传。默认留空=官方源（CI/海外正确选择）；国内网络用
  `NPM_REGISTRY=https://registry.npmmirror.com/ docker compose build`，无需改仓库文件。
- **网络退避重试**：`.npmrc` 补 `fetch-retries=5`、`fetch-retry-mintimeout=20000`、
  `fetch-retry-maxtimeout=120000`、`network-timeout=300000`。纯重试参数，不改变解析结果。
- **BuildKit store 缓存**：两个 Dockerfile 的 install 层挂
  `--mount=type=cache,id=pnpm-store-{api,web},target=/pnpm/store,sharing=locked`，
  配合 `package-import-method=copy`（否则 node_modules 是指向构建期挂载的软链，运行期会失效）。
  api/web 用独立 cache id 避免并行构建争锁。
- **供应链防护**：`pnpm-workspace.yaml` 启用 `minimumReleaseAge: 1440`（新版本满 24 小时才可安装），
  并删除已失效的 `minimumReleaseAgeExclude`（lucide 1.55.0 现已超过窗口，留着是无效豁免）。

### Docs

- README 新增「构建期网络配置」小节：参数用法、三层防护表与各自的实测依据。
- `.env.example` 新增 `NPM_REGISTRY`（默认空=官方源）。

### 关键实测结论

- `minimumReleaseAge` 不能取 7 天（10080）：本项目 Vite 8 / Rolldown 迭代极快，
  7 天窗口会拒掉 `@rolldown/binding-*` 1.2.13、`@napi-rs/canvas` 1.0.11、
  `@oxc-project/types` 0.153.0 等近 7 天发布的包并**直接打断构建**。24 小时既能挡投毒
  （攻击通常数小时内被发现下架）又不误伤正常跟进。
- BuildKit 缓存命中实测：二次构建 258 个包全部复用、**零下载**，构建耗时 26.9s（冷构建约 2min）。
- `package-import-method=copy` 运行时完整性实测：容器内 `apps/api/node_modules` 悬空软链数
  **0**，`@prisma/client` / `argon2`（含原生二进制 prebuilds）均正常加载。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **150/150**
- 默认（官方源）`docker compose build` ✓ 全量通过，构建日志确认走 `使用默认 registry（官方源）`
- `NPM_REGISTRY=https://registry.npmmirror.com/ docker compose build` ✓ 生效，构建日志确认
- 全栈 `docker compose up -d` 后：`/api/health` 返回 ok、5173 返回 200

## [0.1.41] - 2026-10-12

### Fix（复刻一致性：百宝箱预览图与板块语义错配）

对照参考站逐卡比对，发现我方百宝箱 19 张工具卡的预览图是同一批深色调室内效果图在循环
（`STACK_IMGS` 按下标取模），导致至少 12 张与板块语义不符：文案仿写配暗色客厅、节假日
海报配暗色走廊、WiFi 热力图配紫色灯带客厅、点位布局配客厅效果图、定制智能体与问题反馈
同样配客厅图。原站每张卡配的是与工具对应的实拍/示意图，且整体为明亮色调。

- 按 19 个工具逐一生成语义匹配的预览图，落 `public/images/tools/`，全部统一明亮色调对齐原站：
  文案仿写→文稿+笔记本+笔、视频封面→举手机自拍、节假日海报→春节红金海报三连、
  小红书生图→手绘平面图+设备清单、户型方案长图→竖版平面图+清单、
  平面图转彩平图→彩色平面布置图、平面图生效果图→平面图+两间效果图对照、
  毛坯房效果图→毛坯/精装同户型对比、WiFi 热力图→平面图叠蓝绿黄覆盖、
  点位布局→平面图彩色点位+图例、灯光点位→暖光光晕平面图、灯光场景→暖光客厅、
  产品库→设备白底网格、智能报价→报价单表格、GEO→地图搜索页、视频代剪→剪辑时间线、
  定制智能体→智能体配置表单、问题反馈→工单状态进度条。
- `ToolDef` 增加必填 `img` 字段，删除 `STACK_IMGS` 下标取模逻辑——从此**新增工具不填图会编译报错**，
  从机制上杜绝再次错配。
- 卡版式对齐参考站：网格 `minmax(220px)→minmax(300px)`（宽屏每行 5 张）、预览图 `150×98→196×128`
  并水平居中、角标从标题行移到图片右下角、标题改为独占一行。
- 堆叠三层改用不同 `background-position` 取景，避免同一张图原样重复三次的廉价感；主层补投影。
- 图片统一压到 480px / JPEG q82，19 张合计 568KB（生成原图约 13MB）。
- 卡片预览补 `role="img"` + `aria-label`，底层两层 `aria-hidden`。

### Docs

- `replica/features.csv` 更新百宝箱一行：预览图由「堆叠图+角标」改为「19 张语义匹配预览图」。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- 19 张生成图经拼图逐张人工复核，语义全部对应，无错配
- 部署后 `/images/tools/*.jpg` 可正常访问

## [0.1.40] - 2026-10-12

### Feat（补齐复刻缺口 5 类）

对照参考站 2026-10-12 的实际模块清单核对后补齐（原状：百宝箱 19 张卡中多张只是跳转到通用页面）：

- **智能灯光场景演示**（新页面 `/lighting`）：上传效果图 + 选画幅 → 编排灯具（吸顶灯/射灯/灯带/落地灯/台灯，可拖动移位、改类型、上下调序、增删、设常暗）→ 手工灯光时间轴（每盏灯一条轨道、关键帧调亮度与色温、可播放实时预览）→ 以参考图为首帧出片。编排结果落 `LightingScene` 表可复用；**预览与出片共用同一份 fixtures + timeline**，不存在「预览一套、出片另一套」。色温按线性插值映射暖冷光晕。
- **生图四类业务子工作流**（`ImageStudio` 新增 5 模式切换）：
  - 毛坯房效果图——照片必传 + 8 种装修风格单选 + 可叠加 ≤3 灯光场景；提示词以「承重墙与隔墙走向、门窗洞口、阳台飘窗、层高、机位透视全部与原图一致，只做装修不改格局」开头；
  - 视频封面——照片 + 主题必传，一键经 `/api/llm/chat` 生成大标题/左侧标签/右侧 3 卖点，结果可编辑，解析失败不阻断；
  - 节假日海报——12 个节日 + 门店名必填，固定竖版 2:3；
  - 平面图转彩平图——户型图 + 5 种配色风格，**比例随风格自动适配**。
  - 关键实现：后端 `size` 只有 1536x1024 / 1024x1536 / 1024x1024 三个合法值，2:3 与 3:4 无法直传，故采用「最近合法像素给后端 + 比例意图写进提示词」的双层表达。
  - 原有「自由生图」模式零改动，场景 chip 与案例库行为保持原样。
- **问题反馈**（新页面 `/feedback`）：任意角色可提交故障/建议/其他；管理员同页回复并按 待处理 → 处理中 → 已解决 → 已关闭 单向流转；处理进度对提交者可见；仅提交者本人可删除。
- **定制智能体落库**：`CustomAgent` 表替代 localStorage，租户内重名 409、跨租户 404、头像色 `#RRGGBB` 校验；换设备或清缓存不丢，团队成员可见。
- **会员与额度页**（新页面 `/vip`）：如实说明「开源免费自部署、注册即解锁全部能力、无需开通套餐」，列出已解锁能力清单与需要联系官方的三种情形。顶栏「开通会员」入口改为「会员与额度」。

### Fix（真实缺陷）

- **未知路由渲染整页空白**：内层 `Routes` 没有兜底，旧收藏或手输错字会白屏。补 `path="*"` 回首页。
- **反馈状态机静默吞掉非法流转**：原实现对 `open→closed`、`closed→resolved` 等非法组合返回 200 但状态不变，调用方无法区分成功与被忽略。改为返回 `400 INVALID_STATUS_TRANSITION:x->y`，并补 2 条用例（跳级拒绝 + 非法流转不改状态）。
- **反馈权限让只读成员无法反馈**：`content:generate` 不含 `viewer` / `operator`，意味着权限最低的人恰恰报不了问题。改用项目里本就存在但全站未被消费的 `cs:manage`，并把它补进 `designer` 与 `viewer` 角色——反馈入口不再因角色低而关闭。

### Refactor

- `apps/web/src/data/customAgents.ts` 从 localStorage 读写改为 API 调用。

### Docs

- README：api 模块清单补 `agents`/`feedback`/`lighting`；新增灯光场景、问题反馈、会员与额度三段说明。
- `replica/features.csv`：新增 8 行（灯光场景、4 类生图工作流、问题反馈、定制智能体落库、会员页、路由兜底）；顺带修复 2 行**伪 CSV**（markdown 列表混入 CSV 表），修复后全表 76 行统一 6 字段。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **150/150**（120 → 148 新增 28 条 → 150），连续多次运行均全绿
- 手机视口（390×844）实测：登录页与新建页面无横向溢出

## [0.1.39] - 2026-10-12

### Fix（真实缺陷）

- **smoke 不可重复运行**：`ModelProfile` 是全局表，命名方案用例断言依赖「首个方案自动成为当前」，而上轮用例会遗留一个 active 的「方案B-高质量」，导致第二轮 `saveProfile` 走 upsert 的 update 分支（该分支不改 `active`），断言必然失败。现于用例起始处清理本用例自己的方案名，`pnpm smoke` 可反复执行。
- **「永久会员」标签恒不显示**：`TokenCenter.tsx` 用 `membership.plan === 'lifetime'` 判定，但 Prisma `Plan` 枚举只有 `BASIC / STANDARD / ENTERPRISE`（且大小写不匹配）。改为按枚举实际取值渲染套餐标签。

### Refactor

- 模型配置菜单变量 `isSuperAdmin` → `canManageModels`：该变量判定的是 `platform:billing:manage` 权限（seed 中 `tenant_admin` 与 `super_admin` 都有），旧名会误导后来者以为仅超管可见。

### Docs（文档与代码对齐）

- README：品类字典 24 → **39**（并补全 39 项清单）、备份 **18 表 → 22 表**、目录树补 `knowledge/` `orders/` `common/` `prisma/` 与 web 的 `components/` `store/` `data/`、账本「充值/退还」改为标注为预留未接入、素材库「我的投稿」补未接入说明。
- `schema.prisma:346` 注释 24 类 → 39 类（与同文件 305 行一致）。
- `replica/features.csv`：百宝箱 18 → **19** 工具卡、品类字典 24 → **39**。
- 规划文档 §7.1 版本表 NestJS 12.0.x → **12.1.2**、Vite 8.3.0 → **8.3.4**；BullMQ「已随技术栈引入」与 RLS「兜底」改为如实标注**未落地**；§7.4 补本版本行。
- CHANGELOG 0.1.38 自述的三处版本号与实际锁定不符（throttler 6.7.1→6.7.0、pg 8.23.1→8.23.0、plugin-react 6.1.2→6.1.1），已订正。
- `.env.example`：删除代码从未读取的 `STORAGE_DRIVER` / `LOCAL_STORAGE_PATH`，改为代码实际读取的 `UPLOAD_DIR`；补 `PUBLIC_ORIGIN`。
- `pnpm-workspace.yaml`：`minimumReleaseAgeExclude` 写的 `lucide@1.53.0` 与实际依赖 1.55.0 不符，已订正并注明当前该配置未生效。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **120/120**，且**连续两次运行均全绿**（修复前第二次为 119/120）
- 本机 Docker 全量重建并重启后：`GET /api/health` 返回 `{"status":"ok"}`，`http://127.0.0.1:5173/` HTTP 200

## [0.1.38] - 2026-10-12

### Chore（技术栈 patch/minor 跟进，确保 2026-10 以来最新稳定版）

按 §42 版本审计结论（[.ref-site/采集记录.md](file:///Volumes/hasskit/codex/aisaas/.ref-site/采集记录.md) §42），3 个低风险文档解析依赖跟进最新稳定版：

- **jsdom** `^30.1.1 → ^30.1.2`（npm 30.1.2，2026-10-06 发布的 patch）
- **mammoth** `^1.12.3 → ^1.13.0`（npm 1.13.0，2026-09-28 发布的 minor，API 无 breaking：仅新增"hyperlinked wp:anchor/wp:inline 处理" 等增量）
- **pdfjs-dist** `^6.3.289 → ^6.4.299`（npm 6.4.299，2026-10-04 发布的 minor，修复 PDF 解析兼容性）

**未改动项（major bump 不追）**：Prisma 7.10.0（8.x 是 RC）、TypeScript 5.9.3（6.x/7.x 是 major）、React Router 7.18.4（v8 是 major）；其他 patch 跟进项（@nestjs/throttler 6.7.0 / pg 8.23.0 / @vitejs/plugin-react 6.1.1）保持当前锁定，下次维护迭代一并评估（无紧急）。

### Verified

- `pnpm install --no-frozen-lockfile` ✓（自动同步 pnpm-lock.yaml）
- 门禁：`pnpm typecheck` ✓ / `pnpm build` ✓（api + web 双侧通过）
- `pnpm smoke` ✓ **120/120**（含新增精装修 404 断言）
- `docker compose up -d --build api web` ✓（api/web 镜像重建 + 启动）

## [0.1.37] - 2026-10-12

### Fixed（PPT 底部间距 + 上传平面图入口 + 精装修效果图生成）

用户截图反馈 "PPT 两页底部没留白，文字超出范围"+ "少了上传平面图/设备点位图功能"+"客户平面图需要生成对应精装修效果图" 三条，按 Replica+Ponytail 7 级阶梯（**先 MD 记录避免失忆**）对照 recon F02/S05/S06 后落地：

- **PPT 底部间距** [PlanSlide.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/components/PlanSlide.tsx)：Frame 内 padding 底部 `3.5% → 5.5%`（5 处）、PointCard gap `1.1cqw → 1.25cqw`（4 处）、Footer marginTop `1.2cqw → 1.6cqw`（3 处）、NeedsSlide 下半部 padding `3% → 5%`；第 8 页（6 个分项预算区间条）与第 9 页（6 个阶段卡片+金句+Footer）已在浏览器实测全部完整显示
- **上传平面图入口始终可见** [PlanStudio.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/PlanStudio.tsx)：底部工具栏从 `active.type === 'layout'` 条件改为始终显示，新增"上传平面图 · 布点"按钮（按 floorplanAssetId + layoutPoints 状态切换"已布 N 个点位 · 重新布点 / 户型图已上传 · 布点 / 上传平面图 · 布点"三种文案），跳转 `/device-layout?planId=…` 不重复造轮子
- **精装修效果图端到端**：新增 [Prisma 字段 renderedFloorplan_asset_id](file:///Volumes/hasskit/codex/aisaas/apps/api/prisma/schema.prisma) + [migration](file:///Volumes/hasskit/codex/aisaas/apps/api/prisma/migrations/20261012050000_plan_rendered_floorplan/migration.sql)；[PlansService.renderFloorplan](file:///Volumes/hasskit/codex/aisaas/apps/api/src/plans/plans.service.ts) 校验 floorplan 必填 → 扣 300 token → 拼风格+生态 prompt → 复用 MediaService provider 适配层（comfyui/openai/minimax）→ 1536×1024 → MediaAsset 入库 → 自动挂 `PlanProject.renderedFloorplan_asset_id`；[PlansController POST :id/render-floorplan](file:///Volumes/hasskit/codex/aisaas/apps/api/src/plans/plans.controller.ts)；[PublicPlansController GET :token/rendered-floorplan](file:///Volumes/hasskit/codex/aisaas/apps/api/src/plans/plans.controller.ts) 公开分享端免登录文件输出
- **前端联动** [PlanStudio.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/PlanStudio.tsx)：工具栏新增"生成精装修效果图"按钮（disabled 直至 floorplan 上传，loading 态）；[PlanShareView](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/PlanShareView.tsx) slidePlan 新增 renderedFloorplanUrl；[planPptx.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/planPptx.ts) LayoutSlide 优先级 精装修图 > 户型+点位合成图 > 场景实景图
- **smoke +1 断言**：方案不存在时精装修渲染 404

### Verified

- 门禁：typecheck ✓ / build ✓ / **smoke 120/120**（含新增"方案不存在时精装修渲染 404"）
- 浏览器实测：第 1 封面页 / 第 8 预算页（6 条预算条+金句）/ 第 9 落地页（6 阶段卡片+金句+Footer）均完整，底部间距充足；工具栏"上传平面图·布点"始终可见、"生成精装修效果图"未上传户型图时 disabled（符合预期）
- 分享页 [share/plan/:token](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/PlanShareView.tsx) 同源呈现，所有卡片完整无截断
- 关于 [ppt-master](https://github.com/hugohe3/ppt-master)：其本质是用户本地 Python + AI agent 工作流（依赖 Python 运行时与外部 agent），与本 SaaS SPA "浏览器内一键生成"场景不符，按 Ponytail 阶梯 1 (YAGNI) + 5 (已装依赖 pptxgenjs 足够) 判定**不引入**；但吸收其 slide master / 原生 shapes / 编辑性优先的设计原则

## [0.1.36] - 2026-10-12

### Verified（生图/生视频/智能方案 端到端 Agent 验证）

按用户要求用 agent + token 全链路验证各核心能力（不依赖浏览器反复登录），结果全部真实通过：

- **LLM 对话** [POST /api/llm/chat](file:///Volumes/hasskit/codex/aisaas/apps/api/src/llm/llm.controller.ts)：MiniMax-M3 回复"武汉4月通常15-25°C..."真实有用，扣 3 token
- **生图** [POST /api/media/images](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.controller.ts)：image-01 返回 1024×1024 JPEG 388KB 真实图片，扣 300 token
- **生视频** [POST /api/media/videos](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.controller.ts)：T2V-01 返回 5 秒 869KB MP4 真实视频，扣 1500 token
- **智能方案 9 页 LLM 生成** [POST /api/plans](file:///Volumes/hasskit/codex/aisaas/apps/api/src/plans/plans.controller.ts)：封面页正文含客户姓名"张先生"、户型"三室两厅"、生态"米家+小度"、三代同堂日常语气；9 页 × 100 = 900 token
- **公开分享免登录** [GET /api/public/plans/:token](file:///Volumes/hasskit/codex/aisaas/apps/api/src/plans/plans.controller.ts)：返回 9 页方案内容
- **图片上传** [POST /api/media/uploads](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.controller.ts)：落盘 + MediaAsset
- **文件流** [GET /api/media/assets/:id/file?token=](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.controller.ts)：200 + 真实二进制
- **Agent 人设**（a3 朋友圈 systemPrompt）：注入生效，输出口语化 200 字内含九宫格建议
- **账本对账**：SUM(TokenLedger.delta) = tenant.tokenBalance = 95797 完美一致（每次 consume/grant 均事务内同步余额与流水，0 漂移）

### Verified

- 门禁：typecheck ✓ / build ✓ / **smoke 119/119**
- 容器状态：api 140MB / web 9.46MB / db 33MB / redis 14MB 正常，api 日志 0 error/warn
- 信息安全：tenantId 隔离 + token 鉴权 + 公共产品图引用保护全部生效

## [0.1.35] - 2026-10-12

### Added（我的资料 CRUD 补齐：最基本的备份/修改/删除能力）

用户审查指出"新建和上传的资料要支持备份、修改和删除这种最基本的功能目前都没有处理好"。按马尾辫 7 级阶梯核查：

- **存量 CRUD**：Product（我的库）/Category/Layout/Plan/Order 都有完整 Post/Patch/Delete + 前端按钮，OK
- **缺失**：`MediaAsset`（图片/视频上传/生成的产物）后端只有 POST + GET，**完全没有 PATCH/DELETE**；前端 [MyAssets.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/MyAssets.tsx) 只有"下载"链接，没有重命名/删除按钮
- **缺失**：[ContentExtract](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/ContentExtract.tsx) 的"提取任务"与"已入库文档"两个表都**没有删除列**（后端 DELETE 端点原本就在 content.controller 路由下）

**补齐（不造轮子，复用现有 storage/cleanup 的引用保护思路）：**

- **后端 [MediaService](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.service.ts)** 加 `renameAsset` + `deleteAsset`：本租户 findFirst（404 越权），公共产品图 imageUrl 引用保护（同 storage/cleanup 的引用解析，400 ASSET_REFUSED_BY_PRODUCT），删除后异步 unlink 本地文件并 try/catch（文件不在照常删行）；[MediaController](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.controller.ts) 加 `PATCH /api/media/assets/:id` + `DELETE /api/media/assets/:id`；[media.schemas.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.schemas.ts) 加 `renameAssetSchema`（trim+min 1+max 100）
- **后端 [ContentService.removeDocument](file:///Volumes/hasskit/codex/aisaas/apps/api/src/content/content.service.ts)** 同时支持 `documentId` 与 `jobId` 两种入参：jobs 表 JobRow 用 jobId、已入库文档用 documentId，前后端共用一个 DELETE 端点
- **前端 [MyAssets](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/MyAssets.tsx)**：每张图片/视频卡片加"更多操作"Dropdown 菜单，含"重命名"+"删除"。Dropdown item 内嵌 Popconfirm 在 antd v6 + Dropdown 下被外层 outside-click 关掉（实测 bug），改用 antd Modal 二次确认——更稳，禁用文案统一："确定删除「X」？文件会一并清理，方案/产品引用中时会被服务端 400 拒绝"
- **前端 [ContentExtract](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/ContentExtract.tsx)**：两个 Table 的"操作"列加 antd Popconfirm 删除按钮，jobs 行删（jobId）+ docs 行删（documentId）都走 `DELETE /api/content/extractions/documents/:id`
- **路径 bug 修复**：原 controller `@Controller('content/extractions')` 前缀下，`Delete('documents/:id')` 实际为 `/api/content/extractions/documents/:id`，原 smoke 测过 list 但没测过 delete → 本版补齐 DELETE 断言覆盖此路径
- **smoke +11 断言**：media PATCH 重命名 200 / 空标题 400 / 跨租户 404 / 公共产品图引用保护 400 / 解引用后 200 / DELETE 跨租户 404 / DELETE 200 / 已删再删 404；content DELETE jobId 200/204 / 删除后列表不见 / 重复删 404

### Verified

- 门禁：typecheck ✓ / build ✓ / **smoke 119/119**（+11 资料 CRUD 断言）
- 浏览器实测 MyAssets：上传一张图→点"更多操作"→"重命名"弹 Modal 改"big-photo-重命名后"→保存→列表更新；点"更多操作"→"删除"弹 Modal 二次确认→确定→列表去掉该卡
- 浏览器实测 ContentExtract：jobs 表"删除"按钮→Popconfirm→"删除"→任务 3→3 行（之前 4 行）
- 运行：api 133MB / web 9.78MB / db 32MB / redis 14MB 正常，api 日志 0 error/warn

## [0.1.34] - 2026-10-12

### Added（AI 智能体显式人设：点击即调用该角色，不再靠名字猜测）

0.1.33 给 12 个种子智能体配了首条任务 starterPrompt，但 role 人设仍由 ChatStore 按名字 `include('朋友圈'|'脚本'|'直播'...)` 模糊匹配——6 个名字不带关键词的角色（直播逐字稿/开头优化/vlog/第一视角/活动策划/GEO）启用后会落到通用兜底「你是「X」智能体」，不专业。本版让智能体"自带人设"，点击=直接调用该角色。

- **12 个智能体每个配显式 systemPrompt** [agents.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/data/agents.ts)：每个 AgentDef 新增 `systemPrompt` 字段，80-150 字中文明确"服务谁/输出格式/口吻"，例如短视频脚本 =「按镜头序号、画面内容、运镜、口播、时长的分镜表格，口语化有节奏」、直播逐字稿 =「按开场/套餐/互动/逼单四段可直接照读」、朋友圈 =「200 字内有现场感、配九宫格与定位、不用违规极限词」
- **点击显式传递人设** [AgentMarket.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/AgentMarket.tsx)：`openAgent` 用 `navigate('/', { state: { agent, systemPrompt, prompt } })` 同时携带 systemPrompt 与 starterPrompt；自建智能体走同样的 state 通道
- **ChatStore 优先用传入 systemPrompt，保留名字兜底** [ChatStore.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/store/ChatStore.tsx)：`effPrompt ?? systemPromptFor(effAgent)`——有显式人设走显式，没传（如旧的持久化会话）才回退到名字猜测，向后兼容
- **仓库卫生 · .gitignore 补 `replica/diffs/`**：避免后续差异图误入索引（clone-screens/diffs 是 0.1.15 历史遗留，本版不清理历史索引避免改写提交记录）

### Verified

- 门禁：typecheck ✓ / build ✓ / smoke 108/108
- 浏览器实测：朋友圈文案卡片→跳工作台→输入框已带"今天交工了一套 128㎡ 的三室两厅全屋智能..."完整首条任务，输入框上方显示智能体名（确认生效链路：state.systemPrompt → Dashboard.promptRef → ChatStore.send → WorkbenchConversation.systemPrompt）

## [0.1.33] - 2026-10-12

### Added（AI 智能体/生图/生视频：点击即匹配完整提示词，复刻交互闭环）

用户指出三个板块不能只有界面、点图片只给几个字；对照复刻项目 recon（S05 智能体卡片开聊、S06 场景 chip 填提示词、F03「场景 chip 自动填描述」）逐一核对后重做交互逻辑：点什么就自动出现可直接生成的完整提示词。

- **AI 生图 · 场景 chip 点击即写提示词** [ImageStudio.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/ImageStudio.tsx)：17 个场景 chip 不再只在提交时偷偷拼接，点击即把完整画面描述（空间/风格/光色/构图/材质/真实感，40-80 字）以〔场景：…〕标记写进 textarea，可见、可删、可二次编辑，再点取消精确移除该句不污染手写内容，最多 3 个
- **AI 生图 · 案例库点击填完整描述**：5 张案例卡点击写入整段可直接生成的海报/场景提示词（原来只有半句「参考…风格：」占位）
- **AI 生图 · 参考图真实上传 + 一键反推提示词**：参考图上传此前被拦截提示「0.2.0 开放」是假入口，现走 /api/media/uploads 真实落盘+压缩+缩略预览；新增 [POST /api/media/images/reverse-prompt](file:///Volumes/hasskit/codex/aisaas/apps/api/src/media/media.controller.ts)：视觉模型读取参考图输出 120-260 字覆盖空间/风格/色调/构图/材质/灯光的中文描述并回填——这是 image-01 等纯文生图 provider 下保证「同一张参考图 100% 同风格出图」的行业标准做法（先反推再文生）；模型不支持视觉时 503 诚实提示，不假装成功
- **AI 生视频 · 8 场景完整分镜 + 案例联动** [VideoStudio.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/VideoStudio.tsx)：场景从 5 个扩到 8 个（新增归家动线/晨起唤醒/窗帘开合），每条 hint 升级为含机位/动作/光色/时长的完整分镜描述；新增 3 张视频案例卡点写入分镜文本框并提示「先在 AI 生图出图再作首帧」，与首帧图生视频（I2V-01-Director）串成 F03 闭环
- **AI 智能体 · 12 个种子智能体配专属首条任务** [agents.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/data/agents.ts)：每个智能体新增 starterPrompt（具体到门店真实任务，如朋友圈「128㎡交工 3 条风格文案+九宫格建议」、投流「武汉光谷 3 条钩子文案」），点卡片即带入工作台输入框可直接发送；自建智能体生成开场确认任务；点击未启用卡片仍先提示开开关
- **Agent 技能包同步**：skillpack 增加反推提示词端点与图生视频首帧串联说明，agent 可自主完成「上传参考图→反推→生图→作首帧→生视频」全链路

### Verified

- 门禁：typecheck ✓ / build ✓ / **smoke 108/108**（+2：反推 assetId 非法 400、真实资产 200/503 诚实可达）
- 浏览器逐点击实测：生图 chip 多选→textarea 实时出现 2 段〔场景：〕完整描述、再点取消精确移除、案例卡写入海报整段；生视频 8 chip 与归家动线描述回填、3 视频案例在位；智能体朋友圈卡片→跳工作台且输入框已带完整首条任务
- console 无 JS error（仅 1 条 antd 表单 a11y issue 级框架提示）；api 日志 0 error；内存 api 127MB / web 14MB / db 32MB / redis 76MB

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
