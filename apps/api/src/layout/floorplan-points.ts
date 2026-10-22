/**
 * 户型图点位落位规则（纯函数，无 IO，导出供 smoke 直接断言）。
 *
 * ## 为什么要有这一层
 *
 * 让视觉模型直接输出 24 个设备点的坐标，看着省事，实测两个问题：
 * 1. **贵**：每个点都要写一段坐标描述，一套 140㎡ 户型就是 24 段；
 * 2. **不准**：相邻房间（主卫/客卫、四个阳台）之间点错一个，图上就串位，
 *    客户一眼就能看出「这个开关画到隔壁房间去了」。
 *
 * 所以改成两级：
 * - **房间框**由模型给（图上有房间名、有墙，识别大矩形误差极小，实测 13 个房间 <1%）；
 * - **点位坐标**由本地规则算（房间框 + 设备品类 → 房间内典型位置）。
 *
 * 好处：模型只输出十几个矩形（token 少一个量级），点位落位是**确定性**的，
 * 同一个输入永远得到同一个结果，而且**必然落在它该在的那个房间里**。
 * 人工仍可拖拽微调（编辑器已有），但不再需要「点 24 次还得点准」。
 */

/** 识别出的房间：归一化矩形 [x1, y1, x2, y2]（原点在图片左上角） */
export interface DetectedRoom {
  name: string;
  box: [number, number, number, number];
}

/** 落位后的点位 */
export interface DetectedPoint {
  productId: string;
  name: string;
  category: string;
  /** 所属房间名（右侧清单按它与图上的编号对应） */
  room: string;
  /** 归一化坐标 0~1，与底图同坐标系 */
  x: number;
  y: number;
}

/** 候选产品（本地选型用，报价与产品库始终对得上） */
export interface DetectCandidate {
  id: string;
  name: string;
  category: string;
  perRoom: string;
  /** 租户自建库（门店真正在卖的款式，优先于公共库预置） */
  own?: boolean;
  /** 参考零售价：优先选有价的，否则报价会是 0 */
  price?: number;
}

/**
 * 品类 → 房间内典型位置（相对房间矩形的比例，0~1）。
 *
 * 取值依据是这类设备的**安装位置习惯**：
 * 吸顶灯在天花板（房间中部）、窗帘电机在窗边（房间靠窗一侧）、
 * 开关在门侧墙面、插座沿墙、网关在弱电箱角落、存在传感器顶装。
 * 位置不精确到厘米，但**必须落在正确的房间**——这才是客户看得懂的关键。
 */
export const CATEGORY_SPOT: Record<string, [number, number]> = {
  gateway: [0.10, 0.85],
  network: [0.10, 0.85],
  switch: [0.12, 0.80],
  panel: [0.12, 0.32],
  sensor: [0.86, 0.82],
  contact: [0.86, 0.82],
  presence: [0.50, 0.28],
  water: [0.16, 0.88],
  climate: [0.50, 0.55],
  light: [0.50, 0.40],
  curtain: [0.50, 0.12],
  lock: [0.10, 0.50],
  camera: [0.90, 0.20],
  alarm: [0.50, 0.30],
  siren: [0.50, 0.30],
  appliance: [0.88, 0.30],
  kitchen: [0.30, 0.70],
  cleaner: [0.50, 0.60],
  laundry: [0.50, 0.14],
  audio: [0.50, 0.68],
  speaker: [0.50, 0.68],
  visual: [0.50, 0.25],
  hvac: [0.85, 0.25],
  fresh: [0.85, 0.25],
  irrigation: [0.88, 0.75],
  pet: [0.88, 0.75],
  socket: [0.88, 0.72],
  tv: [0.50, 0.30],
  fridge: [0.20, 0.75],
  cooker: [0.20, 0.75],
  bathroom: [0.50, 0.65],
  doorbell: [0.12, 0.45],
  health: [0.35, 0.45],
  elderly: [0.35, 0.45],
  baby: [0.35, 0.45],
  purifier: [0.25, 0.72],
  humidifier: [0.75, 0.70],
  energy: [0.10, 0.90],
  storage: [0.10, 0.90],
};

/** 未登记品类的兜底位置：房间中部 */
const DEFAULT_SPOT: [number, number] = [0.5, 0.5];

