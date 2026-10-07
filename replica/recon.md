# Recon map: 参考站（同类智能家居 AI 工作站，Web SPA）

Scope: 全站功能对标——工作台外壳 + 9 大功能模块 + 接单/短视频工作台 2 个独立子应用 + 个人中心
For: 增强型智能家居 AI SaaS 平台（自有品牌，clean-room 重建功能与交互模式，不取对方代码/素材/文案/商标）
Date: 2026-10-06
方法论: replica-recon skill（.claude/skills/replica-recon）
截图基线: 本地留存（不入库）；文字细节: 本地采集记录（不入库）

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | 自有测试账号 | 参考站（凭据本地留存） | 逐屏实拍 + eval 提取计算样式，核心来源 |
| 2 | 登录页/协议 | 公开页 | 仅参考交互形态 |
| 3 | 使用说明弹窗 | 登录后首屏 | 计费单价与多账号公告的权威文案来源（仅作功能参考，上线前换自有文案） |

## Core loop

一句话需求 → AI 出方案/图/视频/文案 → 产物入"我的资料"可下载复用。用户是智能家居服务商老板/销售，高频场景：工地日常内容化 + 方案报价 + 获客文案。

## Screens

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | 登录页 | 未登录任意路径 | 手机号密码登录+免费注册 | 实景背景、渐变品牌卡、协议勾选、黑色胶囊登录钮 | 默认、协议未勾拦截 |
| S02 | 登录后弹窗序列 | 首次登录 | 计费说明+多账号公告 | 白色大卡、价格双卡、青色提示条、黑色确认钮 | 每浏览器仅弹一次 |
| S03 | 首页工作台 | #/home | 对话入口 | 白色侧栏、渐变新对话钮、短视频工作台钮、分组导航、历史对话列表、个人中心卡、居中头像+Hi 标题、输入卡(4 chip+黑色圆形发送)、5 快捷卡 | 空态(无历史)、有历史、对话态 |
| S04 | 任务球 | 全站右下浮动 | 异步生成任务队列 | 黑色圆球+红点、展开面板(清空已结束/任务列表/查看全部历史) | 收起、展开、0 任务空态 |
| S05 | AI 智能体市场 | 侧栏 AI 智能体 | 选智能体开聊 | 标题+分类 pill 组+标签下拉+排序下拉、5 列卡片网格(封面图+名称+两行描述+热度+启用开关) | 全部/分类筛选、开关两态 |
| S06 | AI 生图 | 侧栏 AI 生图 | 参考图+提示词出效果图 | ①参考图上传(青色高亮框)、提示词 textarea、17 场景 chip(2 行)、②模型下拉、尺寸/质量/格式/背景 4 列、黑色胶囊生成钮、右侧预览卡、底部案例库横滚 | 空预览、引导弹窗 1/4、生成中 |
| S07 | AI 生视频 | 侧栏 AI 生视频 | 首帧图→5/10 秒视频 | ①首帧上传+"从我的资料选"、②尾帧折叠、③预设场景 chip、视频描述 textarea、模型下拉、时长/画质/比例/声音 4 列、右预览 | 空预览、引导弹窗 |
| S08 | 智能方案生成 | 侧栏 智能方案生成 | 4 步向导出方案 | 步骤进度条(当前紫色)、客户资料表单(7 字段+合规提示)、11 风格卡横滚、方案版本、右上 新建/历史/指引 | 步骤1 空表单、待继续状态行 |
| S09 | 智能百宝箱 | 侧栏 智能百宝箱 | 18 专项工具入口 | 4 小节分组、堆叠照片卡(3 张错位+角标"3张配图/人工服务")、标题+一行描述 | 默认网格 |
| S10 | 我的知识库 | 侧栏 我的知识库 | 上传企业资料全局生效 | 启用开关、＋选择文件、上传入库钮、格式说明 | 空列表、已上传 |
| S11 | 我的资料 | 侧栏 我的资料 | 产物库 | 分类 pill(全部/图片/视频/方案/文案)、日期分组、缩略图网格+caption | 空态、过期占位"原文件暂不可用" |
| S12 | 优秀视频素材库 | 侧栏 优秀视频素材库 | UGC 素材市场 | 右上"创作者收益"紫卡、Tab(优秀素材/我的投稿/已购买)、视频卡(封面+AI视频标签+播放钮+标题+描述+品牌+下载数+查看素材/下载1元双钮) | 列表、已购买 |
| S13 | 个人中心 | 侧栏底部 个人中心 | 额度/邀请/改密/退出 | 账号卡(头像+永久会员标+手机/公司/注册日)、我的额度卡(¥大字+总额度+已使用+进度条+4 单价 chip+充值钮)、邀请卡(邀请码紫底+复制链接+统计)、修改密码卡、退出条 | 有会员/无会员、额度 0 |
| S14 | 开始接单 | 侧栏 开始接单 | 销售接待向导(独立整页，替换主框架) | 左窄栏(＋开始新接待+5 步编号列表+历史方案)、右内容区、红色内测告警条 | 空态"暂时无法打开接待工作台"、读取中 |
| S15 | 短视频工作台 | 侧栏顶部渐变钮 | IP 档案访谈式工作站(iframe 子应用) | 居中标题组(专属人物专访/为你立传/副文案)、输入卡(档案名+＋新建)、3 方式 chip、渐变主钮+白底副钮、我的 IP 档案卡(查看/继续+对话记录+删除) | 空档案、已有档案 |

