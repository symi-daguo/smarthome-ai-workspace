# 增强型智能家居 AI SaaS 平台规划文档

- 版本：0.1.0（规划稿）
- 日期：2026-09-24
- 状态：已确认，进入实施（技术决策见第 11 章，开发计划见第 12 章）
- 适用：基于目标系统（已线上运行）采集调研后的增强型重构规划

---

## 1. 项目概述

### 1.1 背景

目标系统是一套面向智能家居行业的 AI 内容生成 SaaS：覆盖智能方案生成、平面图渲染、灯光场景、生图、生视频、文案、知识库、接单与报价等垂直场景。本次通过浏览器完整采集了其功能模块、交互流程、UI 设计规范、API 地图及计费体系，并完成了开源生态与 2026 年技术栈的联网调研。

### 1.2 目标

1. 能力对齐：完整覆盖目标系统已验证的全部功能，体验不低于原系统。
2. 架构增强：多租户隔离、RBAC 权限、真正的 agent 工具调用（MCP 协议）、品牌知识库（双层 RAG）、全球大模型接入层。
3. 商用合规：规避开源组件的多租户 SaaS 许可证风险。
4. 体验升级：React 19 + Ant Design 6 组件化重构、响应式、暗色模式、i18n（默认中文，预留英文）。
5. 技术锁定：采用 2026 年最新稳定版技术栈，遵循"不重复造轮子"原则。

### 1.3 范围界定（YAGNI）

本文档只规划当前需求必需的能力。需求不明确、未来可能用到的功能一律不实现；不为假设的未来需求做抽象。

---

## 2. 目标系统采集报告

### 2.1 技术架构现状（代码级证据）

| 维度 | 现状 |
|---|---|
| 前端形态 | 自研原生 JS 模块化 SPA，非 Vue/React，无组件化 |
| 路由 | hash 路由，`app.js?v=20260923-biography-history-v1`（约 250 行路由清单） |
| 鉴权 | Bearer Token，localStorage 键 `smartPptToken` |
| 幂等提交 | `clientRequestId` + SHA-256 客户端去重（`platform-client.js` 完整实现） |
| "意图路由" | `route-loader.js` 的 `intent()` 为正则关键词匹配，非真正 agent 工具调用 |
| 分包发版 | 按功能分包、按日发版（`floorplan-render.js` 59KB、`lighting-scene.js` 93KB、`wifi-heatmap.js` 58KB、`ai-canvas.js` 69KB） |

### 2.2 功能模块矩阵

| 模块 | 路由 | 核心能力 |
|---|---|---|
| 短视频工作台 | `#/biography` | 人物/品牌传记视频生成，历史记录 |
| 开始接单 | `start-order.html` | 接单工作流 |
| AI 智能体 | `#/agents` | 会话、异步任务轮询 `/api/agents/jobs/{id}`、自定义删除 |
| AI 生图 | `#/image` | 同步 generate + 异步 `generate/main`、gen-jobs、历史、adapt-prompt |
| AI 生视频 | `#/video` | 生成、jobs 轮询、check-prompt、adapt-prompt、历史 |
| 智能方案生成 | `#/plan2` | 全屋智能方案，11 套视觉风格库 |
| 智能百宝箱 | `#/space` | 平面图渲染、灯光场景、WiFi 热力图、AI 画布 |
| 我的知识库 | `#/knowledge` | 上传、启用/停用、删除 |
| 我的资料 | `#/assets` | 账号资产 |
| 优秀视频素材库 | `#/excellentVideoMaterials` | 素材浏览 |

### 2.3 API 地图（约 90 个端点，经 11 个 JS 分包静态扫描提取）

- 账号：`/api/{login,register,captcha,sms/send-code,me,health}`
- 智能体：`/api/agents/*`（jobs 异步轮询、custom/delete）
- 生图：`/api/images/{generate,generate/main,gen-jobs,history,adapt-prompt}`
- 生视频：`/api/videos/{generate,jobs,check-prompt,adapt-prompt,history}`
- 方案：`/api/projects/*`
- 知识库：`/api/knowledge/{upload,toggle,delete}`
- 商品报价：`/api/products/*`、`/api/quote/*`、`/api/public-products`、`/api/quote-templates/*`
- 内容运营：`/api/douyin/rewrite/*`（pending/redo/requests）、`/api/xhs/*`、`/api/publish/{platforms,orders}`
- 客服：`/api/cs/{ask,my-tickets}`
- 专项工具：`/api/edit/*`、`/api/floorplan-render/*`、`/api/lighting-scene/*`、`/api/lighting/video-jobs`、`/api/image-editor/*`
- 平台管理：`/api/fault-reports`、`/api/admin/points`、`/api/generation-tasks`

### 2.4 UI 设计规范（2026-10-02 实测采集修正，基线见 `.ref-site/采集记录.md`）

- 浅色主题，品牌紫 #6D4DF6；**侧栏/顶栏/卡片全部白底或浅灰底，无深色侧栏**；紫色渐变仅用于主按钮与 CTA（"+ 新对话""短视频工作台""开通会员"），发送/登录为黑色胶囊
- 布局：白色左侧栏（约 300px，可折叠）= 渐变新对话按钮 + 分组导航（AI 能力 / 智能百宝箱）+ **历史对话内嵌侧栏**（标题 + "智能体名 · MM/DD HH:mm"）+ 底部个人中心卡
- 首页：居中数字人头像 + "Hi，欢迎回来" + **大输入卡（含 4 个功能 chip：上传附件/图生图/生视频/生方案 + 黑色圆形发送）** + **5 张快捷卡**（方案/海报/视频/文案仿写/找智能体）
- 右下角任务球：黑色圆球 + 红点角标，可拖拽、Esc 收起、Home 复位；展开面板=多任务队列 + "清空已结束" + "查看全部历史"
- 顶栏右侧：**额度胶囊为 ¥ 金额小数（如 ● 590.81）** + 青色"使用指引"浮动按钮
- 新手引导为**弹窗序列**（使用说明 → 多账号公告），每账号每浏览器一次，localStorage 记标记；非 Tour 气泡
- 方案视觉风格库 11 套：A 暖咖 / B 莫兰迪 / C 轻奢深色 / D 原木侘寂 / E 黑白 / F 新中式 / G 奶油法式 / H 意式灰 / I 深空科技 / J 祖母绿 / K 手绘水彩
- 登录页：智能家居实景照片背景 + 左渐变品牌卡（4 卖点 + "已服务 1000+ 智能家居服务商"）+ 右白底表单（协议勾选 + 免费注册测试入口）

### 2.5 会员与计费体系

