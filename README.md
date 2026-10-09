# 智能家居 AI 工作台

面向智能家居服务商（门店老板、销售、设计师）的多租户 AI SaaS：一句话出方案 / 出图 / 出视频 / 出文案，交付可编辑 PPT，支持户型图布点与智能报价。

**开源自部署定位**：本项目让每个人都能在自己电脑上跑起来"自己玩"。模型由你自选——本地跑 ComfyUI / Ollama 等（配 config UI）或接任意 OpenAI 兼容的云端大模型 API；平台**不预设任何商业定价**，所有"额度扣费"单价由部署者按自己的模型成本通过环境变量配置（见下文「模型与计费配置」）。

规划背景与逐版本技术决策见 [增强型智能家居AI-SaaS平台规划文档.md](./增强型智能家居AI-SaaS平台规划文档.md)。

## 技术栈

- 后端：NestJS 12（ESM）+ Prisma 7 + PostgreSQL 18（pgvector）+ Redis
- 前端：React 19 + Ant Design 6 + Vite 8
- 模型接入：对话走 OpenAI 兼容协议（可接任意国内外云端或本地 Ollama/LM Studio/vLLM）；生图支持 MiniMax / OpenAI / 本地 ComfyUI；生视频支持 MiniMax Director / OpenAI Sora；前端「模型配置」页**在线编辑、保存即生效**（DB 持久化，优先于 .env），含 provider 引导与连通性测试
- PPT 生成：pptxgenjs（MIT，浏览器端生成原生可编辑 16:9 幻灯片）

## 功能地图

### 账户与多租户
- 手机号注册 / 登录（用户协议与隐私政策勾选拦截）、注册即建租户并赠送演示额度
- 多租户隔离、RBAC 角色权限（超管 / 租户管理员 / 设计师 / 运营 / 只读）；**开源自部署默认最高权限**——注册用户即租户管理员，默认可完整配置模型（各人填自己的 API Key / 本地模型），会员与角色分级机制保留
- 统一 token 额度账本（发放 / 消耗 / 充值 / 退还 / 邀请流水）、个人中心（额度总览、邀请码与返点说明、修改密码、退出）
- **个人中心统一承载设置**（侧栏「设置」直达 /tokens，无独立弹窗）：资料与偏好（昵称 / 头像底色 / 主题亮暗跟随系统）+ 数据备份与存储治理（全库 JSON 备份导出 / 产物占用统计 / 过期未引用产物清理）
- 亮色 / 暗色 / 跟随系统三态主题，全站持久化

### 工作台（首页）
- 居中欢迎区 + 大输入卡（附件 / 图生图 / 生视频 / 生方案功能 chip）+ 5 张快捷卡（方案 / 海报 / 视频 / 文案仿写 / 找智能体）
- 历史对话与智能方案记录混排于侧栏，点击直达对应审稿 / 会话
- 右下浮动任务球：异步生成任务队列、完成红点提醒、可拖拽

### AI 生成链路（真实接通，按额度扣费）
- 对话：按所选智能体人设注入 system prompt
- 生图：文生图，产物本地落盘 uploads 卷并入「我的资料」；本次会话多图可左右翻页回看
- 生视频：上传首帧图（或从「我的资料」选择）做图生视频，也可纯文字描述生成；时长/画质/比例可调
- 智能方案：LLM 生成 9 页标准方案（封面 / 品牌实力 / 空间动线 / 需求洞察 / 生态规划 / 场景×2 / 预算 / 交付），逐页审稿编辑（版本递增）+ 每页讲解稿，**交付真 .pptx（文本 / 图表 / 形状全部原生可编辑）** + 完整讲稿 + 全屏播放 + 免登录分享链接（客户微信直开）；幻灯片按 jingmei-ppt 方法论设计，8 类页型独立构图 + 每页实景配图 + 阴影卡片层次 + 预算原生可编辑条形图 + 交付流程形状

### 智能体市场
- 12 个预置智能体（通用助手 / 视频脚本 / 朋友圈文案 / 直播逐字稿 / 投流文案 / 品宣优化 / 经营诊断 / 活动策划 / 小红书图文等），分类筛选、按热度 / 名称排序、启用开关
- **我的智能体**：自建智能体（名称 + 人设提示词），本地持久化，点击即以该人设开聊

### 智能百宝箱（工具集）
- **产品中心**：公共产品库（20 种设备种子）+ 我的产品库双 tab，搜索 / 分类筛选、新增 / 编辑 / 删除（仅我的库）、公共库一键**复制到我的库**；产品可上传主图，**产品图即点位图标**（有图点位显示产品照片、无图回退品类 SVG 图标），报价 / 点位 / 方案选品全联动
- **智能设备点位布局**：上传户型图 → 一键**美化图纸**（白底增强，保持真实户型不变）→ 从产品库（公共 + 我的合并，9 品类**各配 SVG 图标**）点选布点 → 拖拽微调 → 导出标注图纸 PNG + 设备清单 CSV → 挂接方案空间动线页（预览 / PNG / PPTX / 分享页四端同一份合成像素，**点位为产品照片或品类图标徽章**）
- 三模式编辑器：设备点位 / **灯光点位效果图**（暖光光晕 + 图标）/ **WiFi 信号热力图**（网关为热源，红强绿弱叠加 + 图例）
- **智能报价**：产品库选品配单、数量步进、参考价区间实时算价、导出报价单 CSV（含"实际以门店方案师现场确认为准"合规说明）
- 其余工具卡路由到对应能力或标注人工服务