## Flows

```
F01 一句话创作（核心循环）
    S03 输入卡打字 -> 黑色发送钮 -> 对话气泡 -> 产物落 S11 我的资料
    happy path clicks: 2
    edge: 离线演示回复(S3 前)、生成失败、额度不足
F02 方案生成
    S08 填客户资料 -> 选 11 风格之一 -> 逐页审稿 -> 生成校对 -> 交付客户
    clicks: ~8；edge: 必填缺失、版本切换(标准/私宅)
    交付物(0.1.8 实地核对+实现)：**真 .pptx 文件**（9 页 16:9，目标站每页整页 PNG 拍平；我们用 pptxgenjs 生成原生可编辑幻灯片，更优）。
    9 页标准模板=封面/品牌与服务实力/空间动线与智能规划/家庭需求洞察/全屋智能生态规划/核心场景拆解×2/预算规划与性价比/落地交付与售后闭环；
    按页扣额(标准/售前 ¥1/页、私宅 ¥1.6/页)；逐页审稿可编辑标题/正文/讲解稿(版本递增)；
    交付页=下载 PPTX/完整讲稿/全屏播放/复制分享链接；分享链接 /share/plan/:token 无需登录微信直开，16:9 幻灯片画布(讲解稿对客户隐藏)；
    合规：价格一律区间、禁未确认时效/质保承诺
F03 图转视频
    S06 生成图 -> S07 首帧"从我的资料选择" -> 场景 chip 自动填描述 -> 出片
    edge: 无参考图直接生成、尾帧可选
F04 接单接待
    S14 开始新接待 -> 了解客户 -> 补充资料 -> 生成方案 -> 完整编辑 -> 客户方案
    edge: 非管理员账号被拦(当前测试账号即此状态)
F05 IP 工作站
    S15 新建/导入档案 -> 选已有传记 -> STRATEGY 逐问访谈(信息补全) -> 生成工作站方案
    edge: 粘贴正文导入 vs 重新制作、4×4 方案复用
F06 知识库生效
    S10 启用开关+上传文件 -> 入库 -> S05 智能体回答优先参考
F07 素材市场
    S12 浏览优秀素材 -> 下载 1 元(首次支付) -> 入已购买；投稿 -> 审核发布 5 元+被下载 1 元
F08 邀请裂变
    S13 复制邀请链接 -> 好友首充 -> 双方各得 10% 额度
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| 渐变主按钮 | 新对话/短视频工作台/新建档案 | default, hover | S03,S15 |
| 黑色胶囊按钮 | 发送/登录/生成/充值/确认 | default, disabled, loading | S01,S03,S06,S13 |
| 圆形发送钮 | 输入卡内 | default, loading | S03 |
| 功能 chip | 上传附件/图生图/生视频/生方案/场景模式 | default, selected(紫) | S03,S06,S07 |
| 分类 pill | 智能体分类/资料分类/Tab | default, active | S05,S11,S12 |
| 额度胶囊 | 顶栏紫点+¥数字 | 正常 | S03 全站 |
| 任务球 | 收起/展开+红点角标 | 0 任务/进行中/完成未读 | 全站 |
| 智能体卡 | 封面+名称+描述+热度+开关 | 启用/停用 | S05 |
| 工具卡(堆叠图) | 3 图错位+角标 | default, hover | S09 |
| 方案风格卡 | 缩略图+名称+描述 | default, selected | S08 |
| 素材视频卡 | 封面+AI标签+播放钮+双按钮 | 未购买/已购买 | S12 |
| 步骤进度条 | 编号圆+连线+当前高亮 | done/current/todo | S08,S14 |
| 弹窗序列 | 使用说明/公告 | 每浏览器一次 | S02 |
| 引导分步弹窗 | 1/4、1/5 步骤 | 跳过/下一步 | S06,S08 |
| 历史对话项 | 标题+智能体·时间+操作菜单 | default, active, hover菜单 | S03 |
| 个人中心卡(侧栏底) | 头像+名称+额度/设置/退出 | 会员/非会员 | S03 |

## Inferred data model

```
Tenant     id, name, quota_balance(int token), quota_total, plan(永久/订阅), created_at
           evidence: S13 公司名+总额度+已使用；confidence: high
User       id, phone(脱敏显示), display_name, avatar, tenant_id, role, member_since
           evidence: S13 账号卡；confidence: high
Agent      id, name, category(视频脚本/朋友圈文案/直播文案/品牌传播/经营诊断/活动策划/通用助手), cover_url,
           description, usage_count, enabled_by_default, owner(user|platform), system_prompt
           evidence: S05 卡片+分类 pill+热度+开关；confidence: high
