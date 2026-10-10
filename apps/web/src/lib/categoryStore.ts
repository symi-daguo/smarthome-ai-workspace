/**
 * 品类字典 store（模块级单例）：
 * 预置 24 类兜底（与后端 category-defs.ts 同口径），启动/进页时经 GET /api/categories
 * 合并租户自定义分类。catMeta/categoryOptions 同步读取，供点位合成、表单选项、表格徽章共用。
 */
import { api } from './api';

export interface CategoryDef {
  id: string;
  key: string;
  label: string;
  color: string;
  icon: string;
  sortOrder: number;
  tenantId: string | null;
}

/** 预置 39 类（后端 category-defs.ts 同步维护；字典加载失败时兜底，id 以 key 占位） */
export const PRESET_CATEGORIES: Omit<CategoryDef, 'id'>[] = [
  { key: 'gateway', label: '网关中枢', color: '#4FA8E0', icon: 'router', sortOrder: 1, tenantId: null },
  { key: 'network', label: '网络覆盖', color: '#3D8BD1', icon: 'wifi', sortOrder: 2, tenantId: null },
  { key: 'switch', label: '开关控制', color: '#B07A4A', icon: 'toggle-right', sortOrder: 3, tenantId: null },
  { key: 'panel', label: '中控面板', color: '#9A6FB0', icon: 'cable', sortOrder: 4, tenantId: null },
  { key: 'sensor', label: '环境传感', color: '#5BA86B', icon: 'radar', sortOrder: 5, tenantId: null },
  { key: 'presence', label: '人体存在', color: '#4E9C7F', icon: 'bell-ring', sortOrder: 6, tenantId: null },
  { key: 'water', label: '水浸漏水', color: '#4A90A8', icon: 'droplets', sortOrder: 7, tenantId: null },
  { key: 'climate', label: '温湿度', color: '#6FA85B', icon: 'thermometer', sortOrder: 8, tenantId: null },
  { key: 'light', label: '灯光照明', color: '#D9A036', icon: 'lamp', sortOrder: 9, tenantId: null },
  { key: 'curtain', label: '窗帘遮阳', color: '#8E7CC3', icon: 'blinds', sortOrder: 10, tenantId: null },
  { key: 'lock', label: '门锁门禁', color: '#C05A5A', icon: 'lock', sortOrder: 11, tenantId: null },
  { key: 'camera', label: '摄像监控', color: '#D06A5A', icon: 'cctv', sortOrder: 12, tenantId: null },
  { key: 'alarm', label: '报警安防', color: '#B04A4A', icon: 'flame', sortOrder: 13, tenantId: null },
  { key: 'appliance', label: '家电控制', color: '#5AA8A0', icon: 'washing-machine', sortOrder: 14, tenantId: null },
  { key: 'kitchen', label: '厨房卫浴', color: '#4A8AA8', icon: 'shower-head', sortOrder: 15, tenantId: null },
  { key: 'cleaner', label: '扫地机器人', color: '#7A8CA8', icon: 'bot', sortOrder: 16, tenantId: null },
  { key: 'laundry', label: '晾衣晾晒', color: '#5B96A8', icon: 'waves', sortOrder: 17, tenantId: null },
  { key: 'audio', label: '影音音响', color: '#C37FB0', icon: 'audio-lines', sortOrder: 18, tenantId: null },
  { key: 'visual', label: '投影影院', color: '#A06FB0', icon: 'projector', sortOrder: 19, tenantId: null },
  { key: 'hvac', label: '暖通新风', color: '#7A8CA8', icon: 'air-vent', sortOrder: 20, tenantId: null },
  { key: 'fresh', label: '空气循环', color: '#5AA88E', icon: 'fan', sortOrder: 21, tenantId: null },
  { key: 'irrigation', label: '庭院灌溉', color: '#5BA85B', icon: 'flower-2', sortOrder: 22, tenantId: null },
  { key: 'pet', label: '宠物照护', color: '#B08A4A', icon: 'paw-print', sortOrder: 23, tenantId: null },
  { key: 'socket', label: '插座供电', color: '#A8863D', icon: 'plug', sortOrder: 24, tenantId: null },
  { key: 'tv', label: '电视大屏', color: '#A06FB0', icon: 'tv', sortOrder: 25, tenantId: null },
  { key: 'fridge', label: '冷藏冰箱', color: '#5AA8A0', icon: 'refrigerator', sortOrder: 26, tenantId: null },
  { key: 'cooker', label: '微蒸烤厨电', color: '#4A8AA8', icon: 'microwave', sortOrder: 27, tenantId: null },
  { key: 'bathroom', label: '智能卫浴', color: '#6FA8C8', icon: 'toilet', sortOrder: 28, tenantId: null },
  { key: 'contact', label: '门窗传感', color: '#4E9C7F', icon: 'door-open', sortOrder: 29, tenantId: null },
  { key: 'siren', label: '声光警号', color: '#D06A5A', icon: 'siren', sortOrder: 30, tenantId: null },
  { key: 'speaker', label: '智能音箱', color: '#C37FB0', icon: 'speaker', sortOrder: 31, tenantId: null },
  { key: 'doorbell', label: '可视门铃', color: '#C05A5A', icon: 'video', sortOrder: 32, tenantId: null },
  { key: 'health', label: '健康监测', color: '#5BA86B', icon: 'heart-pulse', sortOrder: 33, tenantId: null },
  { key: 'elderly', label: '适老照护', color: '#7A8CA8', icon: 'accessibility', sortOrder: 34, tenantId: null },
  { key: 'baby', label: '婴童守护', color: '#D9A0B8', icon: 'baby', sortOrder: 35, tenantId: null },
  { key: 'purifier', label: '净水饮水', color: '#4A90A8', icon: 'glass-water', sortOrder: 36, tenantId: null },
  { key: 'humidifier', label: '加湿除湿', color: '#5B96A8', icon: 'cloud-fog', sortOrder: 37, tenantId: null },
  { key: 'energy', label: '能源光伏', color: '#D9A036', icon: 'zap', sortOrder: 38, tenantId: null },
  { key: 'storage', label: '私有存储', color: '#8E7CC3', icon: 'hard-drive', sortOrder: 39, tenantId: null },
];

