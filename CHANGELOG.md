# CHANGELOG

本项目遵循语义化版本（SemVer）。0.x 阶段 API 不做稳定性承诺。

## [0.1.53] - 2026-10-14

### Feat（Agent 机器接入：独立身份 + 能力清单 + 全量审计 + 操作前快照还原）

用户提出四条诉求：额度入口在哪、多端能否打包成 exe/mac、**Agent 要能不看界面就操作系统**、
**每个动作可追溯、误操作能还原、还不能烧太多 token**。后三条本版交付，前两条的结论见文末。

#### ① 独立服务账号 + 可撤销 API Key（复用现有 RBAC）

此前只有手机号+密码换 JWT，Agent 若直接持有人的登录密码，泄露即等于交出整个租户。

- `POST /api/agent/service-accounts` 建机器账号：手机号位是 `svc_` + uuid（登录接口只认手机号格式，
  因此**天然登不进来**），密码哈希存随机值，`isServiceAccount=true`
- `POST /api/agent/keys` 签发 Key：**凭证本身就是一枚用 `JWT_SECRET` 签名的 JWT**，payload 带 `ak`=行 id。
  库里**不存任何密钥材料** —— 即使数据库整体泄露也推不出可用凭证（拿不到 `JWT_SECRET` 就伪造不出来）。
  吊销 = 打 `revokedAt`，与「改密让旧 token 全失效」同一条机制
- **收益**：20 多个控制器**一行都不用改**就支持了 Agent 接入 —— 认证、RBAC、多租户全部沿用现成链路

**一次权限定过头的自我纠错**：最初用 `platform:tenant:manage` 保护建号/发 Key，实测 403 ——
那是平台级权限，开源自部署的租户管理员根本没有，结果是「谁也发不出 Key」，功能等于不存在。
改用 `tenant:member:manage`（租户管理员自带）。同时给 tenant_admin 补 `platform:audit:view`：
审计建了却没人看得到，追溯能力等于白建。

#### ② 能力清单 manifest（这是省 token 的关键）

Agent 要摸清系统能干什么，最省钱的办法不是读源码，而是读一份结构化清单。按需取：

| 取法 | 实测 | 用途 |
|---|---|---|
| `/api/agent/manifest` | **1713 tokens** | 索引：18 组 + 破坏性操作清单 |
| `/api/agent/manifest?group=quote` | **658 tokens** | 只取报价这一组 |
| `?full=1` | ~3.4k tokens | 全量 124 条路由 |

**漂移守卫**：smoke 从源码反推真实路由，与清单**双向**比对 —— 新增接口忘了写进清单 → FAIL；
清单写了代码里没有的路由 → 同样 FAIL。这个守卫当场抓出 8 处漏项与 1 处虚构路由
（含一个代码里根本不存在的 `PATCH /api/plans/{id}`，会把 Agent 带进沟里）。

#### ③ 全量审计（此前形同虚设）

实测：**全项目只有 llm / layout / knowledge 三处手写 `auditLog`**，报价、接单、灯光、画布、方案、
智能体、反馈**一条都不记**。靠自觉补是补不齐的，且以后每加一个 service 都会再漏一次 ——
改由**全局拦截器兜底**（Nest 的 `APP_INTERCEPTOR`），这是唯一能保证「不漏」的位置。

每条记：谁（`USER` 人点的 / `AGENT` 机器跑的 / `SYSTEM`）、时间、接口、方法、状态码、耗时、
请求体 **SHA-256 摘要**。**存摘要不存明文**是刻意的 —— 报价单与接单记录里全是客户姓名电话。
客户端带 `X-Request-Id` 可把一串动作串成一次任务。

#### ④ 操作前快照与还原（含自动兜底）

- `POST /api/agent/snapshots {label}` 把该租户 20 张相关表整成 JSON 存下
- `POST /api/agent/snapshots/{id}/restore` 还原。**`confirm` 必须是快照 id 前 8 位** —— 防手滑调错快照
  把整租户还原掉；**同一份快照不允许反复还原**，否则会把后续的正确操作一起冲掉
- 还原采用「按 id upsert + 删掉快照里没有的行」，不是「整表清空再插」：子表 upsert 时父行已存在，
  外键不会断；只碰本租户；中途失败重跑幂等
- **自动兜底**：破坏性操作（DELETE 或清单标 `risk=destructive`）在调用方没自带 `X-Snapshot-Id` 时，
  拦截器先打一份 `auto` 快照再放行，快照 id 记进对应审计行。
  识别方式从清单转运行时模式（`:param` → 匹配任意段），**不给每个端点手工打标** ——
  手工打标漏一个就等于没防护，而漏的那个恰好最容易被误调
- **快照刻意不含** `AuditLog`（还原它等于改写「谁动过」这段历史）与模型配置（部署级共享，
  还原会连别的租户一起改）

> ⚠️ **能力边界，不做万能后悔药暗示**：快照只还原**数据库里的行**。
> 已经扣掉的额度、已由外部 API 生成的图片/视频、已发出的通知**撤不回**。
> 这句话在快照详情、manifest 响应、README 三处都显式返回。

#### 端到端实测（对部署后的真实服务，不是只跑 smoke）

```
1 登录 → 2 建机器账号 svc_e744…(viewer) → 3 签发 Key → 4 用 Key 访问成功（权限 2 项）
5 manifest 索引 1713 tokens / 单组 658 tokens
6 viewer 用 Key 写操作 → HTTP 403（RBAC 生效）
7 新建产品 25 → DELETE 不带快照 → HTTP 200 → 自动生成 AUTO 快照 → 24
8 confirm=wrong 还原 → HTTP 400；confirm 正确 → 还原后 25，被删产品回来了
9 审计按 requestId 查回 DELETE 行，snapshot 字段有值
10 revoke Key → 立即 401
```

### Chore（桌面打包方案的查证结论，见 [桌面打包方案.md](./桌面打包方案.md)）

用户要求打包成 exe 与 macOS 安装应用。**先纠正一个前提：提交 GitHub 并不会自动构建** ——
本仓库至今零 CI（`.github/workflows/` 不存在），推上去只更新源码。
而且这是服务端 SaaS，数据库与模型密钥必须留在服务器，客户端只能是壳或内嵌整机。

联网查证后的结论（关键项均已双源核实，许可证逐个查实）：

- **推荐 Electron 而非 Tauri 2**：Electron 的 `utilityProcess` 自带 Node，NestJS 零改造直接跑；
  Tauri 要为四个平台组合各构建一份 Node sidecar。**但若走「纯壳连服务器」路线，Tauri 反而更合适**
- **PGlite 方案已证伪**：Prisma **无官方 PGlite adapter**（`@prisma/adapter-pglite` 在 npm 404，
  官方文档只把它列在社区清单里）；PGlite 自身仍是 alpha 且限单连接。
  改用 `embedded-postgres`（MIT）起真实 postgres 进程，**`PrismaPg` 代码零改动**