| 档位 | 价格 | 生图额度 | 对话额度 | 设备数 |
|---|---|---|---|---|
| 入门版 | ¥299/月 | 80 张 | 50 次 | 1 |
| 标准版 | ¥2,980 永久 | 1600 张 | 6000 次 | 3 |
| 企业版 | ¥19,800/年 | 30000 张 | — | 10 |

生成单价：生图 ¥0.5–1.41/张、生视频 ¥4.6/条起、生方案 ¥0.6–1.6/页、文案约 ¥0.03/次。

实测补充（2026-10-02）：额度以**人民币元展示、两位小数**（如 ¥590.81 / 总额度 ¥1000）；个人中心含**单价明细表**与**邀请码裂变**（好友首充双方各得 10% 额度）；素材库为独立 UGC 市场（下载 1 元/条，投稿收益 5 元 + 被下载 1 元）。

### 2.6 复刻差距清单（16 项，迭代依据）

完整表见 `.ref-site/采集记录.md` §13 与 §18。摘要：

- 布局层：①白色侧栏+分组标题+渐变新对话按钮 ②历史对话内嵌侧栏 ③首页居中头像+输入卡(4 chip)+5 快捷卡 ④¥ 小数额度胶囊+使用指引按钮 ⑤任务球（含 ⑯红点实时联动）
- 功能页：⑥智能体市场（分类 pill+热度+启用开关）⑦生图向导（参考图+17 场景 chip+模型参数+案例库）⑧生视频（首尾帧+时长/画质/比例/声音）⑨方案 4 步向导+11 风格卡 ⑩百宝箱 18 工具卡 ⑪知识库 UI（开关+多文件）⑫我的资料（分类+日期分组）⑬接单 5 步向导 ⑭登录页（实景背景+协议+免费注册）⑮短视频工作台（IP 档案复用+访谈式工作站）
- 计费层：token 整数 → **¥ 金额制（两位小数）+ 单价表 + 邀请码首充返 10%**
- 优先级建议：①–⑤⑭ 为纯前端布局重构，一次交付；⑥⑫⑪ 前后端小改；⑦⑧⑨⑩⑮ 属 S3/0.2.0 生成能力范围；⑬ 属 0.3.0
- **移植状态（2026-10-06 审查）**：①–⑤⑭⑯ 已交付（0.1.4，agent-browser 端到端验证通过：协议拦截、首页布局、输入卡、任务球、历史内嵌、侧栏折叠、¥ 额度胶囊、使用指引弹窗、console 无报错）；⑥–⑬⑮ 按计划排期（0.2.0/S3/S4/0.3.0），详见 `.ref-site/采集记录.md` §13 状态列

---

## 3. 核心优势、不足与技术局限性分析

### 3.1 核心优势

1. 垂直场景闭环完整：方案设计 → 渲染出图 → 文案 → 视频 → 发布，全链路覆盖智能家居行业。
2. 工程细节稳健：客户端幂等提交（`clientRequestId` + SHA-256）、异步任务轮询，弱网与重复点击体验好。
3. 迭代速度快：按功能分包、按日发版，单点更新不影响全局。
4. 商业模式成熟：三档会员 + 按量计费双轨，静态授权（永久版）与订阅（年/月）结合。

### 3.2 不足与技术局限

1. 架构不可维护：原生 JS 无组件化，路由集中在单文件，页面级 JS 达 59–93KB，无类型系统，无测试设施。
2. "AI 智能体"是伪 agent：`intent()` 为正则关键词路由，无工具调用协议、无任务规划、无 MCP 支持，无法访问外部工具。
3. 无多租户与 RBAC：单租户假设；管理端仅 `/api/admin/points` 点数接口，无角色权限体系。
4. 知识库浅层：仅上传/开关/删除，无向量化、无检索、无 RAG，知识无法被生成流程利用。
5. 模型接入写死：无统一模型网关，无法全球多模型路由、降级与成本管控。
6. 体验局限：固定桌面视口（约 1887px）、无响应式、无暗色模式、无 i18n、任务球仅展示单任务。

---

## 4. 开源生态调研与选型决策

### 4.1 候选项目评估（含许可证边界）

| 项目 | 许可证 | 多租户 SaaS 商用风险 | 结论 |
|---|---|---|---|
| Dify | 修改版 Apache 2.0 | 禁止基于源码运营多租户 SaaS、禁止去除品牌 | 不引入源码；仅评估作为独立外部服务的授权合规性 |
| FastGPT | 自有许可证 | 禁止同类多租户 SaaS、禁止改 LOGO | 排除 |
| RAGFlow | Apache 2.0 | 允许 | 知识库 RAG 二期候选 |
| AnythingLLM | MIT | 允许 | 备选 |
| Langflow | MIT | 允许 | 可视化编排备选 |
| LiteLLM | MIT（core） | 允许 | 采用：全球模型网关 |
| ThingsBoard | Apache 2.0 | 允许（白标为 CE 付费功能） | 采用：IoT 多租户平台 |
| ComfyUI | GPL-3.0 | 独立进程部署、不链接其代码分发，风险可控 | 采用：多模态渲染后端 |
| Wan2.2（通义万相） | Apache 2.0 | 允许 | 采用：视频生成模型 |
| Qwen-Image-2.1 | Apache 2.0 | 允许 | 采用：图像生成模型 |

结论：无单一开源系统能完整覆盖目标系统全部场景且许可证安全。采用"自研业务主框架 + 开源能力组件"的组合路线，对 agent 运行时坚持自研轻量编排，规避 Dify/FastGPT 的许可证陷阱。

### 4.2 选型决策

| 能力域 | 选型 | 理由 |
|---|---|---|
| 业务主框架 | NestJS 12（自研） | ESM、装饰器、模块化、生态成熟 |
| Agent 运行时 | 自研 agent loop + MCP 协议 | 规避许可证风险，可控可测 |
| 模型网关 | LiteLLM | 虚拟 key、多窗口预算、Guardrails、全模型统一接口 |
| IoT 设备 | ThingsBoard CE | 原生多租户、规则引擎、数字孪生、白标（付费） |
| 多模态渲染 | ComfyUI + Wan2.2 / Qwen-Image-2.1 | 工作流模板 JSON 化，模型可换 |
| 知识库 | MVP 用 PostgreSQL pgvector；数据规模上来后迁 RAGFlow | 阶梯 3 优先标准库/数据库能力，不过度引入 |
| 队列 | BullMQ（Redis） | 已随技术栈引入，任务轮询体系直接复用 |

---

## 5. 增强型架构设计

### 5.1 总体架构（五层）

