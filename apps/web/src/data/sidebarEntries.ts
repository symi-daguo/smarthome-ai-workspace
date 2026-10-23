/**
 * 侧栏入口清单（设置页与侧栏共用的唯一数据源）。
 *
 * 为什么清单要单独一份：
 * 侧栏按可见性过滤后，**设置页要显示的开关必须与侧栏实际存在的入口一一对应**。
 * 两处各写一份的话，迟早会漂移 —— 侧栏加了入口而设置页没有开关，
 * 或者设置页列了开关而侧栏没有对应项，两种都是「配了不生效」。
 *
 * 顺序即侧栏里的显示顺序（按分组）。
 */
/**
 * 分组名 —— 侧栏渲染与设置页清单共用同一份。
 *
 * 为什么要抽成常量：分组名原来在 MainLayout.tsx（渲染侧栏）与本文件（设置页清单）
 * 各写一份，改一处忘一处就漂移 —— 本轮就踩过：改了设置页那一侧，
 * 侧栏还是老名字，两个界面显示不一致。
 */
export const SIDEBAR_GROUP_LABELS = {
  ai: 'AI 超能力',
  design: '设计交付',
  toolbox: '工具与内容',
  system: '系统管理',
} as const;

export type SidebarGroup = (typeof SIDEBAR_GROUP_LABELS)[keyof typeof SIDEBAR_GROUP_LABELS];

export interface SidebarEntry {
  /** 稳定标识，与路由路径一致 */
  key: string;
  label: string;
  /** 一句话说明这个入口是干什么的，帮你决定要不要留 */
  desc: string;
  /**
   * 分组名。
   *
   * 分组名不能和组内任何一个入口同名 —— 侧栏会把分组标题渲染成一行灰色小字，
   * 紧跟着又渲染同名的那一行，看起来就是「同一个入口出现了两次」。
   * （分组标题是「智能百宝箱」、组内第一个入口也叫「智能百宝箱」时就是这样。）
   */
  group: SidebarGroup;
}

/**
 * 全部侧栏入口。
 *
 * 这里的每一项都是**真实可用**的功能 —— 之前的做法是把不想要的入口直接注释掉，
 * 那是把「功能有没有」和「默认显不显示」混成了一件事。现在拆开：
 * 功能全在，默认全显示，客户按自己门店的业务线在设置里勾掉用不上的。
 */
export const SIDEBAR_ENTRIES: SidebarEntry[] = [
  { key: '/', label: '工作台', desc: '对话入口与常用能力入口', group: 'AI 超能力' },
  { key: '/agents', label: 'AI 智能体', desc: '预置与自建智能体', group: 'AI 超能力' },
  { key: '/canvas', label: 'AI 画布', desc: '自由拼装的创作画布', group: 'AI 超能力' },
  { key: '/products', label: '产品中心', desc: '产品库、选型与报价参考价', group: 'AI 超能力' },
  { key: '/order', label: '开始接单', desc: '从客户需求到任务的接单流程', group: 'AI 超能力' },
  { key: '/image', label: 'AI 生图', desc: '效果图与平面图精修', group: 'AI 超能力' },
  { key: '/video', label: 'AI 生视频', desc: '演示短视频生成', group: 'AI 超能力' },
  { key: '/plan', label: '智能方案', desc: '方案文案、点位与 PPT 交付', group: 'AI 超能力' },
  { key: '/floorplan', label: '平面图与点位', desc: '户型图布点与点位反复修改', group: '设计交付' },
  { key: '/treasure', label: '智能百宝箱', desc: '各类小工具集合', group: '工具与内容' },
  { key: '/knowledge', label: '我的知识库', desc: '品牌与项目素材沉淀', group: '工具与内容' },
  { key: '/works', label: '我的作品', desc: '生成过的图片与视频', group: '工具与内容' },
  { key: '/benchmark', label: '对标情报', desc: '同行公开资料整理', group: '工具与内容' },
  { key: '/content', label: '内容提取', desc: '从文档与链接提取要点', group: '工具与内容' },
  { key: '/team', label: '团队与接入', desc: '成员、角色与 API 接入', group: '系统管理' },
  { key: '/tokens', label: '个人中心', desc: '资料、设置、备份与存储治理', group: '系统管理' },
  { key: '/model-config', label: '模型配置', desc: '接入自有模型服务（需管理权限）', group: '系统管理' },
];

/** 分组的显示顺序 */
export const SIDEBAR_GROUPS: SidebarGroup[] = Object.values(SIDEBAR_GROUP_LABELS);