- **硬门槛：macOS 公证需付费 Apple Developer Program**。Apple 官方对照表中公证与证书权限在免费注册列为空
- Windows SmartScreen 是信誉制，需代码签名证书建立信誉
- 许可证全部 MIT / Apache-2.0 / PostgreSQL License，**无 GPL/AGPL 传染**
- 建议先做 P1（起内嵌 Postgres + 指向本地端口 + 跑 smoke）——这是最低成本的证伪/证实实验，
  且不需要任何账号或证书

### 踩坑与自我纠错（本轮踩得最多的一个）

1. **Nest `abortOnError` 会把启动期异常整个吞掉**。`NestFactory.create(AppModule, { logger: false })`
   默认 `abortOnError: true`，DI 失败时直接 `process.abort()` —— **连 `.catch()` 都进不去**，
   表现是「无任何输出的 exit 1」。排查时加了探针才定位到是 `AgentService` 缺 `JwtService`。
   smoke 已改成 `abortOnError: false`。
2. **`void main()` + `process.exit()` = 无输出**。stdout 重定向到管道时是异步写的，
   紧接着 `process.exit()` 会把没落盘的输出全丢掉。改成只设 `process.exitCode`，
   并给 `main()` 挂 `.catch` 把异常打出来。
3. **对象展开的覆盖陷阱**（同一类错犯了三次）：
   `headers: { Authorization: \`Bearer ${authA}\` }` 会把 `[object Object]` 当 token；
   `...authA, headers: { 'X-Request-Id': rid }` 里的 headers 又会**整个覆盖** `authA.headers`。
   最终改成 `headers: { ...authA.headers, 'X-Request-Id': rid }`。
4. **ESM 里没有 `require`**。smoke 的漂移守卫一度用 `require('node:fs')`，编译后在 ESM 下直接崩。
   **批量替换文本时必须逐条断言命中数** —— 有一次 `sed` 先一步改了文本，导致我后面的 Python 替换
   静默没生效，报错却是「变量未定义」，排查方向完全被带偏。

### 额度入口在哪（用户问）

界面里**三处都有**：顶栏额度胶囊（`¥xxx`，本身可点）、顶栏「会员与额度」按钮跳 `/vip`、
侧栏「个人中心」跳 `/tokens`。顶栏胶囊容易被当成纯展示，实则 `MainLayout.tsx:87-89` 里绑了导航。

### 门禁

`pnpm typecheck` ✓ / `pnpm build` ✓ / `pnpm smoke` **264/264**（新增 26 条）。
部署核对：容器镜像 ID `sha256:b0f35ae3…` == 最新镜像 ID，`/api/health` 正常。

## [0.1.52] - 2026-10-14

### Fix（智能灯光场景页三个 UI 缺陷 + 全站主题审查：消灭「黑色主题 + 白色卡片」）

用户在深色主题下实测截图报错三处，全部**先用 DOM 取证定位根因、再改代码**，不靠肉眼猜。

| 用户反馈 | DOM 实测根因 | 修法 |
|---|---|---|
| 灯具卡第二张是**白底** | `LightingStudio.tsx:591` 选中态写死 `background:'#F5F4FF'`，深色下算出 `rgb(245,244,255)` 压在 `rgb(20,20,20)` 页面上 | 改 `token.colorPrimaryBg` + `token.colorPrimary`，实测变 `rgb(38,35,83)` |
| **卡片高度没对齐** | 同一列表实测 214 / 214 / **134** px —— `alwaysDim` 灯整块隐藏了亮度/色温两条滑块 | 两条滑块**始终渲染**，常暗时置灰并换文案（「亮度（常暗锁定 8%）」「色温（常暗时只作为基线）」）。控件恒定 → 卡片恒等高，实测 214/214/214 |
| 第二张卡被**截断**在「未归组 + 1 条滑块」 | 列表写死 `maxHeight:420`，滚动区 319→739，第二张卡 543→757 **被裁 18px** | 去掉写死高度：面板与舞台同行等高（`align-items:stretch`），列表 `flex:1 + minHeight:0` 在面板内滚动 |
| 下方**大片留白** | 卡片底边 897、视口 1050 —— 根容器无 `minHeight`，内容只占顶部 | 接视口高度链：根 `fillHeightContainerStyle` → 卡片 `flex:1` → 卡片体 `flex:1` → 步骤内容 `flex:1`。实测卡片底边与视口只差 **8px** |

**顺手修掉的相邻缺陷**：舞台写死 `maxHeight:560`，被压扁后底图 `objectFit:contain` 会在左右留边，
而灯具坐标按盒宽归一化 —— 窗口一宽，**点下去的位置和图片里的位置会错开最多半个盒子**。
去掉上限后实测舞台宽高比精确等于 1.778（16:9），不再有留边。

**全站主题审查（18 条路由逐页扫近白面）**，找出并修掉 4 处硬编码浅色：

- `ImageCanvas` 出图失败框 `#FFF2F0` → `token.colorErrorBg`；出图底框 `#F7F7FA` → `token.colorFillQuaternary`；
  「正在出图」提示字 `rgba(28,27,46,.55)` → `token.colorTextSecondary`（深色下这本就是**看不见**的深墨字）
- `Feedback` 官方回复卡 `#F6FFFA` / 边 `#B7EB8F` → `token.colorSuccessBg` / `colorSuccessBorder`
- `PlanShareView` 页底 `#F7F8F9` → `token.colorBgLayout`（分享页在 `ThemeProvider` 内，跟着主题走）
- `LightingStudio` 出片提示卡 `#FAFAFC` → `token.colorFillQuaternary`，实测 `rgba(255,255,255,0.04)`

审查后深色主题下 18 条路由**零白色卡片**。剩下的近白元素只有两类，都不是硬编码：
`rgba(255,255,255,.04/.08)`（token 派生的半透明叠加）与 AntD `Tag` 按 39 个品类品牌色自行渲染的小徽章。

**刻意保留的硬编码**（有据，不是漏网）：播放头 `#EB2F96`、灯位色温径向渐变、时间码胶囊
——它们压在**画面之上**做标记，明暗两套主题下都要醒目，已抽成 `PLAYHEAD_COLOR` 并写明理由，
避免下次被当成「漏改的浅色」再扫一遍。

### Feat（电气回路：让报价能说清「客厅分几个回路」）

灯具只报总数没法报价 —— 「客厅 12 盏灯」必须说清分几个回路、每路多少盏、每路由哪个开关/空开控制。
`Fixture` 加 `circuit` 字段 + 回路管理面板（新建/完成/删除/导出 CSV）+ 每盏灯「所属回路」下拉 +
画布上青绿描边标出已归组的灯（与「当前选中」的紫色区分）。

### Feat（本地推流大师智能体 + 真实封面）