### 内容与资料
- 三源内容提取管道：文档上传（PDF / Word / 文本）/ 网页 URL / 语音纪要 → 结构化字段抽取 → 人工确认入库
- 我的知识库：上传企业资料、启用开关（供智能体优先参考）；**外部知识库联动**——客户本机部署 [WeKnora](https://github.com/Tencent/WeKnora)（腾讯开源 RAG 引擎）或 Obsidian（Local REST API 插件）后，平台经 REST 实时检索，让对话 / 接单 / 方案生成等所有板块的 AI 优先参考你的资料（在线配置、连通测试、检索演示、权限隔离与审计留痕）
- 我的资料：按分类（图片 / 视频 / 方案 / 文案）与日期分组的产物库，可下载复用；文件缺失自动降级"原文件暂不可用"占位
- 素材库：优秀素材浏览、购买 / 下载、我的投稿
- 首次登录自动弹出使用说明（每用户仅一次，顶栏可随时再看）

### 接单工作台（AI 接待）
- 粘贴客户微信原话 / 电话纪要，AI 自动解析建档（客户 / 小区 / 面积 / 预算 / 生态 / 需求要点）并按需求从产品库推荐关注品类与候选设备
- 状态机推进：了解客户 → 需求确认 → 方案匹配（可挂接已生成的智能方案）→ 报价 → 成单 / 失单（可重新激活），非法跳跃被拒绝
- 跟进记录时间线 + AI 跟进建议（下一步动作与话术要点），接待列表按状态分组持久化

### 其他
- 短视频工作台（IP 档案访谈式）、使用指引弹窗
- 全站宽屏响应式（自适应 768 / 1280 / 1920 / 2560+，内容流式宽度 + 网格 auto-fit）；界面图片资产本地化，无外部链接依赖

## 快速开始

```bash
cp .env.example .env          # 填入你的模型 key 与密钥（见下）
docker compose up -d db redis # 或使用本机 postgres/redis
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev                      # web 5173 + api 3080
pnpm build && pnpm smoke      # 冒烟基于编译产物
```

一键容器部署（含自动 migrate + 幂等 seed）：

```bash
docker compose up -d --build  # web 5173、api 3080
```

## 模型与计费配置

登录后侧栏「系统管理 → 模型配置」页可**在线完成全部模型配置**：对话 / 生图 / ComfyUI / 生视频四张可编辑卡片（Base URL、API Key、模型、provider 选择、ComfyUI 地址与工作流节点映射），保存即生效、持久化到数据库（无需重启）；「选用」按钮一键填入 DeepSeek / 通义千问 / 智谱 / Kimi / OpenAI / MiniMax / Ollama / LM Studio / vLLM 的推荐地址与模型；每卡带连通性测试与「恢复 .env 默认」。API Key 保存后只回显末四位，绝不外传明文。

`.env` 仅作为**部署默认值**（DB 未配置或点「恢复 .env 默认」时生效）：

```bash
# —— 对话：OpenAI 兼容协议，接任意国内外云端或本地模型 ——
# 不设置 LLM_* 时回退 MiniMax_*（向后兼容）
LLM_BASE_URL=https://api.deepseek.com          # 或 https://dashscope.aliyuncs.com/compatible-mode/v1、智谱、Kimi、OpenAI、http://localhost:11434/v1(Ollama) …
LLM_API_KEY=你的key                              # 本地 Ollama/LM Studio 填任意占位串
LLM_MODEL=deepseek-chat                          # 可选：锁定模型；留空跟随请求
MiniMax_BASE_URL=https://api.minimaxi.com/v1     # 默认 provider（LLM_* 未设时生效）
MiniMax_API_KEY=你的key

# —— 生图：minimax(默认) | openai | comfyui(本地) ——
IMAGE_PROVIDER=comfyui
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW_PATH=./comfyui-workflow.json    # 项目内置 SD1.5 模板，可换成自己导出的工作流

# —— 生视频：VIDEO_PROVIDER=minimax(T2V/I2V-01-Director，默认) | openai(Sora 2 videos API) ——

# 扣费额度（token 记账单位，100 token = ¥1 仅为展示层口径）——按你的模型成本自行设定，平台不预设商业价格
BILLING_CHAT_TOKENS=3
BILLING_IMAGE_TOKENS=300
BILLING_VIDEO_TOKENS=1500
BILLING_PLAN_TOKENS=100
BILLING_PLAN_PRIVATE_TOKENS=160

# 生产必设（compose 已强制校验，拒绝默认值启动）
JWT_SECRET=（openssl rand -hex 32 生成）
SEED_ADMIN_PASSWORD=（自定义强密码）
```

改完 `.env` 重启后端生效（`docker compose up -d api`）；页面上的在线配置则保存即生效。未配置模型 key 时，对话链路降级为离线说明、生图 / 生视频返回 503 提示，不阻塞其他功能。ComfyUI 接入需本机启动 ComfyUI 并在 `Workflow → Export (API)` 导出工作流 JSON（或直接使用项目内置模板）。

## 知识库联动：优势与场景

客户电脑性能足够时，可拉取最新仓库自行部署专业知识库引擎（[WeKnora](https://github.com/Tencent/WeKnora)：git clone → docker compose up -d；Obsidian：安装 Local REST API 插件），在「我的知识库」页填地址与 Key 即可联动。相比平台内置的轻量资料库，外部引擎带来：

- **更强的检索**：WeKnora 提供向量 + BM25 混合检索、GraphRAG、多文档格式解析（PDF/Word/Excel/图片 OCR），Obsidian 直读你的全部笔记库——资料规模越大、格式越杂，优势越明显
- **对话更准**：工作台对话自动检索客户私有资料注入上下文，回答引用你的产品手册与话术，而非通用模型泛泛而谈
- **接单更懂行**：AI 解析客户描述时能命中你资料库中的品牌、型号与报价规则，建档即带业务口径
- **方案更贴牌**：智能方案生成参考你的案例库与风格话术，交付文案自带品牌调性
- **数据主权 + 零锁定**：知识只存在客户自己的引擎里，平台仅经 REST 实时检索、不落副本；检索失败自动降级为无知识库模式，绝不阻塞主链路；每次检索写审计日志（场景 + 命中数），权限按租户与角色隔离

## 安全、限流与数据治理

- 限流 env 可配：全局 `RATE_LIMIT_GLOBAL`（默认 300/分钟/IP）、注册 / 登录 `RATE_LIMIT_AUTH`（默认 10/分钟，防暴力破解）
- `trust proxy` 已开启，nginx 反代后限流按真实客户端 IP 计数
- 生产环境（`NODE_ENV=production`）：默认 JWT 密钥 / 默认管理员密码启动直接拒绝；Swagger 文档关闭
- 额度扣减在数据库事务内原子完成（`updateMany` 余额条件 + 账本写入），并发无超扣竞态
- 文件流路径穿越防护、上传 MIME + 大小校验、多租户资源隔离、密钥仅经环境变量注入不入库
- **数据备份**：个人设置「导出全库数据备份」→ `GET /api/admin/backup` 导出全部 18 表 JSON（同时在 `uploads/backups/` 留底）；产物文件在 `api-uploads` 卷、数据库在 `pgdata` 卷，迁移时连同两个 docker volume 一起备份即可完整恢复
- **磁盘治理**：`docker-compose` 已配 json-file 日志轮转（10MB×3）防日志挤爆磁盘；产物配额 `UPLOAD_QUOTA_MB`（默认 4096），个人设置可查看占用并一键清理 30 天前且未被方案/布局引用的过期产物
- **升级不丢数据**：数据全在 `pgdata` / `api-uploads` 两个命名卷，`docker compose up -d --build` 重建镜像不影响卷；nginx 对 `index.html` 禁缓存（hash 资源 immutable），发版后浏览器不会加载到失效 chunk

## 端口规约

| 服务 | 端口 | 说明 |
|---|---|---|
| web | 5173 | dev 与容器映射一致；5174 禁用 |
| api | 3080 | 3081 禁用 |
| postgres | 5432 | compose 基础服务 |
| redis | 6379 | compose 基础服务 |

## 目录结构

```
apps/
  api/    NestJS 12：auth / tenants / rbac / billing / content / llm / media / plans / layout / admin(备份与存储治理) / health
  web/    React 19 SPA：theme / layouts / pages / lib（api、合成、PPTX 生成）
docker-compose.yml
replica/  功能对标基线（recon.md、features.csv、自有实现截图 clone-screens/、布局比对 diffs/）
```

对标参考素材（含第三方品牌 UI）仅本地留存、不入库，遵循 clean-room 原则：只重建功能与交互模式，不取对方代码 / 素材 / 文案 / 商标。

## 开发规范

- 回复与注释使用中文，不使用 emoji
- 决策阶梯：YAGNI → 复用 → 标准库 → 原生 → 已装依赖 → 一行 → 最少实现
- 提交前必须：`pnpm typecheck && pnpm build && pnpm smoke` 全绿
- 新增依赖需许可证检查（MIT / Apache-2.0 / BSD 优先，禁止 GPL / AGPL）

## 路线图（未交付，诚实标注）

- LiteLLM 网关统一路由（当前默认直连）、方案配图渲染、尾帧控制（MiniMax v1 API 仅支持首帧，尾帧需 V2/H3 模型）
- pgvector 知识库 RAG 检索、品牌知识库双层隔离
- 智能体后端表（自建智能体当前为本地持久化，0.2.0 接入服务端）、邀请返点自动结算
- 接单接待业务逻辑、IoT 联动、客服工单
- 运营后台、英文 i18n
- 多端打包本地安装（Electron / Tauri 桌面壳复用现有 Web 产物，升级不影响 pgdata / api-uploads 卷数据）
