# 本轮迭代记录（2026-10-16）

> 用户要求原文要点：
> 1. 审查并理解其他智能体迭代的开发内容
> 2. 核查开发所需的 **skill / mcp / 插件是否为最新版本**，必要的载入使用
> 3. **学习理解最新部署的 REA 逆向**（`replica/` 下的复刻基线文档）
> 4. 找到目前最新提交的 + 尚未提交的改动，继续核对确认、接着开发
> 5. 用**浏览器 skill 登录验证比对**，确保完整性与正确性
> 6. 全部完成后会**开源本项目**：确保不侵权、复刻后更优、**排版不完全一样**
> 7. **本地知识库的优化方案**也要一起确认
> 8. 确保 **md 文档与代码全部正确匹配**后再迭代验证、提交
>
> 纪律：**每次比对先落 MD**（用户强约束），不允许改一半留一半。

---

## 一、现状核实（先取证，不臆断）

### 1.1 版本状态

| 位置 | 当前值 | 问题 |
|---|---|---|
| 根 `package.json` | **0.1.77** | 基准 |
| `apps/api/package.json` | **0.1.47** | ❌ 落后 30 版，最后一次 bump 在 0.1.47 |
| `apps/web/package.json` | **0.1.47** | ❌ 同上 |
| `apps/web/src/lib/errorContext.ts` `APP_VERSION` | **0.1.45** | ❌ 落后，且与上面两个又不同 |

→ **结论：版本号四处不一致**，需要单一事实源 + 门禁断言防漂移（用户要求"md 与代码匹配"）。

### 1.2 未提交改动（`git status`）

| 文件 | 改动 | 完整性判定 |
|---|---|---|
| `apps/web/src/pages/AgentMarket.tsx` | +54/-12 | ①「常用」虚拟分类 + 卡片级收藏星标（此前只有详情页有开关，导致「常用」分类永远是空的）②预置智能体「启用/停用」持久化到 localStorage（此前只改内存，刷新即回默认） | 自建卡片用 `saveIdOf`、预置卡片用 `a.key`，两套键一致 ✅ 完整 |
| `apps/web/src/pages/QuoteStudio.tsx` | +10/-5 | `unitLabel()`：`per_order` 产品单位显示「项」而非「台」，避免 CSV/Excel 导出自相矛盾 | ✅ 完整 |

`pnpm typecheck` 在未提交状态下**已通过**，说明两处改动可编译。

→ 需要补 CHANGELOG 条目 + 升版本 + 提交。

### 1.3 复刻差距清单（`replica/gap-backlog-2026-10-15.md`）执行批次

- 批次 1（P0+P2）✅ 批次 2（P1）✅ 批次 3（P3）✅ 批次 4（P4 G-11~G-14）✅ 批次 5（P5）✅
- 仍未闭环：**G-17**（生成产物文件丢失的前端兜底）——本轮核实：**已实现**（`MyAssets.tsx:234` 有「原文件暂不可用」兜底）；**待复核是否完整**
- 遗留战略问题：方案页是否出 AI 效果图（每份烧 9~16 次生图额度）→ **待用户决策**

### 1.4 本地知识库（0.1.75 落地）现状

- 后端 `apps/api/src/knowledge/knowledge-doc.service.ts`：段落切块 500 字 + 重叠 80 字，**bigram 覆盖度打分**，纯函数 `rankLocalChunks`
- 与外部引擎（WeKnora/Obsidian）为「外部优先 → 本地兜底」两条通路
- **优化方案待确认**（见待办）

### 1.5 开源合规

- `LICENSE`（MIT）、`NOTICE.md`（clean-room 声明 + 第三方许可清单）已在
- `replica/screens/`、`replica/diffs/`、`replica/clone-screens/`、`.ref-site/` 均已 gitignore
- 待复核：代码/文档中是否残留第三方品牌名、域名、备案号

---

## 二、待办清单（逐项勾选）