补齐 0.1.51 对照出的唯一缺口：与「本地推投流文案」是两回事，后者只产口播素材，
本智能体管账户投放全流程（准入自查 / 开户 / 素材 / 计划搭建 / 数据复盘 / 逐步放量 6 个维度）。
封面用 mcode-tools 生成了**专属实拍图**（夜色商业街 + 手机短视频流），
与既有 12 张写实封面同风格。此前版本复用 a5 封面且 `enabled:false`，本版换真图并启用。

### Test（smoke 封面护栏，238/238）

新增 1 条断言：读 `apps/web/src/data/agents.ts` 提取全部 `cover` 字段并逐个校验文件存在。
双向验证过——删掉 `a13.jpg` 立刻 FAIL 报「缺失：a13.jpg」，放回即 PASS。
这类「配了引用但文件没进仓库」的 404，之前只能等打开页面才发现。

### Refactor（`lib/download.ts`：下载与 CSV 从 QuoteStudio 私有函数提为共享）

`downloadBlob` / `csvCell` / `csvText` / `downloadCsv` 原是 QuoteStudio 里的私有实现，
回路清单导出要复用，抽到 `lib/download.ts` 两处共用，不复制第二份。

### Chore（仓库卫生）

`replica/clone-screens/` 12 张我方界面截图（1.4MB，2026-10-06 起未更新，无任何文档引用）
从版本索引移出并加入 `.gitignore` —— 比对截图属于本地取证材料，不该随仓库分发。
`replica/` 现在只剩 `recon.md`、`features.csv`、`audit-*.md`、`full-parity-matrix.md` 四份文本基线。

### 踩坑与自我纠错

- **一次自我纠错**：第一轮修完实测 `listCardH:1058` 才发现量错了对象 —— 取到的是 flex 行本身而非面板。
  改用「按文案定位卡片 → 取 `parentElement`」才量准。**量布局必须锚定到业务元素，不能靠位置猜。**
- **浏览器里的 token 是旧的**：页面里 `localStorage` 存的 token 属于另一个用户，`GET /api/lighting` 返回 0 条，
  一度以为接口坏了。换成 `curl` 登录拿的新 token 才对上。
- **`304` 不是「没数据」**：`GET /api/lighting` 命中浏览器缓存返回 304，容易误判成列表为空。

### 门禁

`pnpm typecheck` ✓ / `pnpm build` ✓ / `pnpm smoke` **238/238**。
部署核对：容器镜像 ID `sha256:878b9c76…` == 最新镜像 ID，线上 bundle `index-D6sS6b1f.js` 与本地构建一致。
实测（1920×1080，深色）：灯具卡 214/214/214 等高、选中态 `rgb(38,35,83)`、卡片底边距视口 8px；
浅色主题同一路径复测，选中态 `rgb(243,240,255)`、卡片全白、等高与留白同样正确。

## [0.1.51] - 2026-10-14

### Feat（登录参考站后逐板块比对，补齐 WiFi 热力图 4 项缺口 + 三档信号统计）

用户重新登录参考站后，把昨天未核完的板块真的比对了。

**百宝箱逐项对照（19 项）**：参考站 19 项，我方 20 项 —— 19 项全部对齐，
我方多一项「AI 画布」（0.1.44 新增，属我方增强）。

**智能体对照**：参考站 12 个预设 + 4 个用户自建；我方 12 个预设，11 项对应，
**仅缺 1 个「本地推流大师」**（账户/资质/开户/投放计划/复盘放量，
与已有的「本地推投流文案」是两回事，后者只产出口播脚本）。

**WiFi 热力图对照（`#/wifiHeatmap` 实测）**，找到并补齐 4 项：

| 参考站 | 补齐前 | 处理 |
|---|---|---|
| 5 步首次使用引导 | 无 | 新增 Modal；首次进 WiFi 模式且无底图时自动弹出，工具栏另有「使用引导」按钮 |
| 设备：吸顶AP / 面板AP / 路由器 / 室外AP 四类 | 只有「WiFi 面板 AP」一类 | seed 新增 3 类（吸顶 NW-1302 / 路由器 NW-1303 / 室外 NW-1304），产品库 21 → 24 |
| 热力透明度滑块 | 硬编码 `alpha: 0.62` | 接成 `heatAlpha` state + 滑块，并补进导出回调的依赖数组（否则改了透明度导出会用旧值） |
| 覆盖统计：信号好 / 一般 / 弱 三档百分比 | 只有单一覆盖率数值 | `measureCoverageStats` 扩展返回三档，与 ratio **共用同一趟扫描**（不额外遍历） |

引导文案如实写出「自动识别 + 人工补画」的往返动作，不粉饰成一步到位 ——
识别会漏墙，而墙体直接影响穿墙衰减，用户拿着错墙体会得到错的覆盖率。

### Test（三档统计算法的不变量实测）

用 20×20 陡衰减信号场（0.55^d）在阈值 0.18 / 0.35 / 0.6 下验证：

```
阈值 0.18: 好 6.0% 一般 11.0% 弱 83.0%
阈值 0.35: 好 3.0% 一般 5.0%  弱 92.0%
阈值 0.60: 好 1.0% 一般 5.0%  弱 94.0%
```

三个有效不变量全部通过：三档闭合 = 100%、`信号好` == 二值覆盖率（同为达标格）、三档非负。

> 一次自我纠错：中途我写了条断言「好+一般 == 二值覆盖率」并报 ❌，
> 复核后是**我断言口径写错了** —— 「信号一般」档本就落在阈值之下，本就不该计入二值覆盖率。
> 另一个「好≥一般≥弱」也不是有效约束（覆盖面积大时「一般」档完全可能大于「好」档）。
> 算法本身正确，是断言错了，不是实现错了。

- smoke **237/237** 全绿；typecheck / build 全绿
- 部署后界面复验：「使用引导」按钮、热力透明度 62%、四类 AP 全部在位（DOM 文本取证）

> 未完成：参考站「智能灯光大师」与「灯光点位与场景」是两个独立区域，
> 我方合并在同一个页面的 tab 里 —— 属形态差异不是功能缺失，本轮未逐项核对，标注待办。

## [0.1.50] - 2026-10-14

### Fix（用户实测反馈：右上角没有主题切换入口、卡片配色不跟随主题、AI 画布一片白、下方留白太多）

昨天的明暗主题「实测通过」是错的——我当时用 DOM 看到侧栏 `background: rgb(255,255,255)`
就下了结论，但**没有扫全站的硬编码颜色**，也没有真的逐页看。本轮按用户反馈实测后抓到：

- **顶栏主题切换入口缺失**：切换只在头像下拉菜单里，等于没有。已在额度胶囊旁常驻
  三态分段控件（跟随系统 / 浅色 / 深色），带图标与当前态指示