Conversation id, user_id, agent_id, title, updated_at, messages[]
           evidence: S03 历史对话"智能体名 · MM/DD HH:mm"；confidence: high
Message    id, role(user|assistant), content, attachments[], created_at
           evidence: S03 对话态；confidence: high
GenerationTask id, type(image|video|plan|copy|avatar), status(running|done|failed), title,
               result_asset_id, created_at, finished_at
           evidence: S04 任务球"生成会在后台继续，完成后亮红点"；confidence: high
MediaAsset id, tenant_id, kind(image|video|plan|copy), title, url, expires_at, created_at
           evidence: S11 日期分组+过期占位；confidence: high
KnowledgeDoc id, tenant_id, filename, chars, enabled, uploaded_at
           evidence: S10 上传+开关+8 万字上限；confidence: high
PlanProject id, tenant_id, customer_name, address, area, budget, ecosystem, store_brand,
            service_highlights, style(A-K 11 套), version(标准|私宅), step(1-4), copy_version,
            pages[], share_url
            evidence: S08 表单字段+风格卡+步骤条；confidence: high
IpProfile  id, user_id, biography(text|doc_ref), four_by_four(text), workstation_plan, updated_at
           evidence: S15 档案卡"工作站访谈中"；confidence: medium
Material   id, creator_id, title, cover, video_url, price(1元), downloads, status(审核中/已发布)
           evidence: S12 下载1元+收益5元+1元；confidence: high
QuotaLedger id, tenant_id, delta, reason(GRANT|CONSUME|RECHARGE|REFUND|INVITE), ref, created_at
           evidence: S13 总额度/已使用+单价 chip；confidence: high
Referral   id, inviter_id, invitee_id, code(6位), first_recharge_pct(10%), payout, created_at
           evidence: S13 邀请码+返点统计；confidence: high
OrderSession id, tenant_id, customer_info, stage(1-5), plan_project_id
           evidence: S14 5 步列表+历史方案；confidence: medium
```

Relationships: Tenant 1-n User；User 1-n Conversation 1-n Message；Agent 1-n Conversation；Tenant 1-n MediaAsset/KnowledgeDoc/PlanProject/QuotaLedger；User 1-n IpProfile；User 1-n Material(投稿)；Tenant 1-n Referral

## Feature matrix

见 `replica/features.csv`。must: 34, should: 18, could: 9, skip: 5。

## Out of scope（不可/不应复刻）

- skip | 对方真实素材内容（案例库图片、预置智能体文案、传记正文） | 对方拥有内容，自有数据替代
- skip | 对方 logo/商标/名称 | 商标，replica-brand 换自有品牌
- skip | 对方登录页实景照片 | 版权素材，自有图或程序化背景
- skip | 对方私有 API 端点与 JS 源码 | clean-room 规则，仅复刻行为
- skip | 具名个人 IP 智能体 | 具名个人 IP，用同类通用智能体替代

## Size

Screens 15, flows 8, entities 13。Hard parts: 异步任务队列+红点、方案 4 步向导+11 风格、图→视频首帧联动、知识库全局生效、UGC 素材市场、邀请返点。Size: **L**（按 Sprint 拆：S3 生成链路 → 0.2.0 智能体/资料/任务后端 → 0.3.0 接单/IP工作站）。

## 下一步

/replica-design（tokens 已部分实测，见下）→ /replica-build 逐屏补齐 → /replica-diff 打分。

## 实测设计 token（replica-design Step1 素材，来自 eval getComputedStyle）

- 页面底色 `rgb(247,248,249)` #F7F8F9；表面白 #FFFFFF；边框 #ECECEC/#EAECF0；正文 #191919；次要文字 #6B6F76/#686F7B；标题深色 #20252F
- 品牌渐变 `linear-gradient(135deg, #5B5BF0, #8E7BF6)`（新对话/短视频工作台/主 CTA；此前实现误用 #7C5CFC→#5B3FD6，需改）
- 青色强调（使用指引/引导下一步）`rgb(77,212,212)` #4DD4D4，阴影 `0 6px 20px rgba(77,212,212,.45)`
- 黑色胶囊/圆球 #191919，圆角 9999px；任务球 44px、阴影 `0 4px 14px rgba(0,0,0,.16)`
- 侧栏宽 300px、padding 16px 14px；输入卡 max-w 960px、圆角 22px、padding 20px 28px、阴影 `0 1px 2px rgba(17,17,26,.04), 0 6px 20px rgba(17,17,26,.06)`
- chip：高 36-40px、圆角 9999px、bg #FAFBFC、边框 #ECECEC、文字 #6B6F76、字重 600/700
- 快捷卡：224x151、圆角 16px、padding 30px 18px、边框 #ECECEC
- 智能体卡：296x343、圆角 16px、封面 294x165、边框 #EAECF0
- 字阶：H1 40/700、副标题 17/400、页标题 21/700、正文 16、chip/描述 14
- 间距基线 4/8；圆角档位 10/12/16/22/9999
