/**
 * 产品品类图标库：9 类内联 SVG（24x24 viewBox，白色填充），零外部依赖。
 * 用途：① 点位编辑器 DOM 与产品库列表用 React 组件渲染；
 *      ② compositePoints 在 canvas 上把图标画进彩色圆底（预览/PNG/PPTX/分享四端共用同一合成，像素一致）。
 * 说明：图标为纯几何 path，不含文字，缩放到 ~28px 仍清晰；颜色固定 white，靠底层彩色圆形成对比。
 */

export const CATEGORY_ICON_PATHS: Record<string, string> = {
  // 网关：主机 + 天线 + 信号
  gateway: 'M12 3a1 1 0 0 1 1 1v6h-2V4a1 1 0 0 1 1-1Zm-4.9 3.1a1 1 0 0 1 1.4 0 4 4 0 0 0 5.6 0 1 1 0 0 1 1.4 1.4 6 6 0 0 1-8.4 0 1 1 0 0 1 0-1.4ZM4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Zm3 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  // 开关：圆角面板 + 拨钮
  switch: 'M7 2h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Zm0 3v6h10V5H7Zm2 10h6a1 1 0 0 1 0 2H9a1 1 0 0 1 0-2Z',
  // 传感器：中心点 + 探测波纹
  sensor: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0-6a1 1 0 0 1 1 1 6 6 0 0 1 5 5 1 1 0 1 1-2 0 4 4 0 0 0-4-4 1 1 0 0 1 0-2Zm0 16a6 6 0 0 1-5-3 1 1 0 1 1 1.6-1.2A4 4 0 0 0 12 17a1 1 0 0 1 0 2Zm8-8a1 1 0 0 1-1-1 4 4 0 0 0-4-4 1 1 0 1 1 0-2 6 6 0 0 1 6 6 1 1 0 0 1-1 1Z',
  // 灯光：吸顶灯罩 + 光晕
  light: 'M12 2a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Zm0 6a5 5 0 0 1 5 5v1H7v-1a5 5 0 0 1 5-5Zm-6 8h12a1 1 0 0 1 0 2H6a1 1 0 0 1 0-2Zm3 3h6a1 1 0 0 1 0 2H9a1 1 0 0 1 0-2Z',
  // 窗帘：窗框 + 波浪帘布
  curtain: 'M3 3h18v3H3V3Zm2 5h5v11a3 3 0 0 1-5 0V8Zm9 0h5v11a3 3 0 0 1-5 0V8Z',
  // 安防：监控摄像头
  security: 'M4 5a1 1 0 0 1 1-1h1l11 4-1 2.6L6 7H5a1 1 0 0 1-1-1V5Zm6 8a3 3 0 0 1 6 0v4a3 3 0 0 1-6 0v-4Zm-4 6h12a1 1 0 0 1 0 2H6a1 1 0 0 1 0-2Z',
  // 家电控制：插头
  appliance: 'M8 2a1 1 0 0 1 1 1v4H7V3a1 1 0 0 1 1-1Zm8 0a1 1 0 0 1 1 1v4h-2V3a1 1 0 0 1 1-1Zm-9 7h10a2 2 0 0 1 2 2v1a6 6 0 0 1-5 5.9V21a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-3.1A6 6 0 0 1 5 12v-1a2 2 0 0 1 2-2Z',
  // 影音：扬声器
  audio: 'M6 4h9a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm5 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm8-2h2v8h-2v-8Z',
  // 暖通环境：风扇/空调
  hvac: 'M12 11a1 1 0 0 1 1 1v1h1a1 1 0 1 1 0 2h-1v1a1 1 0 1 1-2 0v-1h-1a1 1 0 1 1 0-2h1v-1a1 1 0 0 1 1-1Zm0-9a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Zm0 16a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1ZM3 11a1 1 0 0 1 0 2H2a1 1 0 1 1 0-2h1Zm19 0a1 1 0 1 1 0 2h-1a1 1 0 1 1 0-2h1Z',
};

/** 生成某品类图标的 data URL（供 canvas drawImage 使用；白色填充） */
export function categoryIconDataUrl(category: string): string {
  const path = CATEGORY_ICON_PATHS[category] ?? CATEGORY_ICON_PATHS.sensor;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path fill="#ffffff" d="${path}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** React 用：返回可直接 dangerouslySetInnerHTML 的 svg 字符串（可指定尺寸与颜色） */
export function categoryIconSvg(category: string, size = 18, color = 'currentColor'): string {
  const path = CATEGORY_ICON_PATHS[category] ?? CATEGORY_ICON_PATHS.sensor;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"><path fill="${color}" d="${path}"/></svg>`;
}