- **5 处硬编码浅色，深色主题下是突兀的浅色块**：
  - `ImageCanvas.tsx` 主对话区卡片 `background: '#fff'` + `border: rgba(28,27,46,.08)`
    —— 实测深色下仍是 `rgb(255,255,255)` 纯白卡片（已改为 `rgb(20,20,20)` / `rgb(48,48,48)`）
  - `LightingStudio.tsx` 三处舞台/预览/时间轴底 `#F5F5F7`，选中框 `#5B5BF0`、边框 `#E8E8ED`
  - `RegionSelector.tsx` 圈选画布底 `#f5f5f7`
  - `DeviceLayout.tsx` 产品缩略图圆点底 `#fff`
  全部改为 `token.colorBgContainer` / `token.colorFillTertiary` / `token.colorBorder` 等语义 token
- **画布页下方大片留白**：页面根容器无 `minHeight`，内容只占顶部约 1/4
- **5 处双栏容器缺 `flex: 1`**：`ImageStudio` / `Feedback` / `LightingStudio`×2 / `ImageCanvas`
  （昨天只修了 4 个文件里的，这次代码层全量扫了一遍 `display:flex` + `gap` + `alignItems:flex-start` 的组合）
- **空态内容贴顶**：卡片撑满后，空态提示仍贴在顶部、下方空 1200px。
  改为对话流容器 `flex-direction: column` + 空态时 `justify-content: center`，
  有内容后回到 `flex-start`（消息流必须从上往下读，不能居中）

### 踩坑与自我纠错：全局 flex 差点换来三个页面破版

修留白时先给**全局** `pageContainerStyle` 加了 `minHeight` + `display: flex; flexDirection: column`，
本以为一劳永逸。部署后立刻发现**报价页产品库被压成空壳**——标题在、21 个产品全没了。
原因：全局 flex column 下各页面根节点默认 `flex-shrink: 1`，在 minHeight 约束下被压扁。

已回退全局改动，改为新增 `fillHeightContainerStyle` 供需要撑满视口高度的页面单独使用
（当前只有 AI 画布），并在 `tokens.ts` 注释里写明**为什么不能放在全局**。

> 教训：撑满视口高度是少数「对话流型」页面的需求，不是全站需求。
> 全局兜底看起来更省事，实际是把一个页面的诉求强加给了所有页面。

### Test

- smoke **237/237** 全绿；typecheck / build 全绿
- 部署一致性核对：容器镜像 ID == 最新镜像 ID

> 未完成：参考站逐板块比对。本轮参考站会话已掉登录（`platform.gougezn.com/#/space`
> 返回「尚未登录」），需要重新登录后才能比对百宝箱内的 WiFi 热力图、灯光大师、定制智能体等
> 昨天未核完的板块。这部分如实标注为**未完成**，不宣称已核对。

## [0.1.49] - 2026-10-13

### Feat（接单「边聊边记」结构化采集补齐 —— 全量界面核对后发现的真实缺口）

被问到「你有没有逐板块核对过界面」。诚实回答：**没有**。0.1.44 – 0.1.48 五轮改动全部只做了
代码 review + API 契约级 smoke 断言，从未打开过界面逐屏比对，于是矩阵里的 ✅ 全是自签合格证。
本轮打开浏览器逐屏核对 20 个板块后，发现「开始接单」复刻的根本不是同一种形态：

参考站是**逐项手工采集的大表单**，我方是 8 个自由文本输入 + AI 解析兜底。
5 处结构化采集完全缺失，且因为没有一条断言覆盖，222/222 全绿照样放过了。

- **数据模型**：`OrderRequest` 新增 19 个字段（`renoStage` / 房屋补充 5 项 / 生活需求细分 7 项 /
  `scenes` / `systems` / `budgetMin` / `budgetMax` / `budgetScope`）+ migration
  `20261013150000_order_intake_fields`（已实跑 `prisma migrate deploy` 通过）
- **枚举与校验**：`orders.schemas.ts` 新增 `RENO_STAGES`(6) / `SCENE_KEYS`(10) / `SYSTEM_KEYS`(9)
  与三态 schema；预算上下限自洽校验（上限不得小于理想起点）
  - 踩坑修正：zod4 的 `z.record(z.enum(...))` 会把 enum key 当**必填全集**，
    导致「只填灯光+窗帘」被拒。改为 `record(z.string())` + refine 白名单，既能部分提交、
    又能让字典外 key 被拒而非静默剥掉
  - 另一坑：zod4 不允许对含 refinement 的 schema 调 `.partial()`，refine 只能挂在派生结果上
- **AI 解析同步扩展**：`orders.service.ts` 的 `intake` prompt 从 9 字段扩到全量结构化，
  并对模型返回值做**运行时白名单过滤** —— 未提及的系统绝不推测
  （猜出来的「系统需要」比没有更危险）
- **前端**：`apps/web/src/lib/orderIntake.ts` 新增前后端共享枚举（注释写明必须逐项对齐）；
  `OrderStudio.tsx` 建档弹窗按参考站分区重排为「客户与房屋 → 生活需求 → 体验场景 →
  系统范围与预算」，系统矩阵为 9 行 × (三态下拉 + 应用区域 + 具体配置)；详情页新增
  「体验场景与系统范围」区块 —— **存了不显示等于没存**
- **smoke +15 条断言**（222 → 237）：默认值不为空、结构化字段逐项写入并回读一致、
  场景/系统/need/装修阶段字典外值被拒、预算倒挂被拒

### Fix（界面逐屏核对抓到的两处问题）

- **VIP 页文案数字过时**：`Vip.tsx` 写「智能百宝箱 19 个工具入口」，实际 20 个。
  从 `TreasureBox.tsx` 代码精确统计确认后改为 20（0.1.41 把百宝箱加到 20 时漏改此处）
- **公共库产品价格脏数据**：实测「小爱触屏音箱」`priceRetail/priceProject/priceDealer` **全为 0**、
  sku 为空。报价侧 `sellPrice` 有 `priceRetail || priceMax` 回退所以算价不错，但「产品中心」
  该行显示「指导 ¥0」误导用户。根因是 `seed.ts` 按 `PRODUCT_DEFS` 的 name 逐条 upsert，
  不在清单里的历史脏数据永远碰不到 → 在 seed 末尾加**幂等修复**（只补 0 值、不覆盖已有值、
  复用同一套价格口径）。实测 `pricingRepaired=1 → 小爱触屏音箱 → retail=599 project=299 dealer=270`，
  二次运行 `pricingRepaired=0` 幂等确认

### Docs（复刻矩阵口径收紧 + 审计报告）

- `full-parity-matrix.md` 的 ✅ 含义改为「**已打开界面逐屏核对通过**」，
  仅代码/契约层面确认的一律降级为 🔸。逐板块标注实测结论
  （例：AI 生图子工作流原文写 4、实测 5；「开始接单」由 ✅ 降级 🔸）