/**
 * 同一房间内两个标记的最小间距（归一化，按整张图算）。
 *
 * 取 0.045 是有依据的：点位标记的直径是 0.032（compositePoints 的
 * `canvas.width * 0.016` 半径），0.035 只能刚好不重叠，留不出呼吸感。
 */
const MIN_GAP = 0.045;
/** 标记不贴墙：距离房间边缘至少留这么比例 */
const EDGE_MARGIN = 0.08;

/** 房间数上限：户型再大也超不过这个量，超了按面积取前 N 个 */
const MAX_ROOMS = 24;
/** 每个房间的设备数上限 */
const MAX_DEVICES_PER_ROOM = 6;
/** 全屋设备数上限 */
const MAX_DEVICES_TOTAL = 48;

/** 设备分配：候选清单下标 + 房间名 */
export interface RoomAssignment {
  /** 候选清单下标 */
  i: number;
  room: string;
}

/**
 * 房间名 → 空间类型。
 *
 * 为什么要分类型：不同空间装的东西不一样（卧室有窗帘、卫生间有水浸、
 * 玄关有门锁），按房间名直接配设备只能靠模型临场发挥 —— 慢、不稳、
 * 每次结果还可能不一样。固化成一张表之后，**同样的户型永远得到同一套配置**。
 *
 * 顺序即优先级，先匹配到的先生效（「主卧阳台」要先判成阳台再判成主卧）。
 */
const ROOM_TYPE_RULES: { type: string; kw: string[] }[] = [
  { type: 'balcony', kw: ['阳台'] },
  { type: 'entry', kw: ['玄关', '入户', '门厅'] },
  { type: 'bath', kw: ['卫', '淋浴', '浴室'] },
  { type: 'kitchen', kw: ['厨房'] },
  { type: 'dining', kw: ['餐厅', '饭厅'] },
  { type: 'living', kw: ['客厅', '起居'] },
  { type: 'master', kw: ['主卧'] },
  { type: 'bedroom', kw: ['次卧', '卧室', '客房', '儿童房', '老人房'] },
  { type: 'study', kw: ['书房', '工作间'] },
  { type: 'corridor', kw: ['走廊', '过道', '过厅', '楼梯'] },
  { type: 'storage', kw: ['储藏', '衣帽间', '设备间'] },
];

/** 空间类型 → 标准设备配置（品类 + 名称关键词，按顺序取第一个命中的产品） */
const ROOM_DEVICE_PLAN: Record<string, { cat: string; kw: string[] }[]> = {
  living: [
    { cat: 'gateway', kw: ['中枢网关', '网关'] },
    { cat: 'panel', kw: ['中控屏', '语音面板'] },
    { cat: 'light', kw: ['吸顶灯', '筒射灯', '磁吸灯'] },
    { cat: 'curtain', kw: ['窗帘'] },
    { cat: 'audio', kw: ['音箱', '背景音乐'] },
    { cat: 'camera', kw: ['摄像头'] },
  ],
  dining: [
    { cat: 'light', kw: ['吸顶灯', '磁吸灯', '筒射灯'] },
    { cat: 'curtain', kw: ['窗帘'] },
    { cat: 'switch', kw: ['一键', '二键'] },
    { cat: 'socket', kw: ['智能插座', '插座'] },
  ],
  kitchen: [
    { cat: 'light', kw: ['筒射灯', '射灯', '吸顶灯'] },
    { cat: 'switch', kw: ['一键', '二键'] },
    { cat: 'socket', kw: ['智能插座', '插座'] },
    { cat: 'water', kw: ['水浸'] },
  ],
  master: [
    { cat: 'light', kw: ['吸顶灯', '磁吸灯', '筒射灯'] },
    { cat: 'curtain', kw: ['窗帘'] },
    { cat: 'switch', kw: ['一键', '二键'] },
    { cat: 'climate', kw: ['温控', '温湿度'] },
  ],
  bedroom: [
    { cat: 'light', kw: ['吸顶灯', '磁吸灯', '筒射灯'] },
    { cat: 'curtain', kw: ['窗帘'] },
    { cat: 'switch', kw: ['一键', '二键'] },
  ],
  study: [
    { cat: 'light', kw: ['吸顶灯', '磁吸灯', '筒射灯'] },
    { cat: 'switch', kw: ['一键', '二键'] },
    { cat: 'climate', kw: ['温控', '温湿度'] },
  ],
  bath: [
    { cat: 'light', kw: ['筒射灯', '射灯', '吸顶灯'] },
    { cat: 'switch', kw: ['一键', '二键'] },
    { cat: 'water', kw: ['水浸'] },
    { cat: 'climate', kw: ['温控', '温湿度'] },
  ],
  entry: [
    { cat: 'light', kw: ['吸顶灯', '磁吸灯', '筒射灯'] },
    { cat: 'switch', kw: ['一键', '二键'] },
    { cat: 'lock', kw: ['门锁'] },
    { cat: 'camera', kw: ['摄像头'] },
    { cat: 'panel', kw: ['中控屏', '语音面板'] },
  ],
  balcony: [
    { cat: 'switch', kw: ['一键', '二键'] },
    { cat: 'socket', kw: ['智能插座', '插座'] },
  ],
  corridor: [
    { cat: 'light', kw: ['吸顶灯', '筒射灯', '磁吸灯'] },
    { cat: 'presence', kw: ['存在传感器'] },
  ],
  storage: [{ cat: 'switch', kw: ['一键', '二键'] }],
  other: [
    { cat: 'light', kw: ['吸顶灯', '筒射灯', '磁吸灯'] },
    { cat: 'switch', kw: ['一键', '二键'] },
  ],
};