```
接入层      Web（React 19 SPA） / 未来小程序
网关层      鉴权（JWT）、租户解析（子域名 / X-Tenant-Id）、限流、审计
业务层      NestJS 12 模块化单体：
            auth / tenant / rbac / billing / content / agent /
            knowledge / iot / ops
能力层      LiteLLM 网关、ComfyUI 集群、ThingsBoard、
            BullMQ+Redis 队列、对象存储（S3/MinIO）
数据层      PostgreSQL 18（含 pgvector）、Redis、对象存储
```

模块化单体（modular monolith）起步，模块边界按未来可拆微服务设计；不与 YAGNI 冲突——单体内清晰的模块边界是零成本收益，过早拆微服务才是过度设计。

### 5.2 多租户隔离

- 共享数据库、按 `tenant_id` 行级隔离，PostgreSQL RLS（Row Level Security）兜底。
- 请求链路：Gateway 解析租户 → JWT 注入 tenantId → Prisma Client Extension 自动为所有查询追加 tenantId 条件，从框架层杜绝跨租户查询。
- 资源隔离：对象存储前缀 `tenants/{tenantId}/...`、BullMQ 队列前缀、LiteLLM team/key 级预算。
- 企业版预留独立 schema 升级路径，MVP 不实现。

### 5.3 RBAC 权限模型（五角色）

| 角色 | 范围 | 权限概要 |
|---|---|---|
| super_admin | 平台 | 租户管理、计费配置、系统配置、全量审计 |
| tenant_admin | 租户 | 成员管理、角色分配、订阅计费、租户内全部业务 |
| designer | 租户 | 方案/渲染/生图/视频等生产功能 |
| operator | 租户 | 接单、报价、发布、客服等运营功能 |
| viewer | 租户 | 只读浏览素材与方案 |

权限模型：`resource:action` 权限点 + 角色绑定，运行时用 `@casl/ability` 判定。MVP 固定 5 个内置角色，不支持自定义角色（YAGNI）。核心表：`tenants / users / roles / permissions / role_permissions / memberships`。

### 5.4 Agent 工具调用体系（MCP）

修复目标系统"伪 agent"缺陷，建立真正的工具调用闭环：

1. 工具注册：工具定义入库（name、描述、JSON Schema 入参、所需权限、计费点），形成工具目录。
2. 协议：采用 MCP（Model Context Protocol）作为工具标准协议，服务端实现 MCP client，模型侧用 function calling。
3. 内置工具（MVP）：生成方案、渲染平面图、生成图片、生成视频、改写文案、查询报价、发布订单、查询设备状态（ThingsBoard API）、检索知识库。
4. 执行链路：用户输入 → LLM 规划 → 工具调用（权限校验 + 计费预扣）→ 结果回填 → 流式（SSE）返回，全程审计入 `agent_runs` / `tool_calls` 表。
5. 长任务：复用目标系统验证过的异步轮询模式（job 表 + SSE 双通道）。

### 5.5 品牌知识库（双层 RAG）

- 平台层：产品白皮书、11 套风格库定义、行业话术模板，全租户共享。
- 租户层：品牌资料、历史优秀方案、客户画像，严格租户隔离。
- 实现：MVP 阶段用 PostgreSQL + pgvector（数据库内向量存储，不引入额外组件）；检索时按租户与密级做 ACL 过滤；规模上来后再评估迁移 RAGFlow。
- 嵌入与重排通过 LiteLLM 走统一模型，成本计入租户。

### 5.6 全球大模型接入层

- LiteLLM 统一代理：OpenAI、Anthropic、Google、DeepSeek、通义千问、智谱等全球主流模型；按任务类型配置路由（如文案走快模型、方案走强模型）。
- 治理能力：虚拟 key + 多窗口预算（日/月）、Guardrails 内容安全、pass-through 端点默认开启鉴权。
- 可靠性：超时重试、模型降级链、失败转移，调用日志与成本入库供对账。

---

## 6. UI/UX 优化方案

延续目标系统已验证的交互心智，替换底层实现：

1. 组件化重构：React 19.3 + Ant Design 6.6（CSS Variables 主题），彻底告别 59–93KB 页面脚本。
2. 保留并升级核心布局：左侧导航 + 会话历史 + 居中欢迎区；任务球升级为"全局任务中心"（多任务列表、ESC/Home 行为保持一致）。
3. 主题：主色延续品牌紫；AntD 6 的 CSS Variables 支持运行时切换，零成本实现暗色模式。
4. 响应式：桌面优先，补齐平板（1024px）与窄屏适配，修复原系统固定 1887px 视口问题。
5. i18n：默认中文，预留英文切换（面向后续海外上架），文案全部走字典，不硬编码。
6. 无障碍：WCAG 2.1 AA，对比度、焦点可见、键盘可达。
7. 一致性：设计 token（颜色/字号/间距/圆角）统一收口到 AntD 6 主题变量，11 套风格库转为可配置的主题预设数据。
8. 空态/错态/加载态全套规范化，删除确认沿用统一 Dialog（延续原系统"删除有确认"的良好实践）。

---

## 7. 2026 技术栈与实施方案

### 7.1 版本锁定表

| 组件 | 锁定版本 | 说明 |
|---|---|---|
| Node.js | 24.19.0 LTS | 本机运行版本即最新 LTS，满足 NestJS 12 要求（20.19+/22.12+） |
| TypeScript | 5.9.3 | TS 7.x 为原生编译器，生态兼容性未成熟，暂不采用 |
| NestJS | 12.0.x | ESM-only 包，Standard Schema = Zod |
| React | 19.3.0 | |
| Ant Design | 6.6.5 | 需 React ≥ 18，CSS Variables 主题 |
| Vite | 8.3.0 | 前端构建 |
| Prisma | 7.10.0 | 8.x 仍为 RC（8.0.0-rc.15），不采用；7.10.0 为最新稳定版 |
| PostgreSQL | 18.6 | 8 月安全更新修复 28 个 CVE，含 pgvector |
| Redis | 8.x | 队列与缓存 |
| LiteLLM | 1.84.x | 模型网关 |
| ThingsBoard | 4.x CE | IoT 平台 |
| ComfyUI | 最新稳定版 | 多模态渲染（服务端进程） |
| BullMQ | 5.x | 任务队列 |
| Zod | 4.x | 请求校验（Standard Schema） |

### 7.2 Monorepo 目录结构

```
apps/
  web/                # React 19 + AntD 6 SPA
  api/                # NestJS 12 模块化单体
    src/modules/
      auth/ tenant/ rbac/ billing/ content/
      agent/ knowledge/ iot/ ops/
packages/
  shared/             # 前后端共享类型与 Zod schema
  ui-tokens/          # 主题与风格库预设数据
docker/
  docker-compose.yml  # postgres / redis / litellm / minio / thingsboard / comfyui
```

