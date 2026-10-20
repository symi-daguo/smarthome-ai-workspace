/**
 * 装修效果图规则（对齐参考站 `app.js:751-850`）。
 *
 * 三件事必须放在一起，否则界面和提交会各算各的：
 * 1. 上传约束：最多 5 张、超限报错、压缩口径
 * 2. 空间分组：同名归为同一实际空间（不同楼层要写进名字里）
 * 3. **代表图互斥**：同一空间只能有一张代表图 —— 这是「方案主视觉」的唯一来源，
 *    两张都勾上会让主视觉不确定，所以这里必须是规则强制，不能靠 UI 互斥着玩
 *
 * 与户型图（lib/floorplan.ts）的区别：户型图不压缩（压缩会毁墙线与尺寸标注），
 * 效果图是展示图，可以缩。
 */

/** 上限 5 张（参考站 PLAN_RENDER_MAX_FILES） */
export const RENDER_MAX = 5;
/** 压缩阈值：>8MB 或最长边 >2048 才动手（参考站同口径） */
export const COMPRESS_BYTES = 8 * 1024 * 1024;
export const COMPRESS_EDGE = 2048;

/** 空间候选（参考站 datalist p2RoomOptions，共 11 项） */
export const ROOM_OPTIONS = [
  '玄关', '客厅', '餐厅', '厨房', '主卧', '次卧', '儿童房', '书房', '卫生间', '阳台', '全屋',
];

/** 用途：generate=生成场景对比 / provided=按当前状态原样呈现 */
export type UseMode = 'generate' | 'provided';

export interface RenderAsset {
  assetId: string;
  clientId: string;
  name: string;
  /** 实际空间；空串表示还没填 */
  room: string;
  /** 同空间内只能一张为 true */
  representative: boolean;
  useMode: UseMode;
  /** useMode=provided 时的场景名称 */
  sceneName: string;
  roomConfirmed: boolean;
}

/** 上传约束校验。返回可读报错，通过则返回 null */
export function checkRenderUpload(count: number): string | null {
  if (count > RENDER_MAX) return `本方案已选择 ${RENDER_MAX} 张渲染图，请先移除一张`;
  return null;
}

/**
 * 勾选某张为空间代表图：同空间内其余自动取消。
 * 空间名改了也要重算 —— 否则改名后同组可能出现两张代表图。
 */
export function toggleRepresentative(list: RenderAsset[], index: number): RenderAsset[] {
  const target = list[index];
  if (!target) return list;
  const room = target.room.trim();
  return list.map((a, i) => {
    if (i === index) return { ...a, representative: !a.representative };
    // 只在同空间内互斥；未填空间的图之间不互斥（填了空间才有意义）
    if (room && a.room.trim() === room) return { ...a, representative: false };
    return a;
  });
}

/** 改空间名后重算代表图：同组只保留第一张（参考站 syncRenderRepresentatives） */
export function onRoomChanged(list: RenderAsset[], index: number, room: string): RenderAsset[] {
  const next = list.map((a, i) => (i === index ? { ...a, room, roomConfirmed: false } : a));
  return ensureRepresentatives(next);
}

/** 每个非空空间组默认取第一张为代表图（参考站 syncRenderRepresentatives） */
export function ensureRepresentatives(list: RenderAsset[]): RenderAsset[] {
  const seen = new Set<string>();
  return list.map((a) => {
    const room = a.room.trim();
    if (!room) return { ...a, representative: false };
    if (seen.has(room)) return { ...a, representative: false };
    seen.add(room);
    return { ...a, representative: true };
  });
}

/**
 * 提交前校验（参考站 app:3661-3662）：
 * 每张都必须有空间名且已确认，否则整批拒绝。
 * 返回可读报错，通过返回 null。
 */
export function checkRenderReady(list: RenderAsset[]): string | null {
  if (!list.length) return null;
  const bad = list.findIndex((a) => !a.room.trim() || !a.roomConfirmed);
  if (bad >= 0) {
    return '请为每张渲染图指定它对应的空间并确认，同名即视为同一空间；跨楼层请注明属于几层。';
  }
  const noScene = list.findIndex((a) => a.useMode === 'provided' && !a.sceneName.trim());
  if (noScene >= 0) return '选择「按当前状态原样呈现」时，请填写该图对应的场景名称。';
  return null;
}

/** 空间分组 → 折算页数（参考站 app:3371：provided 模式 3 张合 1 页） */
export function renderPageCount(list: RenderAsset[]): number {
  const groups = new Map<string, RenderAsset[]>();
  for (const a of list) {
    const room = a.room.trim() || '__unset__';
    const arr = groups.get(room) ?? [];
    arr.push(a);
    groups.set(room, arr);
  }
  let total = 0;
  for (const arr of groups.values()) {
    const provided = arr.every((a) => a.useMode === 'provided');
    total += provided ? Math.max(1, Math.ceil(arr.length / 3)) : 1;
  }
  return total;
}