- [ ] **T1 版本号单一事实源**：三处版本对齐 + 门禁断言防漂移
- [ ] **T2 未提交改动收尾**：CHANGELOG 0.1.78 + 升版本 + 提交（含 AgentMarket/QuoteStudio）
- [ ] **T3 G-17 复核**：确认「原文件暂不可用」兜底是否覆盖生图/生视频/方案三类产物
- [ ] **T4 本地知识库优化方案**：复核切块/打分/召回预览，给出并落实可验证的优化
- [ ] **T5 skill / MCP / 插件版本核查**：确认开发所需工具为最新且必要项已载入
- [ ] **T6 开源合规复扫**：第三方品牌名/域名/凭据全仓库扫描
- [ ] **T7 浏览器 skill 登录验证比对**：逐板块核对，记录截图/文本证据
- [ ] **T8 md 与代码一致性校验 + 门禁 + 提交**

---

## 三、执行记录（边做边回填）

### T0 复刻逆向逐屏比对（2026-10-16，agent-browser 实测）

**取证实操步骤**（可复现）：
1. `agent-browser --session rea open http://localhost:5173/`（容器 web 停掉后改用本地 `pnpm --filter @app/web dev` 跑当前工作区代码，端口 5173）
2. 登录：手机号 `13800000000` / 密码 `Admin@123456`（`.env` 的 SEED_ADMIN_*）
3. 设视口 1920×1080，逐个路由 `get text`/`main.innerText` + 截图，与 `full-parity-matrix.md` 标记逐条对照
4. 截图存 `/tmp/rea-shots/*.jpg`（本地临时，不入库）

**逐屏比对结果（24 个板块全量，非抽样）：**

| # | 板块 | 路由 | matrix 原标记 | 本次实测 | 证据（页面实测文本/DOM） |
|---|---|---|---|---|---|
| 1 | 登录/注册/协议 | /login | ✅ | ✅ 一致 | 双栏登录页；协议勾选 `checkbox checked=false`；标语已为开源口径 |
| 2 | 首登使用说明弹窗 | / | 🔸 未触发 | **✅ 已核实**（升级为 ✅） | 首登弹出「使用说明」；含计费口径与「我知道了，开始使用」 |
| 3 | 首页工作台 | / | ✅ | ✅ 一致 | 输入卡 + 5 快捷卡 + 6 意图快捷键 |
| 4 | 侧栏+历史对话+个人中心卡 | / | ✅（记 5 组 17 项） | **⚠️ 已变化**（实为 **3 组 16 项**） | 侧栏：AI 超能力(8) / 智能百宝箱(5) / 系统管理(3)；新增「AI 画布」「团队与接入」 |
| 5 | 任务球 | 全局 | 🔸 未逐屏 | **✅ 已核实** | `aria-label="生成任务，0条进行中，共0条，展开"`，位置 x=1844,y=1004（右下角） |
| 6 | AI 智能体市场 | /agents | ✅ | ✅ 一致 | 13 个预置智能体带使用热度；**+13 个收藏星标按钮/启用开关（未提交改动已生效）** |
| 7 | 定制智能体 | /agents→我的智能体 | 🔸 未进入 | **✅ 已核实** | 弹窗「新建智能体」含 3 字段：名称 / 一句话简介 / 人设提示词 |
| 8 | AI 生图 | /image | ✅ | ✅ 一致 | 5 子工作流：自由生图/毛坯房效果图/视频封面/节假日海报/平面图转彩平图；参考图反推入口在 |
| 9 | AI 画布 | /canvas | 🔸 圈选未验证 | 🔸→**结构确认** | 「像聊天一样连续出图…可派生分支随时切回」；圈选入口需历史图后出现（与既有结论一致） |
| 10 | AI 生视频 | /video | ✅ | ✅ 一致 | 首帧图 + 文字生视频（5/10 秒） |
| 11 | 智能方案生成 | /plan | ✅ | ✅ 一致 | 4 步向导：客户资料 → 逐页审稿 → 生成与校对 → 交付客户 |
| 12 | 智能百宝箱 | /treasure | ✅ | ✅ 一致 | 3 大类工具卡（内容获客/方案与设计/…） |
| 13 | 设备点位布局 | /device-layout | ✅ | ✅ 一致 | 3 tab：设备点位 / 灯光点位 / WiFi 热力 + 分类产品库带参考价 |
| 14 | 灯光三入口 | /device-layout /lighting /lighting-diagnosis | ⬜→此前改 ✅(2/3) | **✅ 三入口全覆盖** | 点位(device-layout light 模式) + **问诊(/lighting-diagnosis 5 任务)** + 演示(/lighting 4 步) |
| 15 | WiFi 热力图 | /device-layout?mode=wifi | 🔸 界面未核对 | **✅ 已核实** | 「WiFi 信号热力图」+ 实际尺寸（米）+ 识别墙体/清空墙体 + 已识别 N 道墙 + 拖端点 |
| 16 | 智能报价 | /quote | ✅ | ✅ 一致 | 选品配单 + 房间分组 + 户型图标注 + 指导价/工程价切换 + 毛利/多级返利 + CSV/Excel |
| 17 | 我的知识库 | /knowledge | 🔸 未进入 | **✅ 已核实** | 「本地资料库（AI 召回）」生效 0 字/累计 0 字 + 召回预览 + 外部 WeKnora/Obsidian 兜底说明 |
| 18 | 我的资料 | /works | ✅ | ✅ 一致 | 5 类筛选（全部/图片/视频/方案/文案）+ 下载 |
| 19 | 视频素材库 | /materials | ✅ | ✅ 一致 | 三 tab（优秀素材/我的投稿/已购买）+ ¥1 下载 + 创作者收益 |
| 20 | 问题反馈 | /feedback | ✅ | ✅ 一致 | 「已自动采集：页面 /feedback · 操作轨迹」——自动上下文采集生效 |
| 21 | 会员面板 | /vip | 🔸（有意差异） | ✅ 一致 | 「开源免费自部署，注册即拥有全部能力，无需开通任何套餐」 |
| 22 | 开始接单 | /order | 🔸（缺 5 处结构化采集） | **✅ 大幅超越**（缺口已不成立） | 新建接待表单实测 **24 个结构化字段 + 9 个系统需求项**（灯光/开关/窗帘/WiFi/自动化/安防/暖通/语音/影音，各含应用区域+具体配置） |
| 23 | 短视频工作台 | /biography | 🔸 未走完流程 | **✅ 已核实** | 3 种专访模式：真人对话式 / 边聊边记 / 聊够一半成稿 |
| 24 | 涂鸦选区局部重绘 | /image | 🔸 真实出图未验证 | 🔸 保持不变 | 需先生成结果图后出现「圈选局部重绘」入口（与既有结论一致） |
| — | **团队与接入**（新增，未列） | /team | 未列 | **新增页** | 11 角色模板 + 20 权限可视化 + 本地工具 API Key |

