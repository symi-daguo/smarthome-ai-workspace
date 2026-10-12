/** 智能体种子数据（前端展示层；后端 agents 表 0.2.0 接入后替换为 API） */
export interface AgentDef {
  key: string;
  name: string;
  category: string;
  description: string;
  usage: number;
  enabled: boolean;
  tone: string;
  /** 本地封面图（public/images/agents/） */
  cover: string;
  /** 点击卡片进入工作台时自动带入的首条任务提示词（用户可直接发送或改后发送） */
  starterPrompt: string;
}

export const AGENT_CATEGORIES = [
  '全部', '视频脚本', '朋友圈文案', '直播文案', '品牌传播', '经营诊断', '活动策划', '通用助手', '我的智能体',
];

export const SEED_AGENTS: AgentDef[] = [
  { key: 'a1', name: '智居助手 · 通用对话', category: '通用助手', description: '什么都能问的智能家居全能助手，方案、报价、话术随你发挥', usage: 1020, enabled: true, tone: '#F3F0FF', cover: '/images/agents/a1.jpg', starterPrompt: '我是做智能家居全屋定制的门店，客户是 140㎡ 三室两厅、家里有老人和小孩。请先问我 3 个最关键的问题（预算/风格/已有设备），再帮我梳理一套方案沟通思路。' },
  { key: 'a2', name: '智能家居短视频脚本', category: '视频脚本', description: '工地实拍、产品演示、案例故事，一键生成可拍摄的分镜脚本', usage: 900, enabled: true, tone: '#EFF6FF', cover: '/images/agents/a2.jpg', starterPrompt: '帮我写一条 30 秒的智能家居工地实拍短视频分镜脚本：主题是「三室两厅全屋智能调试完成当天」，要包含 6-8 个镜头、每个镜头的画面内容/时长/口播文案，结尾引导到店体验。' },
  { key: 'a3', name: '朋友圈文案', category: '朋友圈文案', description: '交工、签单、工地日常，配上定位和九宫格就能直接发', usage: 396, enabled: true, tone: '#F0FDF4', cover: '/images/agents/a3.jpg', starterPrompt: '今天交工了一套 128㎡ 的三室两厅全屋智能，客户最满意起夜灯光和观影模式。帮我写 3 条不同风格的朋友圈文案（温馨/专业/俏皮），每条 80 字内，带上九宫格配图建议。' },
  { key: 'a4', name: '直播逐字稿', category: '直播文案', description: '套餐讲解、互动话术、逼单节奏，开播前给你一份完整逐字稿', usage: 49, enabled: false, tone: '#FFF7ED', cover: '/images/agents/a4.jpg', starterPrompt: '我今晚要开一场 1 小时的智能家居直播，主推 9999 元两室一厅套餐。请给我一份分段逐字稿：开场留人 5 分钟、套餐讲解 20 分钟、互动答疑 20 分钟、逼单收尾 15 分钟，每段写清口播原话。' },
  { key: 'a5', name: '本地推投流文案', category: '品牌传播', description: '按城市+门店+服务区域模板化产出投流素材，覆盖同城获客', usage: 156, enabled: true, tone: '#FDF2F8', cover: '/images/agents/a5.jpg', starterPrompt: '我在武汉光谷开智能家居体验店，服务覆盖光谷和江夏。帮我写 3 条抖音本地推投流文案（每条 50 字内 + 一句钩子 + 行动指令），主题分别是免费方案设计、老房智能化改造、别墅全屋定制。' },
  { key: 'a6', name: 'GEO 品宣优化', category: '品牌传播', description: '优化品牌词与地域词布局，让本地客户搜得到你', usage: 187, enabled: false, tone: '#F5F3FF', cover: '/images/agents/a6.jpg', starterPrompt: '我门店在武汉做智能家居，想让客户搜「武汉全屋智能」「光谷智能家居体验店」时能看到我们。请给我一份 GEO 优化清单：要布局的关键词、内容平台、每类内容的标题模板，按优先级排。' },
  { key: 'a7', name: '经营问题诊断', category: '经营诊断', description: '获客、转化、交付哪个环节卡住了，帮你拆问题给建议', usage: 345, enabled: true, tone: '#ECFEFF', cover: '/images/agents/a7.jpg', starterPrompt: '我门店每月到店咨询约 40 组，但成交只有 3-4 单，客单价 2-3 万。请按获客→到店→方案→报价→成交的漏斗帮我诊断最可能的 3 个漏点，并给出本周可执行的改进动作。' },
  { key: 'a8', name: '短视频开头优化', category: '视频脚本', description: '前 3 秒决定完播率，给你多版开头钩子对比挑选', usage: 42, enabled: false, tone: '#FEFCE8', cover: '/images/agents/a8.jpg', starterPrompt: '我要拍一条「智能门锁值不值得装」的科普视频。请给我 5 个不同类型的前 3 秒开头钩子（反常识/痛点/数字/提问/对比），每个不超过 25 字，并说明各自适合的人群。' },
  { key: 'a9', name: 'vlog 脚本大师', category: '视频脚本', description: '把一天的工地日常拍成有故事线的 vlog 脚本', usage: 6, enabled: false, tone: '#F0F9FF', cover: '/images/agents/a9.jpg', starterPrompt: '帮我把今天的工作排成一条 60 秒 vlog：上午工地布线、中午回店接待客户、下午调试智能灯光、晚上交工。要有开头钩子、时间线转场、结尾升华，给出配乐风格建议。' },
  { key: 'a10', name: '第一视角脚本', category: '视频脚本', description: '沉浸式第一视角安装、演示视频脚本，代入感拉满', usage: 11, enabled: false, tone: '#FAF5FF', cover: '/images/agents/a10.jpg', starterPrompt: '写一条第一视角（FPV）沉浸式安装智能开关的 20 秒短视频脚本：从开箱、断电、接线、通电到 App 配网演示，标注每个动作的镜头运动和音效，要求有 ASMR 质感。' },
  { key: 'a11', name: '活动策划大师', category: '活动策划', description: '开业、店庆、团购会，从预热到执行到复盘的完整方案', usage: 28, enabled: false, tone: '#FFF1F2', cover: '/images/agents/a11.jpg', starterPrompt: '我们体验店下周六做一场「双 11 全屋智能团购会」，预算 5000 元、目标签 8 单。请给我完整方案：预热期 5 天的动作、当天流程时间表、现场逼单政策、人员分工、复盘指标。' },
  { key: 'a12', name: '小红书图文', category: '朋友圈文案', description: '工地日记、避坑攻略、案例分享，配图建议一起给', usage: 231, enabled: true, tone: '#F0FDFA', cover: '/images/agents/a12.jpg', starterPrompt: '帮我写一篇小红书笔记，主题「装全屋智能前一定要知道的 7 件事」，要：吸睛标题 2 个备选、正文分 7 点每点配一句大白话、结尾互动引导、9 宫格配图清单、标签 8 个。' },
];