### 7.3 核心数据模型（表清单）

租户与权限：`tenants, users, roles, permissions, role_permissions, memberships`
计费：`subscriptions, points_ledger, invoices, model_usage_costs`
Agent：`agents, tools, conversations, messages, agent_runs, tool_calls`
知识库：`knowledge_bases, documents, document_chunks(pgvector)`
业务：`projects, quote_templates, quotes, products, render_jobs, media_assets, publish_orders, fault_reports, support_tickets`
采集后新增（对应 §2.6）：`generation_tasks`（任务球异步队列）、`ip_profiles`（短视频工作台 IP 档案：传记+4×4）、`referrals`（邀请码首充返点）
审计：`audit_logs`

### 7.4 分期路线图（SemVer）

| 版本 | 范围 | 周期目标 |
|---|---|---|
| 0.1.0 | MVP：认证 + 多租户 + RBAC；LiteLLM 接入；AI 生图；文案改写；方案生成（迁移 11 风格库）；知识库上传 + pgvector 检索；点数计费 | 对齐目标系统核心生产链路 |
| 0.2.0 | Agent 工具调用（MCP）；AI 生视频（ComfyUI + Wan2.2）；素材库；任务中心 | 智能体能力落地 |
| 0.3.0 | ThingsBoard IoT；接单工作流；报价系统；客服工单 | 全业务闭环 |
| 0.4.0 | 运营后台（租户/计费/审计）；暗色模式；i18n 英文 | 商用运营就绪 |
| 1.0.0 | 全功能对齐 + 压测 + 安全审计 + 合规上架 | 对外承诺 API 稳定 |

### 7.5 质量与测试策略

- 非平凡逻辑必须有可运行检查：agent 循环、计费扣减、租户隔离（跨租户访问必须返回 404 的测试用例）、RLS 兜底。
- 关键路径冒烟测试：登录 → 生成 → 扣费 → 产物落库。
- 每个迭代版本发布前全量验证，不追求覆盖率数字。

---

## 8. 安全与合规

1. 输入校验：所有外部输入 Zod 校验；输出按上下文转义，防 XSS/注入。
2. 密钥管理：模型 API key、对象存储密钥全部走环境变量/密钥管理，严禁入库、入日志、入代码。
3. 租户隔离：框架层强制 + RLS 兜底 + 跨租户测试用例。
4. 内容合规：LiteLLM Guardrails + 生图生视频审核链路；生成内容留存备查。
5. 许可证合规：已规避 Dify/FastGPT；ComfyUI 以独立进程部署不链接分发代码；新增依赖先查许可证（MIT/Apache-2.0/BSD 优先，GPL/AGPL 禁止引入）与已知漏洞（npm audit / 数据库组件 advisory）。
6. 隐私合规：个人信息最小化收集、脱敏存储、加密传输，符合国内上架要求；海外上线前补 GDPR 评估。
7. 部署：云服务器 + 域名对接（避免迁移导致客户不可用）；本地 EXE 预留 electron/tauri 打包路径，0.x 阶段仅验证服务端容器化部署。

---

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| ComfyUI GPL 边界争议 | 法律风险 | 独立进程部署，不链接分发；法务复核后启用白标 |
| 多模型成本失控 | 毛利侵蚀 | LiteLLM 多窗口预算 + 用量对账 + 缓存 + 降级链 |
| 11 套风格库迁移失真 | 方案质量下降 | 风格先数据化为预设，迁移期双跑对比抽检 |
| 原生 JS 功能遗漏 | 能力不对齐 | 以本文档 2.3 API 地图为验收清单逐项核对 |
| pgvector 性能瓶颈 | 检索变慢 | 预设 RAGFlow 迁移路径，接口层先行抽象 |

---

## 10. 验收清单（与目标系统对齐）

以下为能力对齐的核对基线：

- [ ] 9 大导航模块全部实现且交互一致
- [ ] 约 90 个 API 端点等价覆盖（含异步轮询模型）
- [ ] 幂等提交机制保留（clientRequestId 方案）
- [ ] 会员三档 + 按量计费等价实现
- [ ] 11 套风格库数据化迁移
- [ ] 意图路由升级为 MCP 工具调用（回归用例：原 intent() 覆盖的语句全部可用自然语言完成）
- [ ] 任务球 → 任务中心，交互兼容
- [ ] 多租户 + 五角色 RBAC 全链路生效
- [ ] 全球主流模型（≥5 家）可配置接入与切换
- [ ] 知识库支持检索增强生成
- [ ] 暗色模式 / 英文切换可用

---

## 11. 技术决策确认（2026-09-24 锁定）

| # | 决策点 | 结论 | 影响 |
|---|---|---|---|
| 1 | 内容提取输入源 | 三源全做：用户上传资料、网页抓取、对话纪要抽取 | 管道接口先行，三个适配器分期交付 |
| 2 | 部署形态 | 本地优先，单机 Docker Compose | 基础服务容器化；重服务（LiteLLM/ComfyUI）用 compose profile 按需启动 |
| 3 | token 计费 | 统一 token 单位 + 独立充值 | 会员套餐按 1:1 折算 token 额度；TokenService 事务扣减 |
| 4 | 插件系统 | MVP 仅内置技能/工具注册表（MCP 工具目录） | 第三方运行时留待 0.4.0 之后 |

### 11.1 内容提取系统设计（三源管道）

统一管道接口 `Extractor`：输入 → 标准化文本块 → 字段抽取 → 质量报告。

- P1 上传资料解析：PDF（pdfjs-dist，Apache 2.0）、DOCX（mammoth，MIT）、XLSX（exceljs，MIT）、TXT/MD 原生解析；图片 OCR 在本期后半段以 tesseract.js（Apache 2.0）接入
- P2 网页抓取：URL 校验 + robots.txt 遵守 + 频率限制；正文抽取基于 Readability 算法（@mozilla/readability + jsdom，MIT）
- P3 对话纪要抽取：LiteLLM function calling + Zod schema 结构化输出

质量评估与缺失确认机制：

- 完整性校验：按文档类型定义必需字段集（如产品资料：名称、型号、价格、规格、卖点），缺失产出 deficiency 列表
- 质量评分：字段完整率（主权重）+ 抽取置信度（来源可引用性），归一化为 0-100 分
- 主动确认：deficiency 生成待确认任务（ExtractionReview），前端引导用户补全，确认结果入库回流
- 信任边界：外部文档内容一律视为不可信输入，解析与入库分离，LLM 抽取结果必须通过 Zod 校验后才可入库

数据模型：`extraction_jobs / extracted_documents / extracted_fields / extraction_deficiencies / review_confirmations`
状态机：`pending → extracting → reviewing → confirmed / rejected`