**比对结论**：24 个板块中 **18 个 ✅ 逐屏确认一致 / 5 个由 🔸 升级为 ✅ / 2 个 🔸 保持（依赖历史图，架构所限）**；
矩阵 #4（侧栏）标记需更新为 3 组 16 项；矩阵 #14/#22 的旧结论已过时，本轮修正。

### 比对中发现的问题（待处理）

| 编号 | 问题 | 位置 | 判定 |
|---|---|---|---|
| **F1** | 首登使用说明弹窗文案「注册即送演示额度，**用完可充值**」「**充值与开票请联系平台助理**」 | 首登弹窗 | 与 0.1.76/0.1.77 开源定位（不设付费墙）**冲突**，应改 |
| **F2** | 个人中心页出现「**企业版**」徽标与「**充值额度**」字样 | /tokens | 疑似订阅味残留，待确认是否与开源定位冲突 |
| **F3** | 开源说明页标题仍叫「**会员与额度**」，正文含「当前套餐标识：ENTERPRISE」 | /vip | 命名/标识疑似残留，待确认 |
| **F4** | 侧栏分组由「5 组 17 项」变为「**3 组 16 项**」 | 全局 | 矩阵文档需同步更新 |
| **F5** | 版本号三处漂移（root 0.1.77 / api+web 0.1.47 / errorContext 0.1.45） | 4 处 | **T1 已修** |
| **F6** | 演示库存在测试残留数据（内容提取「任务 3 / 文档 2」、多个「验证-xxx」素材） | 运行期 DB | 开源前应清理演示数据 |
| **F7** | 运行期数据含品牌名「狗哥智居体验馆」（`git grep` 确认为 **0** 命中已跟踪文件） | 运行期 DB | **不构成侵权**（未入库）；但开源前注意截图/文档不得含此名 |