- 新增 `replica/audit-2026-10-13.md`：20 个板块的逐屏核对证据、4 个问题的定位与处理、
  以及**核对中的自我纠错**（首次截报价页时侧栏空白，我判定为「接口有数据但界面不渲染」，
  复核后是我截图拍早了 —— 教训：截图取证必须等页面稳定）

### Test

- smoke **237/237 全绿**；typecheck / build 全绿

> 诚实边界：
> ① 「AI 画布圈选重绘」入口需先有历史出图且本机无 OpenAI 生图 provider，真实出图仍未验证；
> ② WiFi 热力图算法已由数值断言验证（Otsu 阈值 40 精确命中、覆盖率 65.0% vs 97.6%），
> 界面图层未逐屏核对；
> ③ 公共库「小爱触屏音箱」是第三方上游品牌名，与项目自有「智居」定位不一致，
> 删除属破坏性操作（影响所有租户公共库），本轮未动，留待决策。

### Fix（宽屏留白 + 画布消息丢失，又两个只有看界面才能发现的 bug）

用户指出「界面留白太多挤在一起」「白色/黑色主题要区分清楚」。逐页量化后发现留白的
**根因不是列宽数字，而是外层 flex 容器自身没有 flex-grow**：

在 AntD `Layout` 的 flex 行里，一个没有 `flex: 1` 的 block 级 div 会退化成**内容宽度**——
两栏加起来多宽就多宽，剩下的全部变成右侧空白。实测报价页在 1920px 下右侧空出 **400px**（占内容区 25%）。

- `QuoteStudio.tsx` / `OrderStudio.tsx` / `DeviceLayout.tsx` / `PlanStudio.tsx` ×2：
  主区 flex 容器补 `flex: 1` + `minWidth: 0`（`minWidth: 0` 是关键，否则 flex item 不会收缩到内容以下）
- 接单页 `OrderStudio.tsx`：AntD 栅格 `lg={7} / lg={17}` 是**断点固定比例**，
  在 1920px 下左栏直接占 29%（约 472px），比参考站窄栏宽一倍 → 改为 flex：
  左栏 `0 1 300px`（上限 340）、右栏 `1 1 560px`
- 报价页产品库：给足 `0 1 380px`（上下限 340/420）——
  这是「名称 + 单价 + SKU + 规格」一行排得下的最小宽度，
  再窄就会出现「空调/伴侣」「智能摄/像头」这种断字（第一次收窄时正是踩了这个坑）

**AI 画布消息丢失（更严重的一个）**：发新 prompt 时前端不传 `parentId`，
后端每条都建成**根轮次**；而渲染侧 `headTurn = turns.find(t => t.parentId === null)`
**只取第一个根**。结果：第二轮出图成功、变体已落库，界面上却整条消息不显示。
smoke 全绿、typecheck 全过、API 返回 201 —— 全部看不出来。

- 发送时默认接在当前叶子之后（`parentId: baseTurnId ?? leafTurn?.id`），真正做到「像聊天一样连续」
- 渲染侧把所有根按时间串成一条线兜住历史多根数据
- 修复后同一对话 4 轮全部正常显示，每轮都有独立的「再出一版 / 改这段描述 / 圈选重绘」

### Test（圈选重绘完成端到端验证，不再停留在「明确拒绝」）

本机没有 OpenAI 生图 provider，此前只能验证到「准确拒绝」。本轮起了一个 mock OpenAI 兼容端点，
把链路一路验到上游收到的字节：

- `POST /v1/images/edits` multipart 字段实测为 `model, prompt, n, size, image, mask`，
  image 475B / mask 608B，尺寸均 256×171
- **遮罩逐像素校验**：涂选区内 alpha 取值集合 = `{0}`（4896/4896 像素），
  涂选区外 = `{255}`，圈外 alpha=0 的像素数为 0
  ⇒ **涂选处透明(=要重绘)、圈外不透明(=保留原样)，与 OpenAI 约定完全一致**
- 结果回界面正常：新一轮 status=ready、产出独立变体，原图与原变体都保留

> 排查中踩到的坑：mock 端点最初配 `http://127.0.0.1:3099`，容器内访问不到宿主机
> （容器里 127.0.0.1 指向容器自己），第一轮作业报 `fetch failed`。
> 容器内应写 `http://host.docker.internal:3099`。**本机 Docker 调试上游 mock 时必踩。**

### 验证方法的诚实边界（截图工具本身不可靠）

切到浅色主题后，截图显示「侧栏仍为黑底」，我一度准备改代码。但继续查证发现：

- `.ant-layout-sider` 的 inline `background` 实测为 `rgb(255, 255, 255)`，**侧栏确实跟随主题**
- 连续三次截图（间隔 1 分钟、含 reload 与新开 tab）返回的字节数**完全相同（142436）**
  ⇒ 截图工具在复用同一帧缓存，视觉证据不可信

**因此本轮没有据截图改任何主题代码。** DOM 是可复现的权威数据，截图不是。
主题跟随的正确性依据是 inline style + `ant-menu-light` class 随算法切换，不是我的眼睛。
这一条写进文档，避免下一个人（或我自己）拿一张可疑截图去「修」本来正确的代码。

## [0.1.48] - 2026-10-13

### Fix（MiniMax 能力判断纠错：视频模型名此前被静默丢弃）

用户指出「MiniMax 不支持生图生视频」的说法不对。复核后确认：**生图生视频一直是支持的**
（`image-01` 文生图、`T2V/I2V-01-Director` 生视频，自 0.1.6 起就是默认 provider，有实测出图出片记录）。
那句文案实际说的是另一个维度——**MiniMax 的图像接口没有 mask 参数**，说的是「按遮罩局部重绘」，
不是「不能出图」。两者被混在一句话里，导致对外表述失真。同时排查发现两处更实质的判断缺陷：

- **视频模型名被静默丢弃（比文案问题严重得多）**：`generateViaMinimaxVideo` 写死
  `first_frame_image ? 'I2V-01-Director' : 'T2V-01-Director'`，用户在「模型配置」页填的视频模型
  （比如 `MiniMax-H3` 这类带原生音轨、支持多模态参考的新模型）**根本不参与请求构造**——
  配置页显示已保存，实际永远发旧模型名。现改为：配置了就原样下发，留空才按有无首帧回落。
  同时把默认 model 值从描述串 `'T2V-01-Director / I2V-01-Director'`（非合法模型名，一旦下发必被上游拒）
  改为空串表示「自动」。
- **音轨能力判断对 MiniMax 过保守**：原逻辑只对 `gemini-omni`/`veo` 特判，其余一律「大概率只输出画面」。
  但 MiniMax H3 **每条视频都自带 32kHz 原生立体声**（对白/音效/音乐同一次生成产出），静音物理上做不到；
  第一代 T2V/IV 则确定无声。两种情况此前都被同一句「大概率」糊过去。现按模型名分四档精确判断，
  未收录的模型明确说「未收录、如何自证」，不再替用户下「不出声」的结论。
  15 个模型×模式组合已逐一实测（`gemini-omni`/`veo`/`MiniMax-H3`/`Hailuo 03` 必带声、
  `T2V/I2V-01-Director`/`sora-2` 明确无声、`seedance` 可选）。

