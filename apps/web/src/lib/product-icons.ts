/**
 * 产品品类图标库：基于 lucide（ISC 许可证，免费商用）的图标渲染。
 * 图标为 24x24 viewBox 的 stroke 线条图形，符合物体样式（网关/开关/传感器/灯光/窗帘/
 * 门锁/家电/影音/暖通/晾衣/扫地机/灌溉…），风格统一、可任意缩放。
 * 用途：① React DOM 渲染（categoryIconSvg）；② canvas 合成点位图标（categoryIconDataUrl，
 * 预览/PNG/PPTX/分享四端共用同一合成，像素一致）。
 * 图标 key 来自品类字典（categoryStore：预置 24 类 + 自定义分类复用预置图标），未知 key 回退 radar。
 */
import {
  Accessibility,
  AirVent,
  AudioLines,
  Baby,
  Bath,
  BatteryCharging,
  BellRing,
  Blinds,
  Bot,
  Cable,
  Cctv,
  CloudFog,
  Coffee,
  CookingPot,
  DoorClosed,
  DoorOpen,
  Droplets,
  Fan,
  Flame,
  Flower2,
  GlassWater,
  HardDrive,
  Headphones,
  HeartPulse,
  Keyboard,
  Lamp,
  Lightbulb,
  Lock,
  Microwave,
  Monitor,
  PawPrint,
  PersonStanding,
  Plug,
  Projector,
  Radar,
  Refrigerator,
  Router,
  Scale,
  Server,
  Shirt,
  ShowerHead,
  Siren,
  Smartphone,
  Speaker,
  SunMedium,
  Tablet,
  Thermometer,
  Toilet,
  ToggleRight,
  Tv,
  Umbrella,
  Video,
  WashingMachine,
  Waves,
  Wifi,
  Wind,
  Zap,
} from 'lucide';
import { catMeta } from './categoryStore';

type IconNode = [string, Record<string, string>][];

/** 按需注册 57 个图标（避免全量 icons 打包 2129 个）；预置品类 + 自定义分类共用 */
const ICON_TABLE: Record<string, IconNode> = {
  router: Router as unknown as IconNode,
  wifi: Wifi as unknown as IconNode,
  'toggle-right': ToggleRight as unknown as IconNode,
  cable: Cable as unknown as IconNode,
  radar: Radar as unknown as IconNode,
  'bell-ring': BellRing as unknown as IconNode,
  droplets: Droplets as unknown as IconNode,
  thermometer: Thermometer as unknown as IconNode,
  lamp: Lamp as unknown as IconNode,
  blinds: Blinds as unknown as IconNode,
  lock: Lock as unknown as IconNode,
  cctv: Cctv as unknown as IconNode,
  flame: Flame as unknown as IconNode,
  'washing-machine': WashingMachine as unknown as IconNode,
  'shower-head': ShowerHead as unknown as IconNode,
  bot: Bot as unknown as IconNode,
  waves: Waves as unknown as IconNode,
  'audio-lines': AudioLines as unknown as IconNode,
  projector: Projector as unknown as IconNode,
  'air-vent': AirVent as unknown as IconNode,
  fan: Fan as unknown as IconNode,
  'flower-2': Flower2 as unknown as IconNode,
  'paw-print': PawPrint as unknown as IconNode,
  plug: Plug as unknown as IconNode,
  // 0.1.31 新增 15 个预置品类图标
  tv: Tv as unknown as IconNode,
  refrigerator: Refrigerator as unknown as IconNode,
  microwave: Microwave as unknown as IconNode,
  toilet: Toilet as unknown as IconNode,
  'door-open': DoorOpen as unknown as IconNode,
  siren: Siren as unknown as IconNode,
  speaker: Speaker as unknown as IconNode,
  video: Video as unknown as IconNode,
  'heart-pulse': HeartPulse as unknown as IconNode,
  accessibility: Accessibility as unknown as IconNode,
  baby: Baby as unknown as IconNode,
  'glass-water': GlassWater as unknown as IconNode,
  'cloud-fog': CloudFog as unknown as IconNode,
  zap: Zap as unknown as IconNode,
  'hard-drive': HardDrive as unknown as IconNode,
  // 以下仅供自定义分类挑选（细分场景/同义设备）
  bath: Bath as unknown as IconNode,
  'door-closed': DoorClosed as unknown as IconNode,
  monitor: Monitor as unknown as IconNode,
  tablet: Tablet as unknown as IconNode,
  smartphone: Smartphone as unknown as IconNode,
  'battery-charging': BatteryCharging as unknown as IconNode,
  'sun-medium': SunMedium as unknown as IconNode,
  scale: Scale as unknown as IconNode,
  'person-standing': PersonStanding as unknown as IconNode,
  shirt: Shirt as unknown as IconNode,
  wind: Wind as unknown as IconNode,
  umbrella: Umbrella as unknown as IconNode,
  headphones: Headphones as unknown as IconNode,
  server: Server as unknown as IconNode,
  lightbulb: Lightbulb as unknown as IconNode,
  'cooking-pot': CookingPot as unknown as IconNode,
  keyboard: Keyboard as unknown as IconNode,
  coffee: Coffee as unknown as IconNode,
};

