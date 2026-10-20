/**
 * 户型图上传规则。
 *
 * 为什么单独抽成纯函数：上限、去重、体积、楼层名四条规则要同时作用于
 * 「选文件」和「提交」两处，散在组件里迟早只改一处；而且这些规则**每个都要
 * 单独报错给用户看**，混在一个 if 里会变成「添加失败」这种没法排查的话。
 *
 * 户型图**不压缩**（压缩会毁掉墙线与尺寸标注），
 * 超限直接拒并说明怎么处理，不偷偷降质。
 */

/** 上限 3 张 */
export const FLOORPLAN_MAX = 3;
/** 单文件 20MB / 总体积 35MB */
export const FILE_MAX = 20 * 1024 * 1024;
export const TOTAL_MAX = 35 * 1024 * 1024;
/** 默认可选楼层，越界回退「第N层」 */
export const FLOOR_NAMES = ['一层', '二层', '三层', '四层', '五层', '六层', '七层', '八层'];

export interface FloorplanSlot {
  assetId: string;
  name: string;
  size: number;
  floor: string;
}

/** 第 i 张图的默认楼层名 */
export function defaultFloor(index: number): string {
  return FLOOR_NAMES[index] ?? `第${index + 1}层`;
}

/** 文件唯一键：用 name|size|lastModified|type 去重，这里只保留提交给服务端需要的部分 */
function fileKey(f: { name: string; size: number; lastModified?: number; type?: string }): string {
  return `${f.name}|${f.size}|${f.lastModified ?? 0}|${f.type ?? ''}`;
}

/**
 * 把新选的文件并入已有列表。
 * 返回 `{ slots, added, skipped, error }`：added 是真正入列的，skipped 是重复被忽略的。
 */
export function appendFloorplanFiles(
  current: FloorplanSlot[],
  picked: { name: string; size: number; lastModified?: number; type?: string }[],
): { slots: FloorplanSlot[]; added: number; skipped: number; error: string | null } {
  const slots = [...current];
  let skipped = 0;
  let added = 0;

  for (const f of picked) {
    if (slots.length >= FLOORPLAN_MAX) {
      return { slots, added, skipped, error: `户型图最多上传 ${FLOORPLAN_MAX} 张，多余的那几张没有加进来` };
    }
    if (f.size > FILE_MAX) {
      return { slots, added, skipped, error: `户型图「${f.name}」超过 20MB，请先压小体积再上传` };
    }
    // 去重：同一文件重复选中直接忽略，不报错也不占额度
    const dup = slots.some((s) => fileKey({ ...s, lastModified: 0, type: '' }) === `${f.name}|${f.size}|0|`);
    if (dup) { skipped++; continue; }
    slots.push({ assetId: '', name: f.name, size: f.size, floor: defaultFloor(slots.length) });
    added++;
  }

  const total = slots.reduce((a, b) => a + b.size, 0);
  if (total > TOTAL_MAX) {
    return { slots: current, added: 0, skipped, error: '户型图总大小不能超过 35MB，请减掉几个文件或压小后重传' };
  }
  return { slots, added, skipped, error: null };
}