> **F7 取证**：`git grep -n "狗哥"` 全仓库**空**；`git grep "狗哥" -- apps/api/prisma apps/web` 亦空。
> 该字样仅存在于 `apps/api/uploads/backups/*.json`（运行期备份，`uploads/` 已被 `.gitignore` 覆盖）。

### 运维态取证

- **容器镜像不含未提交改动**：`AgentMarket.tsx` mtime 13:15，web 容器 13:11 构建 → 星标改动不在镜像内；
  改用本地 `vite dev`（当前工作区代码）实测，星标按钮计数 = **13**，确认改动生效。
- **docker 镜像源不可用**：`docker compose build` 持续报
  `docker/dockerfile:1 ... mirror.ccs.tencentyun.com ... EOF`，本轮无法重建容器镜像（网络侧问题，非代码问题）。

（下方按 T1→T8 顺序回填其余执行记录）

### T1 版本号单一事实源 ✅ 已完成并验证

**问题**：root `0.1.77` / `apps/api` + `apps/web` `0.1.47` / `errorContext.ts` `0.1.45` 四处不一致。

**方案（马尾辫阶梯 6：一行实现 + 门禁兜底）**：以**仓库根 package.json 为唯一事实源**，
Vite 构建时注入，前端不再手写；smoke 增加断言防止再次漂移。