/** 图标选择器 key 清单（分类管理弹窗顺序与 ICON_TABLE key 一致） */
export const PRODUCT_ICON_KEYS: string[] = [
  'router', 'wifi', 'toggle-right', 'cable', 'radar', 'bell-ring', 'droplets', 'thermometer',
  'lamp', 'blinds', 'lock', 'cctv', 'flame', 'washing-machine', 'shower-head', 'bot',
  'waves', 'audio-lines', 'projector', 'air-vent', 'fan', 'flower-2', 'paw-print', 'plug',
  'tv', 'refrigerator', 'microwave', 'toilet', 'door-open', 'siren', 'speaker', 'video',
  'heart-pulse', 'accessibility', 'baby', 'glass-water', 'cloud-fog', 'zap', 'hard-drive',
  'bath', 'door-closed', 'monitor', 'tablet', 'smartphone', 'battery-charging', 'sun-medium',
  'scale', 'person-standing', 'shirt', 'wind', 'umbrella', 'headphones', 'server',
  'lightbulb', 'cooking-pot', 'keyboard', 'coffee',
];

const pickIcon = (iconKey: string): IconNode => ICON_TABLE[iconKey] ?? ICON_TABLE.radar;

/** 序列化为 lucide 原生 SVG 结构（stroke 线条，可指定颜色） */
function toSvg(iconKey: string, size: number, color: string): string {
  const shapes = pickIcon(iconKey)
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
}

/** 生成图标 data URL（供 canvas drawImage 使用；默认白色描边） */
export function iconDataUrl(iconKey: string, color = '#ffffff'): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(toSvg(iconKey, 24, color))}`;
}

/** 按品类 key 生成 data URL（经 categoryStore 解析到图标 key；canvas 点位合成用） */
/**
 * 产品级图标：iconKey 命中就用它，否则回退品类图标。
 *
 * 为什么要产品级：品类图标只有 39 个而产品有 24 个，且同品类必然撞
 * （灯光 4 个、网关 2 个、开关 2 个、摄像头 2 个、AP 4 个）。
 * 点位图上一排标记全是同一个图标时，根本分不清哪个是哪台设备。
 */
/**
 * 图标尺寸档位（0.1.57）。
 *
 * 为什么不直接写数字：之前同一屏出现过 20 / 18 / **17** 三个尺寸 ——
 * 其中 17 明显是看着"差不多"随手调的，导致图标选择器展开时是 17px、收起后变 16px，
 * 同一个图标在开合之间会跳一下。尺寸集中在这里定义，各处引用，不再各写各的。
 */
export const ICON_SIZE = {
  /** 行内小图标（表格行、列表行、菜单项） */
  inline: 16,
  /** 选择器网格、品类管理表头这类中等容器 */
  medium: 18,
  /** 产品缩略图 40×40 盒内 */
  thumb: 20,
  /** 点位标记：未选中 / 选中 */
  marker: 16,
  markerActive: 20,
} as const;

export function productIconDataUrl(category: string, iconKey: string | undefined, color = '#ffffff'): string {
  return iconKey && ICON_TABLE[iconKey] ? iconDataUrl(iconKey, color) : categoryIconDataUrl(category, color);
}

/** 产品级图标 SVG（DOM 用） */
export function productIconSvg(category: string, iconKey: string | undefined, size = 18, color = 'currentColor'): string {
  if (iconKey && ICON_TABLE[iconKey]) return toSvg(iconKey, size, color);
  return categoryIconSvg(category, size, color);
}

export function categoryIconDataUrl(category: string, color = '#ffffff'): string {
  return iconDataUrl(catMeta(category).icon, color);
}

/** React 用：按品类 key 返回 svg 字符串（可指定尺寸与颜色） */
export function categoryIconSvg(category: string, size = 18, color = 'currentColor'): string {
  return toSvg(catMeta(category).icon, size, color);
}

/** React 用：按图标 key 直接渲染（分类管理弹窗预览等） */
export function iconSvgByKey(iconKey: string, size = 18, color = 'currentColor'): string {
  return toSvg(iconKey, size, color);
}