/** 旧 key 兼容（存量点位/产品） */
const LEGACY: Record<string, string> = { security: 'camera' };

let dict = new Map<string, CategoryDef>(PRESET_CATEGORIES.map((c) => [c.key, { ...c, id: c.key }]));
let loaded = false;

export async function loadCategoryDict(): Promise<void> {
  try {
    const rows = await api<CategoryDef[]>('/api/categories');
    if (rows.length) {
      dict = new Map(rows.map((c) => [c.key, c]));
    }
    loaded = true;
  } catch {
    // 字典加载失败用预置兜底，不阻塞页面
  }
}

export const categoryDictLoaded = (): boolean => loaded;

export const catDef = (key: string): CategoryDef | undefined => dict.get(LEGACY[key] ?? key);

export const catMeta = (key: string): { label: string; color: string; icon: string } => {
  const d = catDef(key);
  return d ? { label: d.label, color: d.color, icon: d.icon } : { label: key, color: '#888888', icon: 'radar' };
};

/** 表单/筛选选项（预置+自定义按 sortOrder 排列） */
export const categoryOptions = (): { value: string; label: string }[] =>
  [...dict.values()].sort((a, b) => a.sortOrder - b.sortOrder).map((c) => ({ value: c.key, label: c.label }));

/** 全字典（分类管理面板用：含 tenantId 区分预置/自定义） */
export const categoryList = (): CategoryDef[] =>
  [...dict.values()].sort((a, b) => a.sortOrder - b.sortOrder);

/** 自定义分类增删后强制刷新（返回新字典） */
export const refreshCategoryDict = (): Promise<void> => {
  loaded = false;
  return loadCategoryDict();
};