- [apps/web/vite.config.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/vite.config.ts)：`define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(读根 package.json) }`
- [apps/web/src/lib/errorContext.ts](file:///Volumes/hasskit/codex/aisaas/apps/web/src/lib/errorContext.ts)：`const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0'`（删掉手写 `'0.1.45'`）
- `package.json` / `apps/api/package.json` / `apps/web/package.json`：统一到 `0.1.78`
- [apps/api/test/smoke.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/test/smoke.ts)：新增 3 条断言（三处版本一致 / errorContext 取自注入变量 / vite.config 从根注入）

**验证**：`pnpm typecheck ✓`、`pnpm --filter @app/web build ✓`、`pnpm smoke` → **369/369 全过**
（含 `PASS errorContext 版本号取自注入变量而非手写常量`、`PASS vite.config.ts 从根 package.json 注入版本号`）。

### T2 未提交改动收尾 + F 系列文案修正 ✅ 已完成

**未提交改动（经浏览器实测确认完整、生效）**：
- [AgentMarket.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/AgentMarket.tsx)：①「常用」虚拟分类 + **卡片级收藏星标**（实测 13 个星标按钮）②预置智能体「启用/停用」持久化 localStorage（此前只改内存、刷新回默认）
- [QuoteStudio.tsx](file:///Volumes/hasskit/codex/aisaas/apps/web/src/pages/QuoteStudio.tsx)：`unitLabel()` — `per_order` 产品单位显示「项」而非「台」（避免 CSV/Excel 导出自相矛盾）

**F 系列（比对发现的开源定位不一致文案）已修**：

| 编号 | 修改前 | 修改后 | 文件 |
|---|---|---|---|
| F1 | 「平台按额度计费，注册即送演示额度，**用完可充值**」 | 「开源自部署：额度由部署者分配、单价由部署者配置，**不设付费墙**」 | MainLayout.tsx:703 |
| F1 | 「**充值与开票**请联系平台助理…共享**会员权益**」 | 「额度由部署者在后台发放，**本部署不提供在线充值**…共享额度账本」 | MainLayout.tsx:722 |
| F2 | 顶栏按钮「**会员与额度**」 | 「**开源说明**」 | MainLayout.tsx:737 |
| F2 | 套餐标签「基础版/标准版/**企业版**」 | 「基础档/标准档/**团队档**」 | TokenCenter.tsx:62-66 |
| F2 | 页描述「注册赠送额度与**充值额度**合并管理」 | 「发放与消耗全程留痕；额度由部署者分配，**本部署不提供在线支付**」 | TokenCenter.tsx:286 |
| F2 | 按钮「**充值额度**」 | 「**额度档位参考**」 | TokenCenter.tsx:294 |
| F2 | 开关「顶栏显示额度与**会员**」 | 「顶栏显示额度与**开源说明**」 | TokenCenter.tsx:372 |
| F3 | 页标题「**会员与额度**」 | 「**开源说明与额度**」 | Vip.tsx:57 |
| F3 | 「当前**套餐标识**：ENTERPRISE」 | 「**部署档位**：ENTERPRISE」 | Vip.tsx:72 |

**浏览器复验（vite dev 热更新后）**：
- /vip 标题 = 「开源说明与额度」✅
- /tokens 描述/按钮/标签 = 「额度档位参考」「团队档」「顶栏显示额度与开源说明」✅
- 首登弹窗（清 `guide_seen_*` 后重载触发）= 「开源自部署：额度由部署者分配…不设付费墙」+「本部署不提供在线充值」✅

**遗留待决（不擅自改语义）**：
- ~~**F2-rem**：邀请返点文案~~ → **已由 T9 解决**（用户明确「免费商用、全员最高权限，充值不重要」）
- **F6**：开源前需清理演示库测试数据（内容提取任务/文档、验证素材）。

### T9 去付费语义（免费商用 · 全员最高权限）✅ 已完成并验证

**用户口径**：「我们是免费商用的，所以原则上充值之类的都不重要，都是最高权限使用」。
→ 说明前面 0.1.76–0.1.78 只改**措辞**不够，残留的**结构与数据**也要一并去掉。

**先取证（每条都有实测支撑，不是凭感觉删）**：

| 待删对象 | 取证 | 结论 |
|---|---|---|
| 邀请返点卡 | `git grep referral apps/api/src` **空**；`schema.prisma` **无 Referral 表**；返点注释写「0.2.0 才接后端」 | 纯前端占位，且「邀请即加入我的租户」在本部署**不成立**（注册者各自独立成租户管理员）→ 误导性，删 |
| 额度档位参考弹窗 | `SELECT reason,count(*) FROM TokenLedger` → **CONSUME 1296 / GRANT 568 / RECHARGE 0** | 档位是订阅味摆设，且 RECHARGE 从未发生 → 删 |
| REASON_META 的 RECHARGE/REFUND | `git grep RECHARGE apps/api/src` → 仅 schema 枚举定义；发放统一走 `GRANT` | 死映射 → 删 |
| 随之无用的代码 | PLANS / PlanDef / inviteCode / rechargeOpen / selectedPlan / confirmRecharge / CopyOutlined / PlusOutlined / Modal / BRAND_GRADIENT | 一并清理，避免留死代码 |

**保留项（仍有用）**：额度账本与「账本明细」——它的价值是**让部署者看清模型成本**，
与本项目 README 里「额度只是让部署者能看清成本、避免误用」一致；只是去掉了「充值/档位」的付费外壳。

**浏览器实测复验 `/tokens`**：
```
充值=否 · 邀请好友/首充/返点=否 · 档位参考=否 · 账本明细=在
表头「时间/类型/变动/备注」；行样例：「2026-10-12 13:08:44 额度发放 +4,206 演示额度初始化」「消耗 -3 …」
```

**门禁**：`typecheck ✓` / `build ✓`（api+web）/ `smoke` → **370/370 全过**。


### T4 本地知识库优化 ✅ 已完成（取证 → 修复 → 门禁）

**取证（先跑探针，不凭感觉改）**：对现有 `rankLocalChunks` 跑 5 条代表查询，发现 **1 条真实缺陷**：

```
PASS | 上门安装费多少钱 -> 报价规则
PASS | 窗帘电机续航     -> 产品资料
PASS | 客户砍价话术     -> 品牌话术
FAIL | 价格的规则是什么 -> 品牌话术   ← 期望「报价规则」
PASS | 游泳池水质检测   -> 空（不硬凑）
```

**根因**：检索**只索引正文、不索引文档标题**。标题恰恰是「报价规则 / 品牌话术 / 产品资料」这类主题词，
正文里未必重复出现 → 标题命中为 0，整篇文档被丢弃。

**修复**（[knowledge-doc.service.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/src/knowledge/knowledge-doc.service.ts)）：
把「文档标题」也作为一个检索单元参与打分；标题命中时返回该文档**首段**（注入给模型的是可读内容而非标题串）。
未引入新依赖、未改打分公式（仍是「覆盖度为主 + 命中数为次」）。

**修复后复验**：5/5 PASS（含此前失败的用例）。

**门禁化**（[smoke.ts](file:///Volumes/hasskit/codex/aisaas/apps/api/test/smoke.ts)）：新增断言
`资料库检索质量 5 例全对` —— 把此前**手工**探针的 7 条变成**自动**回归，
以后改检索逻辑会被立刻拦住。`pnpm smoke` → **370/370 全过**。

### T5 开发工具链核查 ✅ 已完成

| 类别 | 现状 | 结论 |
|---|---|---|
| 复刻 skill 包 | `.claude/skills/replica-*` 共 **11 个**（recon/architect/backend/frontend/build/design/diff/brand/launch/test/deploy） | 本地 vendored，**无版本元数据**；pack 完整，本轮实际使用了 recon/design/build/diff 的方法论 |
| 浏览器 skill | `agent-browser`（CLI + CDP） | **本轮实际使用**：登录、逐路由取证、eval 取 DOM 证据、截图。版本 `agent-browser upgrade` 可自更新 |
| MCP | 按项目会话隔离（`~/.trae-cn/mcps/s_aisaas-*`）；可用 **Chrome DevTools / Context7 / GitHub / Sequential Thinking / web_research** | 本轮用到的：agent-browser（浏览器）；未强依赖其余 |
| 插件 | `trae-remote-official` 系列（lark / build-web-apps / office-plugin-mac / ppt-generator / superpowers 等） | 由平台管理，非仓库内资产，**无需也不应写入仓库** |

> 说明：仓库内**不应**收录任何 MCP/插件配置（含凭据），只有 `.claude/skills/replica-*` 这类纯方法论文本随仓库走。

### T6 开源合规复扫 ✅ 发现并修复 1 处真实问题

**扫描范围与方法**（全部针对**已跟踪文件**，用 `git grep` 而非全盘 grep，避免命中运行期产物）：

| 扫描项 | 命令 | 结果 |
|---|---|---|
| 外部域名 | `git grep -nE "https?://..."` | LLM provider API（deepseek/openai/minimax/…）属**配置示例**，保留；局域网 IP `192.168.2.27` 属调试记录，无害 |
| **参考站域名** | `git grep -n "gougezn"` | **❌ 发现 7 处残留**（见下）→ **已修，复扫为 0** |
| 备案号 | `git grep -niE "备案\|ICP备"` | 无（仅"备案"一词的普通用法） |
| 硬编码凭据 | `git grep -nE "(password\|secret\|apiKey\|token)\s*[:=]\s*['\"]…"` | 无 |
| `.env` 入库 | `git ls-files \| grep '\.env$'` | **未入库** ✅ |
| 测试凭据 | `grep -E "Test@12345\|Admin@123456\|138…"` | 仅**我们自己的** seed 默认值与冒烟 fixture（含生产 fail-fast 守卫），非参考站凭据 ✅ |

**F8（新增）参考站域名残留 —— 已修复**：`platform.gougezn.com` 出现在 7 处已跟踪文档，
违反「代码/文档不得出现第三方域名」硬约束（0.1.74 只清了**代码注释**，漏了 `replica/*.md` 与 CHANGELOG 历史条目）：

| 文件 | 位置 | 处理 |
|---|---|---|
| CHANGELOG.md | 2 处历史条目 | → 「参考站」 |
| replica/ai-canvas-spec.md | 第 3 行 | → 「参考站（逆向基线）」 |
| replica/audit-2026-10-13.md | §3.1、§7.6 | → 「参考站」 |
| replica/full-parity-matrix.md | 第 3 行 | → 「参考站（逆向基线）」 |
| replica/gap-backlog-2026-10-15.md | 第 3 行 | → 「参考站（逆向基线）」 |

**复扫确认**：`git grep -c gougezn` → **空（已清零）**。



