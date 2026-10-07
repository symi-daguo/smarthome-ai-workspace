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
}

export const AGENT_CATEGORIES = [
  '全部', '视频脚本', '朋友圈文案', '直播文案', '品牌传播', '经营诊断', '活动策划', '通用助手', '我的智能体',
];

export const SEED_AGENTS: AgentDef[] = [
  { key: 'a1', name: '智居助手 · 通用对话', category: '通用助手', description: '什么都能问的智能家居全能助手，方案、报价、话术随你发挥', usage: 1020, enabled: true, tone: '#F3F0FF', cover: '/images/agents/a1.jpg' },
  { key: 'a2', name: '智能家居短视频脚本', category: '视频脚本', description: '工地实拍、产品演示、案例故事，一键生成可拍摄的分镜脚本', usage: 900, enabled: true, tone: '#EFF6FF', cover: '/images/agents/a2.jpg' },
  { key: 'a3', name: '朋友圈文案', category: '朋友圈文案', description: '交工、签单、工地日常，配上定位和九宫格就能直接发', usage: 396, enabled: true, tone: '#F0FDF4', cover: '/images/agents/a3.jpg' },
  { key: 'a4', name: '直播逐字稿', category: '直播文案', description: '套餐讲解、互动话术、逼单节奏，开播前给你一份完整逐字稿', usage: 49, enabled: false, tone: '#FFF7ED', cover: '/images/agents/a4.jpg' },
  { key: 'a5', name: '本地推投流文案', category: '品牌传播', description: '按城市+门店+服务区域模板化产出投流素材，覆盖同城获客', usage: 156, enabled: true, tone: '#FDF2F8', cover: '/images/agents/a5.jpg' },
  { key: 'a6', name: 'GEO 品宣优化', category: '品牌传播', description: '优化品牌词与地域词布局，让本地客户搜得到你', usage: 187, enabled: false, tone: '#F5F3FF', cover: '/images/agents/a6.jpg' },
  { key: 'a7', name: '经营问题诊断', category: '经营诊断', description: '获客、转化、交付哪个环节卡住了，帮你拆问题给建议', usage: 345, enabled: true, tone: '#ECFEFF', cover: '/images/agents/a7.jpg' },
  { key: 'a8', name: '短视频开头优化', category: '视频脚本', description: '前 3 秒决定完播率，给你多版开头钩子对比挑选', usage: 42, enabled: false, tone: '#FEFCE8', cover: '/images/agents/a8.jpg' },
  { key: 'a9', name: 'vlog 脚本大师', category: '视频脚本', description: '把一天的工地日常拍成有故事线的 vlog 脚本', usage: 6, enabled: false, tone: '#F0F9FF', cover: '/images/agents/a9.jpg' },
  { key: 'a10', name: '第一视角脚本', category: '视频脚本', description: '沉浸式第一视角安装、演示视频脚本，代入感拉满', usage: 11, enabled: false, tone: '#FAF5FF', cover: '/images/agents/a10.jpg' },
  { key: 'a11', name: '活动策划大师', category: '活动策划', description: '开业、店庆、团购会，从预热到执行到复盘的完整方案', usage: 28, enabled: false, tone: '#FFF1F2', cover: '/images/agents/a11.jpg' },
  { key: 'a12', name: '小红书图文', category: '朋友圈文案', description: '工地日记、避坑攻略、案例分享，配图建议一起给', usage: 231, enabled: true, tone: '#F0FDFA', cover: '/images/agents/a12.jpg' },
];