### 11.2 token 计费模型

- 统一计量单位 token：模型调用按 `model_pricing` 表（每千 token 单价）实时折算
- 套餐额度：原三档会员点数数值 1:1 折算为 token 额度（入门 80,000 / 标准 1,600,000 / 企业 30,000,000）
- TokenService：consume/grant 均为数据库事务内扣减，余额不足拒绝；全量写入 `token_ledger` 账本
- 独立充值模块：充值订单 + 账本明细 + 消耗趋势；支付通道 0.2.0 接入，本期提供管理员发放入口

### 11.3 部署与端口规约

- 前端 dev：5173（5174 被其他项目占用，禁止使用）；API：3080（禁止 3081 重复部署）
- Docker Compose 基础服务：PostgreSQL 18 + pgvector、Redis 8；LiteLLM、MinIO 以 compose profile 按需启动，控制常驻内存
- 内存预算：基础服务空闲约 500-800MB，叠加应用进程，保证本地 8GB 机器流畅运行

---

## 12. 开发计划与里程碑（0.1.0）

| Sprint | 范围 | 交付物 | 准出条件 |
|---|---|---|---|
| S1 基础骨架 | monorepo、docker-compose、Prisma schema、认证、租户、RBAC、token 账本、前端框架与主题 | 可注册/登录，token 事务扣减可用，亮暗主题自动跟随 | 构建通过 + 冒烟脚本全绿 |
| S2 内容提取 | 三源管道 P1/P2/P3 + 质量评估 + 缺失确认前端流程 | 上传文档→解析→确认→入库闭环 | 完整性校验用例通过 |
| S3 生成能力 | LiteLLM 接入、AI 生图（ComfyUI profile）、文案、方案生成（11 风格库迁移） | 与目标系统生成链路等价 | 端到端冒烟 |
| S4 知识库与计费 | pgvector 检索、品牌知识库双层隔离、token 中心前端 | RAG 可用、token 中心上线 | 跨租户隔离测试通过 |

质量控制体系：

- 每次提交前：类型检查 + 构建通过；冒烟脚本验证关键路径（health、注册登录、me、token 扣减）
- 非平凡逻辑必须有测试：token 扣减事务、跨租户拦截、幂等提交
- 修复 bug 先写复现用例再修；验证通过后才更新文档与版本号