### Docs（局部重绘拒绝文案改准确）

- 旧文案「当前生图 provider（minimax）不支持局部重绘」容易被读成「MiniMax 不能出图」。
  新文案点明真实原因（缺的是 mask/遮罩参数）并给两条可行替代。
- 依据：MiniMax 官方 `/v1/image_generation` 请求 schema 仅有 `model` / `prompt` / `subject_reference` /
  `aspect_ratio` / `width` / `height` / `response_format` / `seed` / `n` / `prompt_optimizer`，
  **无 mask、无 inpainting 区域、无 denoise 强度**。`subject_reference` 是「参考图主体一致性」
  （`type=character`，保持人物特征），拿它冒充遮罩重绘会让用户以为圈选生效、实际整张重画——
  所以这里继续明确拒绝而非静默降级。
- 「模型配置」页视频卡片文案同步：provider 选项由「MiniMax Director」改为「MiniMax」，
  模型输入框说明支持填 `MiniMax-H3` 等新模型，并注明换模型后参数档位以平台返回的错误为准。

### Test（防回归）

- 新增 `resolveMinimaxVideoModel` 纯函数导出 + 6 条断言（配置即下发、文生/图生各自回落、
  纯空白等同留空、默认值不是描述串），挡住「又改回硬编码」。
- 新增断言：拒绝文案必须同时含 mask 原因与可行替代，防止退回笼统表述。
- smoke 215 → **222/222 全绿**。

> 诚实边界：H3 的分辨率/时长档位与官方 schema 未逐一实测，换用新模型时若参数不匹配以上游报错为准。
> 本机无 OpenAI 生图 provider，局部重绘仅验证到「准确拒绝」这一层，真实出图效果待实机确认。

## [0.1.47] - 2026-10-13

### Feat（涂鸦选区局部重绘——此前标为「依赖上游」的缺口，本轮真做出来）

上一轮我把这条记成「依赖上游 mask，暂不做」。复核后发现**只做了一半判断**：
参考站把 `mask` 发给 `/api/image-editor/redraw` 由后端 inpaint，而我方当时只用了
`images/generations`（JSON，无 mask 能力）。但 **OpenAI 的 `images/edits` 原生支持 mask**，
所以只要补一条 multipart 分支就能真做出来，不必停在半成品。

- 新增 `generateViaOpenaiEdit`：走 `POST /images/edits`（multipart），必须同时带原图与遮罩。
  按 OpenAI 约定生成遮罩：**要重绘的区域透明、其余不透明**（与直觉相反，前端已按此实现）。
- `/api/media/images` 新增 `imageAssetId` + `maskDataUrl`；两者必须成对出现。
- 新增 `components/RegionSelector.tsx`：在效果图上按住涂抹圈选要重做的区域，实时描边预览，
  遮罩在内联成 dataURL 随请求提交（一次性操作参数，不落盘）。`pointer` 事件实现，触屏可用。
- 画布每轮多一个「圈选重绘」入口，结果作为**新变体**出现，原图与原变体都保留。

**诚实边界**：目前只有 `provider=openai` 支持（走 images/edits）。其它 provider 收到 mask
一律返回 `503 IMAGE_EDIT_UNSUPPORTED` 并提示去「模型配置」切换，**不会静默忽略**
——否则用户会以为圈选生效、实际整张重画。

### Fix（校验顺序 + 一条会让功能"看着能用其实没生效"的断链）

- **校验顺序**：参数完整性检查原本排在 provider 能力判断之后，导致「只给一半参数」返回 503 而非 400。
  已把参数完整性提前：请求不完整是 400，能力不支持才是 503。
- **mask 在画布链路被静默丢弃**（重要）：`/api/canvas/conversations/:id/turns` 是 UI 实际调用的端点，
  而我只把 mask 加到了 `/api/media/images` 上——**用户点「圈选重绘」后遮罩根本没传到出图层，
  实际发生的是整张重画**，而界面显示「圈选重绘」。这正是我一直拒绝的假功能。
  已把 `imageAssetId` / `maskDataUrl` 贯通 `createTurnSchema` → `JobParams` → `generateImage`，
  并补一条**专门防这个回归**的测试：带遮罩提交后，若 provider 不支持则作业必须 `failed`
  ——若遮罩被丢弃，作业会成功，测试立刻失败。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **215/215**，连续两次全绿
- 新增 5 条用例：只给遮罩 400 / 只给原图 400 / provider 不支持 503 / 带遮罩提交 201 /
  **遮罩确实到达出图层**（防静默丢弃的回归护栏）
- 浏览器实测圈选器：画布 1280×720，拖动后状态由「尚未圈选」变「已圈选，可提交」，
  两个操作按钮同步解除禁用
- **遮罩方向逐像素校验**：圈选处 alpha=**0**（透明=要重绘）、圈外 alpha=**255**（保持原样），
  与 OpenAI 约定完全一致（注意与直觉相反）
- 端到端实测：真实 API 提交带遮罩的轮次，作业返回
  `failed` +「当前生图 provider（minimax）不支持局部重绘…」，证明遮罩确实到达出图层并被正确拒绝
  （⚠️ 该文案有误导性：它指的是**没有 mask 参数**，不是「MiniMax 不能出图」。0.1.48 已改写）

> 验证过程中我一度以为「弹窗打不开」，复核发现是我自己选择器写错（查 `.ant-modal-content`
> 而实际先渲染的是 `.ant-modal-wrap`），功能本身正常。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **213/213**，连续两次全绿
- 新增 3 条局部重绘用例：只给遮罩 400 / 只给原图 400 / provider 不支持时明确 503

## [0.1.46] - 2026-10-13

### Feat（WiFi 热力图：墙体识别 + 真实信号衰减 + 覆盖率统计）

对标参考站 `wifi-heatmap.js`（58KB，我方原先只有「加性径向光斑」，与它差距最大的一块）。
新增 `lib/signalHeatmap.ts`（纯 TS，无新依赖，Canvas 2D 渲染）：

- **墙体识别（确定性纯前端 CV，不调任何 AI 接口）**：灰度化 → Otsu 全局阈值二值化
  → 膨胀桥接断口 → 距离变换取墙线芯部 → 两遍连通域标记 → `solidPass` 滤实心块 /
  `linePass` 收细长线 → 轴向吸附 → 同轴合并 → `pairChains` 双线合并 → 约束在图纸范围内
  → 归一化输出。墙线**可手工修正**：拖端点、改方向、删除、手动新增
