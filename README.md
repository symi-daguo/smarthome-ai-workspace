# 智能家居 AI 工作台

面向智能家居服务商（门店老板、销售、设计师）的多租户 AI SaaS：一句话出方案 / 出图 / 出视频 / 出文案，交付可编辑 PPT，支持户型图布点与智能报价。

**开源自部署定位**：本项目让每个人都能在自己电脑上跑起来"自己玩"。模型由你自选——本地跑 ComfyUI / Ollama 等（配 config UI）或接任意 OpenAI 兼容的云端大模型 API；平台**不预设任何商业定价**，所有"额度扣费"单价由部署者按自己的模型成本通过环境变量配置（见下文「模型与计费配置」）。

规划背景与逐版本技术决策见 [增强型智能家居AI-SaaS平台规划文档.md](./增强型智能家居AI-SaaS平台规划文档.md)。

## 技术栈

- 后端：NestJS 12（ESM）+ Prisma 7 + PostgreSQL 18（pgvector）+ Redis
- 前端：React 19 + Ant Design 6 + Vite 8
- 模型接入：默认直连 MiniMax（OpenAI 兼容协议），可切换 LiteLLM 网关（compose profile 按需启动）接任意上游
- PPT 生成：pptxgenjs（MIT，浏览器端生成原生可编辑 16:9 幻灯片）

## 功能地图

### 账户与多租户
- 手机号注册 / 登录（用户协议与隐私政策勾选拦截）、注册即建租户并赠送演示额度
- 多租户隔离、RBAC 角色权限（超管 / 租户管理员 / 设计师 / 运营 / 只读）
- 统一 token 额度账本（发放 / 消耗 / 充值 / 退还 / 邀请流水）、个人中心（额度总览、邀请码与返点说明、修改密码、退出）
- 亮色 / 暗色 / 跟随系统三态主题，全站持久化

### 工作台（首页）
- 居中欢迎区 + 大输入卡（附件 / 图生图 / 生视频 / 生方案功能 chip）+ 5 张快捷卡（方案 / 海报 / 视频 / 文案仿写 / 找智能体）
- 历史对话与智能方案记录混排于侧栏，点击直达对应审稿 / 会话
- 右下浮动任务球：异步生成任务队列、完成红点提醒、可拖拽

### AI 生成链路（真实接通，按额度扣费）
- 对话：按所选智能体人设注入 system prompt
- 生图：文生图，产物本地落盘 uploads 卷并入「我的资料」
- 生视频：首帧 / 描述驱动，轮询取回 mp4
- 智能方案：LLM 生成 9 页标准方案（封面 / 品牌实力 / 空间动线 / 需求洞察 / 生态规划 / 场景×2 / 预算 / 交付），逐页审稿编辑（版本递增）+ 每页讲解稿，**交付真 .pptx（文本 / 图表 / 形状全部原生可编辑）** + 完整讲稿 + 全屏播放 + 免登录分享链接（客户微信直开）；幻灯片按 jingmei-ppt 方法论设计，8 类页型独立构图 + 每页实景配图 + 阴影卡片层次 + 预算原生可编辑条形图 + 交付流程形状

### 智能体市场
- 12 个预置智能体（通用助手 / 视频脚本 / 朋友圈文案 / 直播逐字稿 / 投流文案 / 品宣优化 / 经营诊断 / 活动策划 / 小红书图文等），分类筛选、按热度 / 名称排序、启用开关

### 智能百宝箱（工具集）
- **智能设备点位布局**：上传户型图 → 从产品库（20 种米家生态设备，9 品类）点选布点 → 拖拽微调 → 导出标注图纸 PNG + 设备清单 CSV → 挂接方案空间动线页（预览 / PNG / PPTX 三端同一份合成像素）
- 三模式编辑器：设备点位 / **灯光点位效果图**（暖光光晕 + 标签）/ **WiFi 信号热力图**（网关为热源，红强绿弱叠加 + 图例）
- **智能报价**：产品库选品配单、数量步进、参考价区间实时算价、导出报价单 CSV（含"实际以门店方案师现场确认为准"合规说明）
- 其余工具卡路由到对应能力或标注人工服务

### 内容与资料
- 三源内容提取管道：文档上传（PDF / Word / 文本）/ 网页 URL / 语音纪要 → 结构化字段抽取 → 人工确认入库
- 我的知识库：上传企业资料、启用开关（供智能体优先参考）
- 我的资料：按分类（图片 / 视频 / 方案 / 文案）与日期分组的产物库，可下载复用
- 素材库：优秀素材浏览、购买 / 下载、我的投稿

### 其他
- 接单向导（销售接待 5 步）、短视频工作台（IP 档案访谈式）、使用指引弹窗
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

`.env` 关键项：

```bash
# 模型上游：默认 MiniMax；换成任意 OpenAI 兼容端点（含本地网关）改 BASE_URL 即可
MiniMax_BASE_URL=https://api.minimaxi.com/v1
MiniMax_API_KEY=你的key
# 或启用 LiteLLM 网关统一路由：docker compose --profile gateway up -d

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

未配置模型 key 时，对话链路降级为离线说明、生图 / 生视频返回 503 提示，不阻塞其他功能。

## 安全与限流

- 全局限流 120 请求/分钟/IP；注册 / 登录加严至 10 次/分钟（防暴力破解）
- `trust proxy` 已开启，nginx 反代后限流按真实客户端 IP 计数
- 生产环境（`NODE_ENV=production`）：默认 JWT 密钥 / 默认管理员密码启动直接拒绝；Swagger 文档关闭
- 额度扣减在数据库事务内原子完成（`updateMany` 余额条件 + 账本写入），并发无超扣竞态
- 文件流路径穿越防护、上传 MIME + 大小校验、多租户资源隔离、密钥仅经环境变量注入不入库

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
  api/    NestJS 12：auth / tenants / rbac / billing / content / llm / media / plans / layout / health
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

- LiteLLM 网关统一路由（当前默认直连）、方案配图渲染与图生视频
- pgvector 知识库 RAG 检索、品牌知识库双层隔离
- 智能体后端表（当前前端种子）、邀请返点自动结算
- 接单接待业务逻辑、IoT 联动、客服工单
- 运营后台、英文 i18n