> **实施迭代记录**
>
> - 0.1.0（2026-09-24）：MVP 骨架，按 §12 S1 范围交付
> - 0.1.1（2026-09-24）：审计项修复 + Docker 部署验证 + pgvector 扩展启用，为 S4 准备
> - 0.1.2（2026-09-24）：平台层 LLM 测试入口（直连 MiniMax，OpenAI 兼容），0.2.0 切 LiteLLM 网关
> - 0.1.3（2026-09-27）：S2 内容提取三源管道（上传/网页/纪要）+ 质量评分 + 缺失确认入库闭环；冒烟 15/15
>   - 详情见 [CHANGELOG.md](./CHANGELOG.md)
> - 0.1.4（2026-10-06）：目标站全量实测采集（13 页面/流程）落盘 `.ref-site/采集记录.md`；§2.4 UI 规范按实测修正、新增 §2.6 复刻差距清单（16 项）；前端复刻第一批交付（白色侧栏+历史内嵌+首页输入卡/5 快捷卡+任务球+¥ 额度胶囊+使用指引+登录协议，差距 ①–⑤⑭⑯），agent-browser 端到端验证通过
> - 0.1.5（2026-10-06）：安装 replica-skill（MIT）按 recon→design→build→diff 重建复刻基线（`replica/` 目录：recon.md 15 屏清单+实测 token、features.csv 50 项矩阵、screens/ 13 页参考截图永久保留）；功能页 UI 层全部交付（智能体市场/生图/生视频/方案 4 步+11 风格/百宝箱 18 工具/知识库/我的资料/素材库/接单向导/短视频工作台/个人中心增强），品牌渐变修正为实测 #5B5BF0→#8E7BF6；后端新增 change-password；MiniMax 真实 key 实测连通（HTTP 201）；replica-diff 功能一致度 84.8/100（must 29/35，剩余 6 项为 S3/0.3.0 生成链路逻辑）
> - 0.1.6（2026-10-06）：生成链路真实接通（MiniMax 代理+产物本地落盘 uploads 卷，MediaAsset 表）——工作台对话（按智能体人设注入 system prompt，¥0.03/次）、AI 生图（image-01，¥3/张）、AI 生视频（T2V-01-Director，¥15/条轮询下载）、素材购买（¥1 幂等）；界面图片 19 张全部本地化（public/images/，无外链）；宽屏响应式改造（去 1400 限制，逐页放宽）；二级功能真实化（百宝箱工具跳转、知识库删除、我的资料展示真实产物、立传接入访谈人设）；文件流 JwtQueryGuard（?token=，img/video 标签场景）；seed 补演示额度 ¥1000；冒烟 19/19；内部浏览器逐屏走查全部功能界面通过（生图/生视频/对话实测出图出片出回复）
> - 0.1.7（2026-10-06）：智能方案生成真实链路（0.1.6 仅 UI 骨架，本轮补齐业务逻辑）——后端 plans 模块：MiniMax-M3 生成 8 页结构化方案（封面+空间+场景+预算，按页扣额，标准 ¥1/页、私宅 ¥1.6/页），PlanProject 表+shareToken；前端 4 步真实流转（生成→逐页审稿编辑版本递增→整册风格主题预览→分享链接交付）；客户分享页 /share/plan/:token 无需登录微信直开，11 套自有风格主题+打印存 PDF；合规约束内置 prompt（价格区间、禁未确认承诺）；修复 PATCH 400（index 误放 body）；冒烟 23/23；浏览器实测"东湖玖章 128㎡"方案全流程通过（-800 正确入账）
> - 0.1.8（2026-10-07）：智能方案交付物升级为**真正的 PPT**（0.1.7 纯文本 HTML 分页不符合"交付客户方案 PPT"预期）——实地登录目标站走通全流程+下载真实 PPTX 解剖核对（目标站=9 页 16:9 每页整页 PNG 拍平）；后端 plans 升级 9 页标准模板（封面/品牌/空间动线/需求洞察/生态规划/场景×2/预算/交付）+每页 narration 讲解稿+keySpaces/needs/pageCount 字段+3 版本；前端 pptxgenjs@4.0.1（MIT）生成**原生可编辑 16:9 幻灯片**（每页 29 文本形状，比目标站拍平 PNG 更优，客户可编辑），讲解稿入 PPT 备注；PlanStudio 步骤3 左页列表+右幻灯片预览、步骤4 下载PPTX/讲稿/全屏播放/分享；分享页改 16:9 幻灯片画布；冒烟 24/24；浏览器实测生成→审稿→下载解剖→分享页全流程通过（-900 入账）
> - 0.1.9（2026-10-07）：修复"PPT 入口不可发现"（用户找不到查看/修改位置，逐项比对目标站截图后确认短板）——侧栏"历史对话"混排方案记录（GET /api/plans，点击直达审稿，⋮ 删除），PlanStudio 支持 ?id= 深链；步骤 2 卡片加 16:9 幻灯片缩略图；PlanSlide 改 cqw 容器查询单位（缩略图/大图/分享页共用）；typecheck+冒烟 24/24+浏览器走查通过。诚实对比：交付能力（可编辑 PPTX/讲稿/分享）优于目标站，预算页视觉密度待 0.2.x
> - 0.1.10（2026-10-07）：智能方案逐页"全面完胜"改造（用户要求消除持平/略逊项，指示联网调研复用成熟库不造轮子）——Context7/PptxGenJS 官方文档调研后复用已装 pptxgenjs@4.0.1 零新依赖：后端 PlanPage 加 quote 引言字段+预算/交付 bullets 结构化约束；预览加预算页横向条形图、交付页 6 阶段流程、全内页引言块；**PPTX 导出 addChart 原生可编辑 clustered 条形图 + chevron 流程形状**（对方整页 PNG 拍平的死穴，形成代差）；实测"光谷国际 140㎡"逐页走查+下载解剖验证（c:barChart 真实数值可编辑、6 chevron、9 notesSlides）；修复预算 8 条溢出/阶段名残留"｜"/悬空冒号/同页切换方案不刷新；9/9 页判定全胜；typecheck+build+冒烟 24/24
> - 0.1.11（2026-10-07）：智能方案幻灯片**全面视觉重设计**（用户批评"无配图、无卡片层次感"，要求按专门 PPT skill 学习落地）——加载 jingmei-ppt skill（foundations/editorial-gallery/pptxgenjs-implementation 三份参考）按"设计系统分层+图片是内容+轮廓变化+垂直节奏"方法论重构，零新增依赖：planThemes 加页型→本地实景图映射+阴影 token+暗图提亮取景函数；PlanSlide 8 类页型独立 composition（每页实景配图+阴影卡+引言块，沉浸图页与分析卡页交替）；planPptx 同构（每页 addImage+shadow 对象，保留原生可编辑 addChart 条形图）；逐页浏览器核对修复品牌/生态/交付卡空带（垂直居中+幽灵序号水印）与 c4 死黑配图（needs→c5、卧室场景→c3）；PPTX 解剖验证 8 页含图（md5 与源图一致）+slide8 图表+各页阴影；分享页同步；typecheck+build+冒烟 24/24。vs 目标站：对方整页 PNG 拍平，我们每页实景配图+阴影层次+全原生可编辑，9/9 双胜
> - 0.1.12（2026-10-07）：修复用户实测发现的 **PPTX 导出图片拉伸变形**（根因：pptxgenjs 浏览器版 sizing:cover 不读原图 intrinsic 尺寸、srcRect 恒 0 等效直接拉伸；此前仅 unzip 结构验证、未做视觉渲染是漏检教训）——planPptx 新增 coverCrop() canvas 按各页图框比例预裁剪（center/焦点），解剖验证 8 页嵌入图宽高比=放置框；LibreOffice headless 逐页渲染核对第 1/2 页内容均在画框内（python-pptx 全形状边界审计 0 越界）；暗图提亮层 transparency 语义修正（0=不透明，20 会刷白→62）；暗金主题 C 双端抽查通过；**jingmei-ppt skill 更新**沉淀"浏览器版 sizing 失效必须 canvas 预裁剪+宽高比解剖验证"与"死黑像素不可提亮救回、换图或焦点裁剪"两条硬经验；typecheck+build+冒烟 24/24。待办：平面图上传+产品图标点位匹配（新功能模块，需先拆解）、逐板块补齐不完整项
> - 0.1.13（2026-10-07）：**智能设备点位布局完整闭环**（补齐百宝箱核心 stub 工具，用户确认数据源=新建 Product 表+种子、范围=编辑器+方案集成）——数据层 Prisma 新增 `Product`（20 条米家生态种子，9 品类含参考价区间）与 `FloorplanLayout`（图纸+归一化 0-1 点位 JSON），`PlanProject` 加 floorplanAssetId/layoutPoints；后端 `/api/products`、`POST /api/media/uploads`（multipart 落盘 uploads 卷）、`/api/layouts` CRUD+summary、`PATCH /api/plans/:id/floorplan` 挂接、公开分享页 `GET :token/floorplan` 免鉴权文件流；前端 `DeviceLayout` 编辑器（原生 pointer 拖拽零新依赖）+`pointOverlay.ts` 共享合成（预览/PNG/PPTX 同一份像素）；方案空间动线页（web+分享页+PPTX 白底竖框 contain 不拉伸）检测到挂接即换"客户户型·设备点位图"，步骤 3 出现布点入口。修复 LayoutModule 未进 @Module imports 导致 /api/products 404（nest build 无报错，靠路由日志排查——教训：新模块必须验证路由注册）。curl 全链路+浏览器+LibreOffice 渲染验证，冒烟 +4 用例 28/28
> - 0.1.14（2026-10-07）：**百宝箱剩余可补齐 stub 真实化**（复用 0.1.13 数据与合成管线，零新增依赖）——`compositeHeatmap()` WiFi 信号热力图（网关点位 additive 径向光斑 红强绿弱+图例）、`compositeLightPlan()` 灯光点位效果图（暖光晕+标签）；`DeviceLayout` 三模式（`?mode=` 直达，产品库按模式过滤）；`QuoteStudio`（`/quote`）智能报价（选品配单+区间算价+CSV 导出含合规说明，纯前端不建表 YAGNI）；百宝箱 wifi-heat/light-plan/quote 三工具从 stub 变真实路由。修复合成图 `toDataURL('image/jpeg')` 写成 `.png` 的扩展名 bug。诚实边界：彩平图/区域效果图受 MiniMax image-01 `subject_reference` 仅支持人像参考的模型限制，保留跳 AI 生图页不造假。浏览器实测三工具+导出文件解剖验证通过，冒烟 28/28
> - 0.1.15（2026-10-07）：**开源就绪整改**（用户要求去品牌商标、去自定定价、全站宽屏响应式、限流/高并发/部署审查、文档体现全部功能）——① 品牌脱敏：侧栏第三方品牌名→"智能家居 AI 工作台"、智能体旧具名→"智居助手"、素材库具名→"演示门店"、接单页与短视频页去第三方品牌字样统一"智居 AI 工作台"、源码注释"复刻目标站/与目标站对齐"中性化；参考站截图目录（`.ref-site/`、`replica/screens/`）与采集记录（含测试凭据）整体 `git rm --cached` 移出跟踪并入 `.gitignore`（本地留存）；`replica/recon.md` 域名/品牌/手机号/备案号通用化。② 收费去自定定价：扣费额度全改 env 驱动（`BILLING_*_TOKENS`，`.env.example` 附开源自配说明），前端移除写死价格（¥0.03/¥3/¥1/套餐价/单价 chip），统一"按额度计费/单价由部署者配置/按部署者定价"，产品硬件参考价保留。③ 工作台重设计：内容区 960px 锁死→流式 `clamp(720px,86%,1380px)`+断点递进，品牌光晕背景，快捷卡 `auto-fit minmax(230px,1fr)` 宽屏 5 列铺满+图标色块+悬浮层次，chip 点击填入。④ 修复 antd 静态 message/Modal 脱离 App 上下文（实测偶发 `e.success is not a function`）：根节点包 `<App>`，11 页+MainLayout 静态方法全迁 `App.useApp()`。⑤ 安全/限流/部署审查：`trust proxy`（反代后按真实 IP 限流）、注册登录加严 `@Throttle 10/min`、生产默认密钥/密码拒绝启动+Swagger 关闭、compose `${VAR:?}` 强制注入、额度事务原子无超扣竞态复核。⑥ README 重写（完整功能地图+开源自部署定位+模型计费配置+安全限流+路线图）。全站浏览器多分辨率实测（16 路由零品牌命中、message/modal 四类正常无报错、宽屏无溢出）+门禁 typecheck/build/冒烟 28/28
> - 0.1.16（2026-10-08）：**全面完整性检查与补齐**（用户要求审计所有功能模块完成度、用 skill/插件补充开发并验证、更新文档、清理无效文件）——Explore 子代理只读审计定位 4 处真实缺口（其余 0.2.0/0.3.0 标记为计划内预留、后端无孤儿模块、TokenLedger userId 记账完整）：① AI 生视频首帧真实化（此前 `beforeUpload={()=>false}` 死功能+死链接）：首帧经 uploads 落盘、`/api/media/videos` 新增 `firstFrameAssetId`（校验前置避免白扣额，读本地文件转 base64 data URL 切 `I2V-01-Director`；WebSearch 核实 MiniMax v1 API 原生支持 first_frame_image、尾帧需 V2/H3 故诚实移除假控件）、"从我的资料选择"真实弹窗、比例参数从硬编码改真实传递；② 使用指引首次登录自动弹一次（localStorage 按用户 id）；③ 我的资料 onError 降级"原文件暂不可用"占位；④ 生图本次会话多图左右翻页；⑤ "我的智能体"真实化（localStorage 持久化自建+人设经 `ChatStore.send` 第三参注入 system prompt、会话续聊沿用人设）。修 3 个实测 bug：Popconfirm portal 事件冒泡误跳转（删除控件移出卡片）、validateFields rejection 未捕获、选填简介 undefined.trim()。清理：删 tokens.ts 三个零引用导出、删过时 S03-home 截图（旧 960px 版已失真，MCP 截图工具无法写工作区暂不重拍）、删空目录 design/；页面 title 与登录页脚统一"智能家居 AI 工作台"。冒烟 +2 用例=30/30，浏览器实测全链路+两轮 bug 复测 console 0 error
> - 0.1.17（2026-10-08）：**模型配置中心**（用户要求"模型测试界面应是模型配置界面，指导完整配置大模型参数，国内外最新大模型+本地模型+ComfyUI 都支持接入，界面要完整"）——① 对话 `LlmService` 从 MiniMax 直连重构为 OpenAI 兼容 provider 抽象（`LLM_BASE_URL/KEY/MODEL`，未设回退 `MiniMax_*` 向后兼容），一套抽象覆盖 DeepSeek/通义千问/智谱/Kimi/OpenAI/MiniMax 云端 + Ollama/LM Studio/vLLM 本地（WebSearch 核实各 provider 最新 base_url/模型名）。② 生图 `IMAGE_PROVIDER=minimax|openai|comfyui` 三路由，新建 `image-provider.ts`：MiniMax image-01 / OpenAI images(gpt-image-1) / 本地 ComfyUI（按官方 Server API `POST /prompt→轮询 /history→/view`，非 txt2img；节点 id 由 `COMFYUI_*_NODE` 配置），内置 `comfyui-workflow.json` SD1.5 模板+compose 只读挂载开箱可用。③ `GET /api/admin/model-config`（super_admin，Key 固定短掩码不回传明文/长度）+`POST test-chat` 连通探测。④ 前端 `ModelConfig` 页替换旧 `ModelTest`：三能力概览卡+连通测试+云端/本地/ComfyUI 三 Tab 引导表格（Base URL/推荐模型/获取 Key 外链/安装启动）+.env 示例一键复制，路由 `/model-config`。修 2 实测 bug：compose 传 `VAR=` 空串使 `config.get(key,default)` 返回空破坏请求（加 `env()` 规范化空串回退默认）、脱敏 Key 121 圆点撑爆 Tag 致横向溢出（改 `••••`+末四位+网格 `minmax(0,1fr)`，三档视口复测无溢出）；删孤儿 `LlmController`/`ModelTest.tsx`。冒烟 +1=31/31，curl+浏览器实测全绿，README 模型章节重写
> - 0.1.18（2026-10-08）：**模型配置在线可编辑**（用户批评 0.1.17 页面"全是固定不可修改、逻辑有问题，右侧超出屏幕"，要求本地/在线模型均可编辑+引导+持久化）——① Prisma 新增 `ModelSetting`（chat/image/video 三条 JSON 行），配置优先级 **DB 在线保存 > .env 部署默认**；新建 `ModelConfigService` 统一解析层，`LlmService`/`MediaService` 生成链路改运行时读取，**保存即生效无需重启**。② API 扩展：`PUT /admin/model-config/{scope}`（Zod 校验；apiKey 留空=保持原 Key、其余空串=清除回退 env）、`DELETE /:scope` 恢复 .env 默认、`POST test-image/test-video` 连通探测（comfyui=/system_stats、openai=/models、minimax=ping）。③ 前端重构为三张可编辑卡片（Base URL/API Key Password 输入仅回显末四位/模型/ComfyUI 地址+工作流+四节点映射），每卡「保存/连通测试/恢复默认」；接入指南表格加「选用」一键预填；页面改纵向卡片流式布局修复右侧溢出。④ Key 只进不出（冒烟断言响应不含明文）。冒烟 +7=38/38，浏览器实测 1440/1920/768 三档无溢出、编辑→保存→刷新持久化→恢复默认全流程通过，console 0 error
> - 0.1.19（2026-10-08）：**生视频 provider 可选 + ComfyUI 配置常驻**（用户批评生视频"直接指向 MiniMax 不可自选"、"ComfyUI 配置在哪里"，要求每个配置核对正确）——① `VIDEO_PROVIDER=minimax|openai` 双路由：新建 `video-provider.ts`（WebSearch 核实 OpenAI Sora 2 videos API `POST /videos→轮询 GET /videos/{id}→GET /videos/{id}/content`，seconds/size 由时长/画质/比例映射），`generateVideo` 按 provider 分发，死代码 `saveRemote` 移除。② 前端生视频卡加 Provider 单选（MiniMax Director/OpenAI Sora）、标题动态显示当前 provider、模型可填（sora-2），连通测试按 provider 探测（openai 走 GET /videos，401/403 判 Key 无效）。③ ComfyUI 配置从"切到 comfyui 才显示"提升为**独立常驻卡片**（地址/工作流/四节点+专属 `test-comfy` 探测 /system_stats），生图卡选 ComfyUI 时出引导提示指向该卡。④ 概览 API 三能力加 `providerKey` 机器键供表单绑定；compose 透传 VIDEO_*。冒烟 +2=40/40，curl 真实 key 验证 test-video/test-image 通过、test-comfy 诚实报未运行，浏览器实测 provider 切换→保存→恢复全流程+三档无溢出+console 0 error
> - 0.1.20（2026-10-08）：**缓存根治 + 默认最高权限 + 个人设置 + 数据备份与磁盘治理**（用户报告 /model-config SyntaxError+ERR_ABORTED、侧栏个人卡需真实化、开源免费使用默认最高权限、数据可备份、限流/磁盘/日志长期稳定、docker 升级不丢数据）——① 根因：发版后浏览器缓存旧 index.html 引用失效 hash chunk，SPA fallback 把 HTML 当 JS 返回→nginx 对 index.html/SPA 回退加 no-store（hash 资源仍 immutable），实测 console 0 error。② 权限匹配开源定位：tenant_admin 补 `platform:billing:manage`（注册即建租户=默认完整配置能力，各人填自己的 key/本地模型），前端按权限动态匹配，viewer 仍 403（RBAC 隔离保留）。③ 侧栏个人卡真实化：头像可点+自定义底色、设置弹完整「个人设置」弹窗（昵称/头像色 ColorPicker/主题三选/修改密码/备份/存储治理，`PATCH /api/auth/profile`+`User.avatarColor` 迁移）、退出 Popconfirm。④ 备份：`GET /api/admin/backup` 全库 18 表 JSON 下载+uploads/backups 留底。⑤ 磁盘：`GET /api/admin/storage` 占用统计（UPLOAD_QUOTA_MB 默认 4096）+`POST storage/cleanup` 清理 30 天前未引用产物（行+文件）；compose json-file 日志轮转 10m×3；限流 env 可配（RATE_LIMIT_GLOBAL 默认 300、RATE_LIMIT_AUTH 10）。冒烟 +6=46/46（含 viewer 403 回归改造），浏览器实测设置弹窗全流程+新注册用户默认可用模型配置+三档无溢出+console 0 error
> - 0.1.21（2026-10-08）：**开始接单板块完整开发**（用户指出该板块"还没有任何开发"，要求联网 GitHub 找匹配方案、对接 agent 协助、补齐不遗漏）——联网调研 Twenty CRM/NextCRM/Headless CRM 的 lead pipeline 模式（同为 NestJS/Prisma/TS 栈），复用自有栈自建不引入框架。① 数据层 OrderRequest（客户/房屋/需求/预算/生态/状态机/挂接 planId/失单原因）+ OrderNote（跟进），migration add_order_requests。② 后端 orders 模块：CRUD + 状态机 TRANSITIONS（new→qualified→proposed→quoted→won，任意非终态可 lost、lost 可重新激活，非法跳跃 400）+ AI intake（粘贴客户原始描述→LlmService.chatObject 抽取结构化字段+推荐品类→按品类查 Product 库取真实候选，解析成功才扣额）+ AI 跟进建议（按状态+需求+最近跟进给下一步话术）。③ 权限 order:manage（tenant_admin/operator 具备）租户隔离，新表纳入备份清单。④ 前端 OrderStudio 从纯 UI 壳重写为真实工作台：左侧接待列表按状态分组、右侧步骤条向导、新接待弹窗 AI 解析建档、跟进 Timeline、AI 建议、方案挂接 Select 复用 /api/plans、失单/重新激活。冒烟 +10=56/56
> - 0.1.22（2026-10-08）：**外部知识库联动（WeKnora / Obsidian）**（用户要求知识库兼容客户本机部署的 Obsidian 或微信开源 WeKnora，性能足够即拉最新仓库自部署，每个板块支持 agent 接口联动、权限合理、操作留痕）——联网学习两引擎接口协议（WeKnora：Tencent/WeKnora，Go，X-API-Key 认证，POST /knowledge-search + GET /knowledge-bases；Obsidian：Local REST API with MCP 插件，Bearer 认证，POST /search/simple + GET /vault/{path}），采用纯 HTTP 适配器接入不引入框架（与 ComfyUI 同模式）。① `knowledge-adapter.ts` 双适配器统一返回 KnowledgeChunk[]，ping 连通探测，formatKnowledgeContext 拼注入上下文（≤5 段/段 1600 字）。② ModelSetting 加 knowledge scope（provider/baseUrl/apiKey/kbIds/enabled），DB>.env、Key 短掩码、保存即生效、恢复默认；compose 加 extra_hosts host.docker.internal:host-gateway 让容器访问宿主机引擎。③ LlmService 加 RagContext，chat/chatObject/chatJson 传入即自动检索注入 system prompt，已接入对话/接单 intake/方案生成三链路，检索失败降级无知识库模式不阻塞主链路。④ /api/knowledge/external（GET/PUT/DELETE/test/search）要求 knowledge:manage 权限租户隔离，每次检索含降级写 AuditLog（action=knowledge.search）。⑤ 前端知识库页加「外部知识库联动」卡（provider 单选+地址+Key+库 id+保存/连通测试/检索演示/恢复默认+启用开关+两引擎部署指引）。修实测反馈：provider 不使用时可保存关闭+恢复默认、检索空提示区分未启用与无命中。协议级 mock 验证双适配器 curl 端到端通过；冒烟 +6=62/62；浏览器实测配置→连通→检索命中→持久化→恢复默认全流程+三档无溢出+console 0 error