- **墙体间信号衰减**：从设备四向洪水填充，**遇墙格停止**；每穿一道墙按系数衰减（默认 0.62）
- **物理单位**：填入图纸实际宽高（米）后得出比例尺，设备可显示覆盖半径与理论覆盖面积
- **覆盖率统计**：统计「信号 ≥ 阈值」的面积（㎡）与占比，导出 PNG 时在图上画摘要
  （图幅尺寸/覆盖率/图例/生成时间）

### Verified（含一次自我纠错）

- Otsu 在合成十字墙图上阈值取到 **40**（与墙像素值完全一致），二值化暗像素 **1344**（与预期一致）
- 墙体识别出 2 条墙段，归一化坐标 0.4964 / 0.4975，精确落在图像中心
- 信号场：源点 **1.000**（最强）→ 同侧 0.797（空间衰减）→ 墙后 **0.000**（穿两道墙被阻断）；
  无墙对照同点 0.374，加墙后被压到 0
- 覆盖率：有墙 **65.0%**（45.5㎡/70㎡）vs 无墙 97.6%，**加墙后覆盖率下降符合物理直觉**
- 面积换算正确（网格 → ㎡）

> 验证过程中我先后报了两次「异常」，复核后确认**都是测试点选错**（源点坐标系传成像素而非归一化、
> 源点正好压在墙上），不是模块缺陷。已重测确认模块行为正确。

### Feat（智能报价：房间分组与户型图房间标注，对标 `quote-workbench.js` 88KB 剩余高频部分）

- **房间分组视图**：按房间把行聚合成可折叠分组，组头显示房间名/件数/小计
- **组序与行序可拖拽**：全部走 pointer 事件自写的 `useDragSort`，**不用 HTML5 DnD**——
  后者在触屏上完全不可用。手柄 `touchAction: none`，手机与桌面同一条代码路径；
  窄屏额外提供上移/下移按钮作为等价替代
- 组序与行序写回同一份 `lines` 数组，**关掉分组视图后平铺行序与分组一致**
- **户型图房间标注**：上传户型图后拖拽放置房间标签，可改名/删除；点图上标签定位到对应报价行，
  行内「图」按钮反向打开标注；**靠房间名三方同名绑定**，不引入 id 映射表
- 未标注房间在图底部以虚线 Tag 提示，点一下即可补标
- CSV/Excel 按当前分组顺序输出并附「房间 + 归一化坐标 + 件数 + 小计」附表

> 导出**不跟随房间筛选**：报价单不应因为筛选而少行，导出行始终是全量。
> 户型图只在本页内存（压缩后转 dataURL），不上传服务端——标注属本页草稿，与「逐项单价
> 仅本次生效」同口径。

### Feat（智能方案：全屏阅读器与预算校验，对标 `plan2-workspace.js` 27KB）

- **全屏阅读器**：逐页渲染复用 `PlanSlide`（零新增渲染逻辑，版式自带的容器查询自适应字号）
- 键盘 `←/→` 翻页、`Home/End` 跳首尾、`Esc` 退出、`F` 切全屏；焦点在输入框或带修饰键时不拦截
- 过渡用 Web Animations API，200ms 淡入 + 24px 位移，方向决定符号；连按先 `cancel()` 上一段
- **动画降级**：用 `matchMedia('(prefers-reduced-motion: reduce)')` 并监听变化，命中时整段跳过动画
- 控制条随鼠标/触摸唤醒，静止 2.5s 淡出（不卸载节点，键盘翻页同样唤醒）
- 顺带修掉一处旧耦合：原「全屏播放」复用预览页索引，会从第 3 页开始；现在永远从第 1 页
- **预算校验只提示不阻断**：留空=不限、非数字/非正数给 warning，`validateFields()` 永不因预算失败
- 预算档位预设（基础/舒适/豪华/定制 = 600/1000/1600/2600 元/㎡）按面积自动推荐，点击即填
- 分配建议条（安防/灯光/遮阳/影音/暖通/网络 = 100%）随编辑实时算差额，超出转红但不阻断生成

### Feat（生视频音轨设置，对标 `video-audio.js`）

音轨在上游不是一个独立参数，而是**编译成提示词片段**交给视频模型理解——照这个语义实现，
新增 `lib/videoAudio.ts`（纯函数 `normalizeAudio` / `describeAudio` / `audioSupportHint` / `withAudioPrompt`）：

- 四种模式：静音 / 仅音效 / 仅音乐 / 音效＋音乐；音乐风格 ≤120 字、音效说明 ≤240 字，超限直接报错
- 静音模式**不往提示词追加任何东西**，保持提示词干净
- 有声模式把「不添加旁白、解说或歌词」「灯光渐变不配咔哒声」等约束拼到画面描述后面
- **能力提示诚实**：只有能确证自带音频的模型前缀才放开静音限制，其余模型在选有声模式时
  明确提示「大概率只输出画面，建议先试一小段确认」——不能让用户以为选了就一定出声
- `configStore` 补 `videoModel` 供能力判断

### Feat（素材库投稿链路，此前只有空壳占位）

「我的投稿」Tab 原先只有一句"投稿链路 0.3.0 接入"的空状态，后端完全不存在。现补齐全链路：

- 新增 `MaterialSubmission` 表（title/desc/filePath/status/reviewNote），状态机
  待审核 → 已通过并上架 / 未通过 / 已下架
- `POST /api/media/materials/upload`：**与通用 uploads 刻意分开**。后者被生图/生视频页
  当「参考图」用且只收图片，放开视频会让它们把视频当图片收进来；此处上限放宽到 100MB
- `POST /api/media/materials/submissions` 提交审核（引用不存在或未就绪的素材一律 400）
- `GET /api/media/materials/submissions` 我的投稿及审核状态与驳回原因
- 前端：选视频 → 填标题/看点 → 提交 → 列表展示状态

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **210/210**
- 备份覆盖护栏在本轮**当场生效**：新增 `MaterialSubmission` 表后我忘了加进 `BACKUP_TABLES`，
  该断言立刻失败并暴露问题，补齐后通过——这正是当初加这条断言的意义

## [0.1.45] - 2026-10-13

### Fix（clean-room 红线：参考站截图曾被误入库）

`replica/diffs/` 下 8 张**参考站原始截图**（含第三方品牌 UI）在 0.1.16 就被提交进仓库，
**早于**后来才加进 `.gitignore` 的规则——而 gitignore 只影响未跟踪文件，已入库的不会被自动移出。
这与项目自己的 clean-room 原则（不取对方素材）与 `replica/recon.md` 里「截图仅本地留存、不入库」
的声明自相矛盾，**开源发布会有法律风险**。

已 `git rm --cached` 移出跟踪（本地文件保留供继续比对），并验证 `.gitignore` 规则对新增文件生效。
现仓库内参考站素材数为 **0**。

### Feat（智能报价三项高频能力，对标 `quote-workbench.js` 88KB 中的高频子集）