/** 房间名 → 空间类型（未命中返回 other） */
export function roomTypeOf(roomName: string): string {
  for (const rule of ROOM_TYPE_RULES) {
    if (rule.kw.some((k) => roomName.includes(k))) return rule.type;
  }
  return 'other';
}

/**
 * 按品类与名称关键词从产品库里挑一个最贴的产品。
 *
 * 挑不出关键词命中就退回该品类里「租户自建优先、价格高优先」的那一个 ——
 * 宁可给一个同品类的产品，也别让这个位置空着（漏装比装错更容易出事故）。
 */
function pickProduct(candidates: DetectCandidate[], cat: string, kw: string[]): DetectCandidate | null {
  const pool = candidates.filter((c) => c.category === cat);
  if (!pool.length) return null;
  const rank = (a: DetectCandidate, b: DetectCandidate): number =>
    (b.own ? 1 : 0) - (a.own ? 1 : 0) || (b.price ?? 0) - (a.price ?? 0);
  for (const k of kw) {
    const hit = pool.filter((c) => c.name.includes(k)).sort(rank)[0];
    if (hit) return hit;
  }
  return pool.sort(rank)[0];
}

/**
 * 房间 → 设备分配（**确定性**：同样的户型与产品库，永远得到同一套结果）。
 *
 * 这是「点位落在正确房间」的第二级保证：模型只负责说出「图上有哪些房间、
 * 各在哪」，装什么由本地标准配置表决定，方案师再按现场情况增删微调。
 */
export function assignByRoom(rooms: DetectedRoom[], candidates: DetectCandidate[]): RoomAssignment[] {
  const out: RoomAssignment[] = [];
  for (const room of rooms) {
    const type = roomTypeOf(room.name);
    const plan = ROOM_DEVICE_PLAN[type] ?? ROOM_DEVICE_PLAN.other;
    const used = new Set<string>();
    for (const role of plan) {
      const prod = pickProduct(candidates, role.cat, role.kw);
      if (!prod) continue;
      // 同一房间同款设备只放一个（多台同款由方案师在编辑器里加）
      const key = `${room.name}::${prod.id}`;
      if (used.has(key)) continue;
      used.add(key);
      out.push({ i: candidates.indexOf(prod), room: room.name });
      if (out.length >= MAX_DEVICES_TOTAL) return out;
    }
  }
  return out;
}

/**
 * 校验并归一化模型给的房间矩形。
 *
 * 模型偶尔会给出反序坐标（x1 > x2）或越界值，直接用会让标记跑到图外，
 * 所以这里逐个夹紧并丢弃不合法项。
 */
export function normalizeRooms(raw: unknown): DetectedRoom[] {
  const list = Array.isArray(raw) ? raw : (raw as { rooms?: unknown })?.rooms;
  if (!Array.isArray(list)) return [];
  const out: DetectedRoom[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 20) : '';
    const box = Array.isArray(rec.box) ? rec.box : [];
    if (!name || box.length !== 4) continue;
    const nums = box.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN));
    if (nums.some((v) => Number.isNaN(v))) continue;
    let [x1, y1, x2, y2] = nums as [number, number, number, number];
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (y1 > y2) [y1, y2] = [y2, y1];
    x1 = Math.min(1, Math.max(0, x1));
    x2 = Math.min(1, Math.max(0, x2));
    y1 = Math.min(1, Math.max(0, y1));
    y2 = Math.min(1, Math.max(0, y2));
    // 太小的框不算房间（模型偶尔把家具当成房间）
    if (x2 - x1 < 0.02 || y2 - y1 < 0.02) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, box: [x1, y1, x2, y2] });
    if (out.length >= MAX_ROOMS) break;
  }
  return out;
}

