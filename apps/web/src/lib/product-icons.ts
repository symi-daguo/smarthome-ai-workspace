/**
 * 产品品类图标库：基于 lucide（ISC 许可证，免费商用）的图标渲染。
 * 图标为 24x24 viewBox 的 stroke 线条图形，符合物体样式（网关/开关/传感器/灯光/窗帘/
 * 门锁/家电/影音/暖通/晾衣/扫地机/灌溉…），风格统一、可任意缩放。
 * 用途：① React DOM 渲染（categoryIconSvg）；② canvas 合成点位图标（categoryIconDataUrl，
 * 预览/PNG/PPTX/分享四端共用同一合成，像素一致）。
 * 图标 key 来自品类字典（categoryStore：预置 24 类 + 自定义分类复用预置图标），未知 key 回退 radar。
 */
import {
  AirVent,
  AudioLines,
  BellRing,
  Blinds,
  Bot,
  Cable,
  Cctv,
  Droplets,
  Fan,
  Flame,
  Flower2,
  Lamp,
  Lock,
  PawPrint,
  Plug,
  Projector,
  Radar,
  Router,
  ShowerHead,
  Thermometer,
  ToggleRight,
  WashingMachine,
  Waves,
  Wifi,
} from 'lucide';
import { catMeta } from './categoryStore';

type IconNode = [string, Record<string, string>][];

/** 按需注册 24 个预置图标（避免全量 icons 打包 2129 个）；自定义分类复用这些 key */
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
};

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