- **产品变体选择**：同类产品常有多个规格（单火/双火、白/黑/香槟金），此前只能选产品选不到规格。
  归组规则用**白名单规格词 + 括号剥离**两级判定，不做「末段够短就算规格」的猜测——
  `WiFi 网关` 因此不会被误拆。选品后若同组还有其它变体，行内出现「换规格」，
  打开 Modal 列出全部变体（完整名称 + 规格 + 该变体价格），**替换当前行**而非新增行。
  换规格会清空覆盖价并提示（谈定价是针对具体规格的）。
- **逐项单价覆盖**：部分客户谈定了个别特殊价。行内「改单价」填入本次单价（≥0，两位小数），
  参与小计/毛利/对外合计/设计师返利；一二级返利按进货额计提仍走经销成本，不受影响。
  页面明写「仅本次生效，刷新即失效，不会写回产品库」，CSV 与 Excel 导出同步使用有效价。
- **导出 Excel**：在原 CSV 之外增加 `.xls`（HTML 表格格式，Excel/WPS 可直接打开）。
  数字**不带 `¥` 与千分位**，方便在表格里直接求和；表头含项目/客户/口径/件数/导出时间，
  合计行与说明行齐备。页面明确标注这是 HTML 表格格式，不假装是原生 xls 二进制。
- 移动端：两个 Modal 宽度 92vw、表格横向滚动、按钮可换行，窄屏不溢出。

### Docs（先建立全量对照基线）

用 REA 把参考站**全部 14 个脚本 / 701 KB** 导出后逐个精读，产出
`replica/full-parity-matrix.md`——把「已移植 / 部分 / 未移植 / 有意差异 / 依赖上游」
全部列清楚，避免"看着像有、其实没有"。结论：24 个板块中 17 个已完整移植，
4 个部分实现，1 个依赖上游，2 个为开源定位的有意差异。

### Feat（问题反馈自动上下文采集）

对标参考站 `fault-report.js` 的上下文机制（`featureFromElement` / `rememberAction` /
`rememberRequest` / `appVersion` / `context`）。此前用户报障必须自己复述"在哪个板块、
点了什么"，排查效率极低。现在：

- 新增 `lib/errorContext.ts`：内存内收集最近 5 条**失败请求**、8 条**操作轨迹**、
  当前**路由**与**应用版本**；全局兜底捕获未处理异常与 Promise 拒绝。
- 反馈提交时自动把这些附在正文里，用户不必重复描述。
- 反馈页展示"已自动采集：N 项"并列出摘要，同时提供**「不附带」**开关——
  上下文是给排查用的，不是逼用户交数据。
- 提交成功后清空上下文，避免下一单混入上一单的信息。

### Feat（任务中心服务端化）

任务球此前只读前端内存态，**切页或刷新就丢**。现在以 `GenerationJob` 为准：

- 新增 `GET /api/canvas/tasks`（全租户最近 50 条，扁平化返回）与
  `DELETE /api/canvas/tasks/finished`（只清已结束，**进行中的必须保留**）。
- 任务球每 6 秒拉取，与本地即时任务按 id 合并去重；失败任务显示为红色而非绿色。
- 任务球位置持久化到 localStorage，刷新后不再复位。
- 新增 6 条 smoke 用例（含"清空已结束不会误删进行中"这条不变量）。

> 端点放在 `CanvasController` 而非新建模块：新建 `TasksModule` 会触发 Nest
> `Reflect.getMetadata` 的依赖扫描 TypeError，且为一个复用同一 service 的控制器
> 多开一个模块没有收益。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **206/206**，连续两次全绿

## [0.1.44] - 2026-10-13

### Feat（AI 画布：对话式生图）

用 REA 静态逆向参考站 `ai-canvas.js`（71,784 字节）后实现。先把机制写进
`replica/ai-canvas-spec.md` 再动手，避免「不理解就硬写」。

- **多轮对话线**：落库 `ImageConversation` / `ImageTurn`，换设备/清缓存不丢
- **变体追加而非覆盖**：重新生成追加为新变体（按 url 去重、已有编号永不重排），
  上一张不会被丢掉
- **分支树 + 分支切换**：基于任一历史图派生新分支，`‹ 分支 N/M ›` 导航循环切换，
  原链路完整保留
- **异步作业 + 轮询**：新增 `GenerationJob` 表与作业端点，出图不长时间占住连接
  （这是我方 `POST /api/media/images` 同步阻塞之外的改进）
- **来源可追溯**：每轮标注「基于上一轮的结果继续」
- **历史轮次恢复编辑**：一键把某轮提示词拉回输入框
- **变体灯箱**：放大查看、左右翻页、从任一变体继续派生
- 侧栏「AI 能力」新增入口，百宝箱新增「AI 画布」工具卡（配语义匹配专属预览图）

### Fix（数据丢失风险：全库备份漏表）

`GET /api/admin/backup` 号称「全库 JSON 快照」，但 `BACKUP_TABLES` 只有 22 项，
而 schema 已有 28 个模型。**漏掉的 6 张表会导致恢复后数据凭空消失**：

- 0.1.40 漏：`CustomAgent`（定制智能体）、`FeedbackTicket`（问题反馈工单）、`LightingScene`（灯光场景）
- 0.1.44 漏：`ImageConversation` / `ImageTurn` / `GenerationJob`（AI 画布全部创作记录）

已补齐到 28 张，并新增 smoke 断言**锁死这个不变量**：直接读 `prisma/schema.prisma`
解析出所有 model，与备份返回的表名逐一比对，以后再加表又漏掉会立刻测试失败。

### Fix（我自己引入又自己抓回来的假控件）

- 初版在画布里做了「质量（标准/精修）」选择器，**但 `quality` 只是参数快照、不影响出图**
  ——正是 0.1.43 刚清理掉的那类假控件。已整块移除。真实成本是
  `BILLING_IMAGE_TOKENS`（默认 300 token），前端拿不到该数值，无法诚实展示
  「本次花多少」，所以不硬凑一个假的成本提示。

### Chore

- 百宝箱工具卡 19 → 20，图片语义对齐，key 唯一性已校验。

### Verified

- `pnpm typecheck` ✓ / `pnpm build` ✓
- `pnpm smoke` ✓ **201/201**（150 → 200 新增 50 条，+1 条备份覆盖护栏），连续两次全绿；
  新用例覆盖对话线 CRUD、轮次树父子链、跨租户 404、parentId 跨会话 400、
  非法 refAssetId 400、作业轮询、变体去重与编号不重排
- 浏览器实测：真实出图成功、额度 800→797 真实扣费、变体标签与操作按钮正常
- 迁移 `20261013102000_image_canvas` 已应用，三张表就位

### 下一轮候选（已评估，不硬塞）

- **涂鸦选区局部重绘**：依赖上游支持 mask/inpaint，我方生图接口暂不接受 mask。
  本轮不做「只能预览、不能真正重绘」的假功能。

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