/**
 * 核心：房间框 + 设备分配 → 点位坐标。
 *
 * 步骤：
 * 1. 把分配按房间归拢，丢掉房间名对不上的；
 * 2. 同一房间内按品类典型位置取点；
 * 3. 迭代松弛把挨太近的标记推开，并始终夹在房间内（不贴墙、不越界）。
 */
/**
 * 房间框 + 设备分配 → 点位坐标。
 *
 * 步骤：
 * 1. 把分配按房间归拢，丢掉房间名对不上的；
 * 2. 同一房间内按品类典型位置取点；
 * 3. 迭代松弛把挨太近的标记推开，并始终夹在房间内（不贴墙、不越界）。
 */
export function placeByRoom(
  rooms: DetectedRoom[],
  assignments: RoomAssignment[],
  candidates: DetectCandidate[],
): DetectedPoint[] {
  const roomByName = new Map(rooms.map((r) => [r.name, r]));
  const perRoom = new Map<string, DetectCandidate[]>();
  const used = new Set<string>();

  for (const a of assignments) {
    const room = roomByName.get(a.room);
    const cand = candidates[a.i];
    if (!room || !cand) continue;
    // 同一房间同一产品只放一台（同产品多台的需求由人工再加）
    const key = `${a.room}::${cand.id}`;
    if (used.has(key)) continue;
    used.add(key);
    const list = perRoom.get(a.room) ?? [];
    if (list.length >= MAX_DEVICES_PER_ROOM) continue;
    list.push(cand);
    perRoom.set(a.room, list);
  }

  const out: DetectedPoint[] = [];
  for (const [roomName, list] of perRoom) {
    if (out.length >= MAX_DEVICES_TOTAL) break;
    const room = roomByName.get(roomName);
    if (!room) continue;
    const [rx1, ry1, rx2, ry2] = room.box;
    const rw = Math.max(1e-6, rx2 - rx1);
    const rh = Math.max(1e-6, ry2 - ry1);
    const mx = rw * EDGE_MARGIN;
    const my = rh * EDGE_MARGIN;

    // 1) 初始位置：品类典型位置
    const pts = list.map((c) => {
      const [fx, fy] = CATEGORY_SPOT[c.category] ?? DEFAULT_SPOT;
      return {
        cand: c,
        x: rx1 + mx + (rw - 2 * mx) * fx,
        y: ry1 + my + (rh - 2 * my) * fy,
      };
    });

    // 2) 松弛：挨太近就互相推开（12 轮足够收敛，且结果确定）
    for (let round = 0; round < 12; round += 1) {
      let moved = false;
      for (let i = 0; i < pts.length; i += 1) {
        for (let j = i + 1; j < pts.length; j += 1) {
          const dx = pts[j].x - pts[i].x;
          const dy = pts[j].y - pts[i].y;
          const d = Math.hypot(dx, dy);
          if (d >= MIN_GAP) continue;
          // 重合时给一个确定的方向，避免除零导致 NaN
          const ux = d > 1e-9 ? dx / d : (i % 2 === 0 ? 1 : -1);
          const uy = d > 1e-9 ? dy / d : 0;
          const push = (MIN_GAP - d) / 2;
          pts[i].x -= ux * push;
          pts[i].y -= uy * push;
          pts[j].x += ux * push;
          pts[j].y += uy * push;
          moved = true;
        }
      }
      if (!moved) break;
    }

    // 3) 夹回房间内
    for (const p of pts) {
      p.x = Math.min(rx2 - mx, Math.max(rx1 + mx, p.x));
      p.y = Math.min(ry2 - my, Math.max(ry1 + my, p.y));
      out.push({
        productId: p.cand.id,
        name: p.cand.name,
        category: p.cand.category,
        room: roomName,
        x: Math.round(p.x * 10000) / 10000,
        y: Math.round(p.y * 10000) / 10000,
      });
    }
  }
  return out;
}
