/**
 * 平台预置品类字典（24 类，覆盖市面主流智能家居品类）：
 * key 与前端 lucide 图标映射一致（product-icons.ts），seed 写入 CategoryDef（tenantId=null）。
 * 旧 9 类 key 全部保留（存量数据兼容），新增 15 类补全品类体系。
 */
export const PRESET_CATEGORIES: { key: string; label: string; color: string; icon: string; sortOrder: number }[] = [
  { key: 'gateway', label: '网关中枢', color: '#4FA8E0', icon: 'router', sortOrder: 1 },
  { key: 'network', label: '网络覆盖', color: '#3D8BD1', icon: 'wifi', sortOrder: 2 },
  { key: 'switch', label: '开关控制', color: '#B07A4A', icon: 'toggle-right', sortOrder: 3 },
  { key: 'panel', label: '中控面板', color: '#9A6FB0', icon: 'cable', sortOrder: 4 },
  { key: 'sensor', label: '环境传感', color: '#5BA86B', icon: 'radar', sortOrder: 5 },
  { key: 'presence', label: '人体存在', color: '#4E9C7F', icon: 'bell-ring', sortOrder: 6 },
  { key: 'water', label: '水浸漏水', color: '#4A90A8', icon: 'droplets', sortOrder: 7 },
  { key: 'climate', label: '温湿度', color: '#6FA85B', icon: 'thermometer', sortOrder: 8 },
  { key: 'light', label: '灯光照明', color: '#D9A036', icon: 'lamp', sortOrder: 9 },
  { key: 'curtain', label: '窗帘遮阳', color: '#8E7CC3', icon: 'blinds', sortOrder: 10 },
  { key: 'lock', label: '门锁门禁', color: '#C05A5A', icon: 'lock', sortOrder: 11 },
  { key: 'camera', label: '摄像监控', color: '#D06A5A', icon: 'cctv', sortOrder: 12 },
  { key: 'alarm', label: '报警安防', color: '#B04A4A', icon: 'flame', sortOrder: 13 },
  { key: 'appliance', label: '家电控制', color: '#5AA8A0', icon: 'washing-machine', sortOrder: 14 },
  { key: 'kitchen', label: '厨房卫浴', color: '#4A8AA8', icon: 'shower-head', sortOrder: 15 },
  { key: 'cleaner', label: '扫地机器人', color: '#7A8CA8', icon: 'bot', sortOrder: 16 },
  { key: 'laundry', label: '晾衣晾晒', color: '#5B96A8', icon: 'waves', sortOrder: 17 },
  { key: 'audio', label: '影音音响', color: '#C37FB0', icon: 'audio-lines', sortOrder: 18 },
  { key: 'visual', label: '投影影院', color: '#A06FB0', icon: 'projector', sortOrder: 19 },
  { key: 'hvac', label: '暖通新风', color: '#7A8CA8', icon: 'air-vent', sortOrder: 20 },
  { key: 'fresh', label: '空气循环', color: '#5AA88E', icon: 'fan', sortOrder: 21 },
  { key: 'irrigation', label: '庭院灌溉', color: '#5BA85B', icon: 'flower-2', sortOrder: 22 },
  { key: 'pet', label: '宠物照护', color: '#B08A4A', icon: 'paw-print', sortOrder: 23 },
  { key: 'socket', label: '插座供电', color: '#A8863D', icon: 'plug', sortOrder: 24 },
];

/** 旧 security 归并到新 lock/camera/alarm 的兼容映射（存量点位/产品读取时兜底） */
export const LEGACY_CATEGORY_ALIAS: Record<string, string> = {
  security: 'camera',
};
