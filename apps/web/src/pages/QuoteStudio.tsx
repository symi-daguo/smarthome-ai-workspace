import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';
import { App as AntApp, Button, Card, Empty, Grid, Input, InputNumber, Modal, Segmented, Space, Switch, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { TableColumnType, TableColumnsType } from 'antd';
import {
  ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, DownOutlined, DownloadOutlined, EditOutlined, FileExcelOutlined,
  FolderAddOutlined, HolderOutlined, PictureOutlined, PlusOutlined, RightOutlined, SwapOutlined,
} from '@ant-design/icons';
import { api } from '../lib/api';
import { compressImage } from '../lib/compress';
import { PageHeader } from '../components/PageHeader';
import { catMeta } from '../lib/pointOverlay';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';
import { variantFamily, variantGroups, variantMeta, variantSiblings } from '../data/quoteVariants';

const { Text, Link } = Typography;

interface Product {
  id: string;
  name: string;
  category: string;
  unit: string;
  spec: string;
  sku: string;
  barcode: string;
  snRule: string;
  warranty: number;
  priceMin: number;
  priceMax: number;
  perRoom: string;
  priceRetail: number;
  priceDealer: number;
  priceProject: number;
  rebateL1: number;
  rebateL2: number;
  rebateDesigner: number;
}

interface Line {
  product: Product;
  qty: number;
  /** 本次单价覆盖：只存在于页面草稿状态，不写入产品库；undefined 表示按口径取标准价 */
  unitPrice?: number;
  /** 房间（导出报价单用） */
  room: string;
  /** 行备注（导出报价单用） */
  note: string;
}

/** 计价口径：对外报价按官方指导价或工程价；成本一律取经销价（兼容旧数据回退参考价下限） */
type PriceMode = 'retail' | 'project';

function money(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万` : n.toLocaleString('zh-CN');
}

/** 对外成交单价（口径切换）；旧产品缺三级价时回退区间值 */
function sellPrice(p: Product, mode: PriceMode): number {
  return mode === 'retail' ? p.priceRetail || p.priceMax || 0 : p.priceProject || p.priceMin || 0;
}

/** 门店进货成本（经销价）；旧数据回退参考价下限 */
function costPrice(p: Product): number {
  return p.priceDealer || p.priceMin || 0;
}

/** 行内对外单价：优先本次谈定的逐项覆盖价，否则按口径取产品标准价 */
function lineSellPrice(l: Line, mode: PriceMode): number {
  return l.unitPrice ?? sellPrice(l.product, mode);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 导出单元格里的数字：不带货币符号与千分位，方便在 Excel/WPS 里直接求和 */
function plainNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** File → dataURL：户型图只在本页做标注，不上传服务端，省一次上传与清理 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('IMAGE_READ_FAILED'));
    fr.readAsDataURL(file);
  });
}

/** 页面内唯一 id：户型图标签需要一个稳定 key，计数器比随机串更省心 */
let seq = 0;
function nextId(): string {
  seq += 1;
  return `qs${seq}`;
}

/** 户型图上的房间标签：坐标归一化到 0~1，图缩放或换设备都不跑位 */
interface PlanLabel {
  id: string;
  /** 与报价行「房间」同名，靠这个字段把图上标签和报价行绑在一起 */
  room: string;
  x: number;
  y: number;
}

/**
 * 分组视图 + 户型图标注的视图状态，全部收进一个 reducer：
 * 房间顺序、折叠、快速筛选、联动高亮、底图、标签、标注弹窗开关。
 * 这几件事互相牵连（改房间名要同时动顺序表、标签、报价行），散成多个 useState 只会互相覆盖。
 */
interface ViewState {
  /** 按房间分组视图 */
  grouped: boolean;
  /** 房间分组顺序（含用户新建但还没有行的空房分组） */
  roomOrder: string[];
  /** 已折叠的房间名 */
  collapsed: string[];
  /** 快速筛选：只看某房间，空串表示全部 */
  filter: string;
  /** 联动高亮的房间名：点图上标签、点组头、点行内房间都会写这里 */
  activeRoom: string;
  /** 户型图 dataURL */
  planImage: string;
  /** 图上房间标签 */
  labels: PlanLabel[];
  /** 户型图标注弹窗是否打开 */
  planOpen: boolean;
}

type ViewAction =
  | { type: 'grouped' }
  | { type: 'roomOrder'; order: string[] }
  | { type: 'addRoom'; room: string }
  | { type: 'dropRoom'; room: string }
  | { type: 'renameRoom'; from: string; to: string }
  | { type: 'collapse'; room: string }
  | { type: 'filter'; room: string }
  | { type: 'active'; room: string }
  | { type: 'planImage'; url: string }
  | { type: 'planOpen'; open: boolean }
  | { type: 'addLabel'; label: PlanLabel }
  | { type: 'patchLabel'; id: string; patch: Partial<Omit<PlanLabel, 'id'>> }
  | { type: 'dropLabel'; id: string };

const INITIAL_VIEW: ViewState = {
  grouped: false,
  roomOrder: [],
  collapsed: [],
  filter: '',
  activeRoom: '',
  planImage: '',
  labels: [],
  planOpen: false,
};

function viewReducer(s: ViewState, a: ViewAction): ViewState {
  switch (a.type) {
    case 'grouped':
      return { ...s, grouped: !s.grouped };
    case 'roomOrder':
      return { ...s, roomOrder: a.order.filter((r) => !!r) };
    case 'addRoom':
      // 同名不重复建组
      return s.roomOrder.includes(a.room) ? s : { ...s, roomOrder: [...s.roomOrder, a.room] };
    case 'dropRoom':
      // 只在组内无行时调用（UI 才会给出删除入口）；顺手清掉这个房间的标签与筛选/高亮，不留死引用
      return {
        ...s,
        roomOrder: s.roomOrder.filter((r) => r !== a.room),
        labels: s.labels.filter((l) => l.room !== a.room),
        filter: s.filter === a.room ? '' : s.filter,
        activeRoom: s.activeRoom === a.room ? '' : s.activeRoom,
        collapsed: s.collapsed.filter((r) => r !== a.room),
      };
    case 'renameRoom':
      // 房间改名是三方联动：顺序表 + 图上标签一起改，报价行由调用方同步
      if (!a.to || a.from === a.to) return s;
      return {
        ...s,
        roomOrder: s.roomOrder.map((r) => (r === a.from ? a.to : r)),
        labels: s.labels.map((l) => (l.room === a.from ? { ...l, room: a.to } : l)),
        filter: s.filter === a.from ? a.to : s.filter,
        activeRoom: s.activeRoom === a.from ? a.to : s.activeRoom,
      };
    case 'collapse':
      return {
        ...s,
        collapsed: s.collapsed.includes(a.room) ? s.collapsed.filter((r) => r !== a.room) : [...s.collapsed, a.room],
      };
    case 'filter':
      return { ...s, filter: a.room };
    case 'active':
      return { ...s, activeRoom: a.room };
    case 'planImage':
      // 换底图后旧坐标不再指向新图，清掉标签重来，避免标注错位
      return { ...s, planImage: a.url, labels: [], planOpen: true };
    case 'planOpen':
      return { ...s, planOpen: a.open };
    case 'addLabel':
      // 放了标签的房间必然要出现在分组视图里，顺序表补一笔
      return {
        ...s,
        labels: [...s.labels, a.label],
        roomOrder: s.roomOrder.includes(a.label.room) ? s.roomOrder : [...s.roomOrder, a.label.room],
      };
    case 'patchLabel':
      return { ...s, labels: s.labels.map((l) => (l.id === a.id ? { ...l, ...a.patch } : l)) };
    case 'dropLabel':
      return { ...s, labels: s.labels.filter((l) => l.id !== a.id) };
    default:
      return s;
  }
}

/** 把 from 挪到 to 的前/后；同项或找不到目标时原样返回（调用方按引用比对即可知道没动） */
function moveKey(list: string[], from: string, to: string, after: boolean): string[] {
  if (from === to || !list.includes(from) || !list.includes(to)) return list;
  const next = list.filter((k) => k !== from);
  next.splice(after ? next.indexOf(to) + 1 : next.indexOf(to), 0, from);
  return next;
}

/** 把一行挪到另一行的前/后，返回新的 lines */
function moveLine(lines: Line[], fromId: string, toId: string, after: boolean): Line[] {
  const from = lines.findIndex((l) => l.product.id === fromId);
  if (from < 0 || fromId === toId) return lines;
  const next = lines.filter((_, i) => i !== from);
  const to = next.findIndex((l) => l.product.id === toId);
  if (to < 0) return lines;
  next.splice(after ? to + 1 : to, 0, lines[from]);
  return next;
}

/**
 * 按房间顺序重排 lines：同房间的行排到一起，房间内原有相对顺序不变。
 * 顺序表里没有的房间按首次出现顺序接在后面，没填房间的行整体留在末尾——
 * 这样「关掉分组视图」看到的行顺序也跟着分组顺序走，不打架。
 */
function orderLinesByRooms(lines: Line[], rooms: string[]): Line[] {
  const buckets = new Map<string, Line[]>();
  const nameless: Line[] = [];
  for (const l of lines) {
    const r = l.room.trim();
    if (!r) {
      nameless.push(l);
      continue;
    }
    const b = buckets.get(r) ?? [];
    b.push(l);
    buckets.set(r, b);
  }
  const out: Line[] = [];
  const done = new Set<string>();
  for (const r of rooms) {
    out.push(...(buckets.get(r) ?? []));
    done.add(r);
  }
  for (const [r, b] of buckets) if (!done.has(r)) out.push(...b);
  return [...out, ...nameless];
}

/** 拖拽落点提示：排在 over 之前还是之后 */
interface DropHint {
  key: string;
  after: boolean;
}

/**
 * 指针拖拽排序：鼠标与触屏走同一条 pointer 事件路径，不用 HTML5 DnD（手机上 DnD 根本不触发）。
 * 拖动中只画落点提示、松手才真正改顺序，避免每帧重排卡顿。
 * kind 决定读哪个 data 属性，组列表里还嵌着行列表，两者不能串味。
 */
function useDragSort(
  container: RefObject<HTMLElement | null>,
  kind: 'room' | 'line',
  onDrop: (from: string, to: string, after: boolean) => void,
): { dragging: string | null; hint: DropHint | null; start: (key: string) => (e: ReactPointerEvent) => void } {
  const [dragging, setDragging] = useState<string | null>(null);
  const [hint, setHint] = useState<DropHint | null>(null);
  // 松手时要用最后一次算出的落点，state 那时还没提交，读 ref 才准
  const hintRef = useRef<DropHint | null>(null);
  const attr = kind === 'room' ? 'roomKey' : 'lineKey';

  const start = (key: string) => (e: ReactPointerEvent): void => {
    // 只吃主键；触屏 pointerType 为 touch，button 恒为 0
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(key);
    const move = (ev: PointerEvent): void => {
      const box = container.current;
      if (!box) return;
      let next: DropHint | null = null;
      for (const el of box.querySelectorAll<HTMLElement>(`[data-${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`)) {
        const k = el.dataset[attr];
        if (!k || k === key) continue;
        const r = el.getBoundingClientRect();
        // 指针落在某项上半区就排它前面、下半区排它后面
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
          next = { key: k, after: ev.clientY > r.top + r.height / 2 };
          break;
        }
      }
      hintRef.current = next;
      setHint(next);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const h = hintRef.current;
      hintRef.current = null;
      setDragging(null);
      setHint(null);
      if (h) onDrop(key, h.key, h.after);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return { dragging, hint, start };
}

/**
 * 单个房间分组：组头可拖拽排序（窄屏另有上移/下移按钮等价替代），
 * 组内行也用同一套指针拖拽，行序就是 lines 数组顺序，关掉分组视图依然一致。
 */
interface RoomGroupProps {
  room: string;
  rows: Line[];
  mode: PriceMode;
  /** 与平铺视图共用的列定义，两边列完全一致 */
  columns: TableColumnsType<Line>;
  collapsed: boolean;
  active: boolean;
  narrow: boolean;
  /** 本组是否正在被拖 */
  dragging: boolean;
  /** 本组的落点提示（由父级组列表的拖拽给出） */
  hint: DropHint | null;
  /** 父级组列表的拖拽手柄绑定 */
  groupDrag: (e: ReactPointerEvent) => void;
  onToggle: () => void;
  onMove: (dir: -1 | 1) => void;
  onFilter: () => void;
  onDrop: () => void;
  onMoveLine: (from: string, to: string, after: boolean) => void;
}

function RoomGroup(p: RoomGroupProps): ReactNode {
  const { token } = theme.useToken();
  const { room, rows, mode, columns, collapsed, active, narrow, dragging, hint, groupDrag } = p;
  const box = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const rowDrag = useDragSort(box, 'line', p.onMoveLine);
  const title = room || '未分配房间';
  const subtotal = rows.reduce((s, l) => s + lineSellPrice(l, mode) * l.qty, 0);
  const count = rows.reduce((s, l) => s + l.qty, 0);

  // 被图上标签点名时把这一组滚进视野，关掉标注弹窗也能看到落点
  useEffect(() => {
    if (active) group.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);

  const sortColumn: TableColumnType<Line> = {
    title: '排序',
    width: narrow ? 76 : 40,
    render: (_, l) => {
      const i = rows.findIndex((r) => r.product.id === l.product.id);
      const up = i > 0 ? rows[i - 1].product.id : '';
      const down = i >= 0 && i < rows.length - 1 ? rows[i + 1].product.id : '';
      return (
        <Space size={0}>
          <Tooltip title="按住拖拽排序（触屏同样可用）">
            <span
              data-line-key={l.product.id}
              onPointerDown={rowDrag.start(l.product.id)}
              style={{
                cursor: 'grab',
                touchAction: 'none',
                fontSize: 15,
                opacity: rowDrag.dragging === l.product.id ? 0.35 : 0.6,
              }}
            >
              <HolderOutlined />
            </span>
          </Tooltip>
          {narrow ? (
            <Space size={0}>
              <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={!up} style={{ padding: '0 2px' }}
                onClick={() => p.onMoveLine(up, l.product.id, true)} />
              <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={!down} style={{ padding: '0 2px' }}
                onClick={() => p.onMoveLine(down, l.product.id, false)} />
            </Space>
          ) : null}
        </Space>
      );
    },
  };

  return (
    <div
      ref={group}
      data-room-key={room}
      style={{
        marginBottom: 10,
        border: `1px solid ${active ? token.colorPrimary : token.colorBorderSecondary}`,
        borderRadius: 10,
        opacity: dragging ? 0.5 : 1,
        // 落点提示画在分组上下沿，不额外插占位元素，组高度不跳动
        boxShadow: hint && hint.key === room ? `inset 0 ${hint.after ? '-2px' : '2px'} 0 0 ${token.colorPrimary}` : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexWrap: 'wrap' }}>
        <span
          onPointerDown={groupDrag}
          style={{ cursor: 'grab', touchAction: 'none', color: token.colorTextQuaternary }}
        >
          <HolderOutlined />
        </span>
        <Link onClick={p.onToggle} style={{ fontSize: 14 }}>
          {collapsed ? <RightOutlined style={{ fontSize: 10, marginRight: 4 }} /> : <DownOutlined style={{ fontSize: 10, marginRight: 4 }} />}
          {title}
        </Link>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {rows.length} 项 · {count} 件
        </Text>
        <Text strong style={{ fontSize: 13 }}>¥{money(subtotal)}</Text>
        <Link onClick={p.onFilter} style={{ fontSize: 12 }}>只看此房间</Link>
        {narrow ? (
          <Space size={0}>
            <Button size="small" type="text" icon={<ArrowUpOutlined />} onClick={() => p.onMove(-1)} style={{ padding: '0 4px' }} />
            <Button size="small" type="text" icon={<ArrowDownOutlined />} onClick={() => p.onMove(1)} style={{ padding: '0 4px' }} />
          </Space>
        ) : null}
        {room && !rows.length ? (
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={p.onDrop}>删除空分组</Button>
        ) : null}
      </div>
      {collapsed ? null : (
        <div ref={box} style={{ padding: '0 6px 6px' }}>
          <Table<Line>
            rowKey={(l) => l.product.id}
            dataSource={rows}
            pagination={false}
            size="small"
            scroll={{ x: narrow ? 860 : 1120 }}
            columns={[sortColumn, ...columns]}
          />
        </div>
      )}
    </div>
  );
}

/** 智能报价：标准配单 + 换规格 + 逐项单价覆盖 + 计价口径切换 + 按房间分组排序 + 户型图房间标注 + 成本毛利与多级返利测算，导出 CSV / Excel 报价单 */
export function QuoteStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  // 窄屏只在首屏渲染前为 undefined，取 false 表示先按宽屏排版，避免列先出现再消失
  const isNarrow = screens.md === false;
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [project, setProject] = useState('');
  const [customer, setCustomer] = useState('');
  const [mode, setMode] = useState<PriceMode>('retail');
  /** 正在换规格的行（以该行产品 id 表示）；null 表示弹窗关闭 */
  const [variantLineId, setVariantLineId] = useState<string | null>(null);
  /** 正在改单价的行（以该行产品 id 表示） */
  const [priceLineId, setPriceLineId] = useState<string | null>(null);
  /** 改单价弹窗里的输入值；null 表示不覆盖（走标准价） */
  const [priceDraft, setPriceDraft] = useState<number | null>(null);
  /** 新增自定义房间弹窗里的输入值 */
  const [newRoomDraft, setNewRoomDraft] = useState('');
  /** 房间分组视图 + 户型图标注的视图状态，收在一个 reducer 里 */
  const [view, dispatch] = useReducer(viewReducer, INITIAL_VIEW);
  /** 新增自定义房间弹窗是否打开 */
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  /** 户型图是否正在压缩解码 */
  const [planBusy, setPlanBusy] = useState(false);
  /** 组列表容器：整组拖拽排序时在里面找落点 */
  const groupBox = useRef<HTMLDivElement>(null);
  /** 户型图画布容器：标签坐标按它的矩形归一化 */
  const stageBox = useRef<HTMLDivElement>(null);
  const planInput = useRef<HTMLInputElement>(null);
  /** 刚拖动过标签：用来让随后的 click 不误触发联动定位 */
  const labelDragged = useRef(false);

  useEffect(() => {
    api<Product[]>('/api/products').then(setProducts).catch((e) => message.error((e as Error).message));
  }, [message]);

  const addProduct = (product: Product): void => {
    setLines((prev) => {
      const hit = prev.find((l) => l.product.id === product.id);
      if (hit) return prev.map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { product, qty: 1, room: '', note: '' }];
    });
  };

  const setQty = (id: string, qty: number): void => {
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, qty: Math.max(0, qty) } : l)).filter((l) => l.qty > 0));
  };

  const setLineText = (id: string, patch: Partial<Pick<Line, 'room' | 'note'>>): void => {
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, ...patch } : l)));
  };

  const resetUnitPrice = (id: string): void => {
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, unitPrice: undefined } : l)));
  };

  const openPrice = (l: Line): void => {
    setPriceLineId(l.product.id);
    setPriceDraft(l.unitPrice ?? null);
  };

  const savePrice = (): void => {
    if (!priceLineId) return;
    const id = priceLineId;
    // 一个 updater 里一次写完：填了数就是覆盖价，清空输入则回到标准价
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, unitPrice: priceDraft != null ? Math.max(0, priceDraft) : undefined } : l)));
    setPriceLineId(null);
    message.success(priceDraft != null ? '已应用本次单价，仅本次报价生效' : '已恢复标准价');
  };

  /**
   * 换规格：替换当前行的产品，不新增行。
   * 目标规格已被别行占用时合并数量；覆盖价是针对具体规格谈的，换规格后必须清掉，避免旧价串到新规格上。
   */
  const switchVariant = (next: Product): void => {
    if (!variantLineId) return;
    const id = variantLineId;
    // updater 要到渲染阶段才执行，这里从当前 lines 快照读，避免提示判断读到未赋值的 false
    const hadOverride = lines.some((l) => l.product.id === id && l.unitPrice != null);
    setLines((prev) => {
      const cur = prev.find((l) => l.product.id === id);
      if (!cur) return prev;
      const rest = prev.filter((l) => l.product.id !== id);
      const hit = rest.find((l) => l.product.id === next.id);
      if (hit) {
        return rest.map((l) => (l.product.id === next.id ? { ...l, qty: l.qty + cur.qty, room: l.room || cur.room, note: l.note || cur.note } : l));
      }
      return prev.map((l) => (l.product.id === id ? { ...l, product: next, unitPrice: undefined } : l));
    });
    setVariantLineId(null);
    if (hadOverride) message.info('规格已切换，本次单价已清空，请重新填写');
  };

  /**
   * 房间展示顺序：先按用户排好的 roomOrder，再把只在报价行里出现过的房间按首次出现顺序补在后面。
   * 不往 roomOrder 里塞行内的房间名，否则在房间输入框里逐字输入会造出一堆临时分组。
   */
  const roomSequence = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of view.roomOrder) {
      if (r && !seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
    for (const l of lines) {
      const r = l.room.trim();
      if (r && !seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
    return out;
  }, [view.roomOrder, lines]);

  /** 导出与平铺共用的行序列：分组视图下按分组顺序取，否则就是原始行序 */
  const orderedLines = useMemo(() => (view.grouped ? orderLinesByRooms(lines, roomSequence) : lines), [view.grouped, lines, roomSequence]);

  /** 分组视图下的分组数据（含自定义空分组）；未填房间的行挂在末尾的「未分配房间」 */
  const roomGroups = useMemo(() => {
    const byRoom = new Map<string, Line[]>();
    for (const l of lines) {
      const r = l.room.trim();
      if (!r) continue;
      const b = byRoom.get(r) ?? [];
      b.push(l);
      byRoom.set(r, b);
    }
    const list = (view.filter ? roomSequence.filter((r) => r === view.filter) : roomSequence).map((room) => ({
      room,
      rows: byRoom.get(room) ?? [],
    }));
    const nameless = lines.filter((l) => !l.room.trim());
    if (nameless.length && !view.filter) list.push({ room: '', rows: nameless });
    return list;
  }, [lines, roomSequence, view.filter]);

  /** 每个房间的件数与小计：给导出附表用，按当前分组顺序 */
  const roomStats = useMemo(() => {
    const map = new Map<string, { count: number; subtotal: number }>();
    for (const l of orderedLines) {
      const r = l.room.trim();
      if (!r) continue;
      const cur = map.get(r) ?? { count: 0, subtotal: 0 };
      cur.count += l.qty;
      cur.subtotal += lineSellPrice(l, mode) * l.qty;
      map.set(r, cur);
    }
    return map;
  }, [orderedLines, mode]);

  /** 图上标签：按分组顺序排，导出附表和标注列表共用一份 */
  const labelRows = useMemo(
    () =>
      roomSequence
        .map((room) => view.labels.find((l) => l.room === room))
        .filter((l): l is PlanLabel => !!l)
        .map((l) => ({ room: l.room, x: l.x, y: l.y, ...(roomStats.get(l.room) ?? { count: 0, subtotal: 0 }) })),
    [roomSequence, view.labels, roomStats],
  );

  /** 还没有标签的房间：图上以虚线占位提示 */
  const unannotated = useMemo(() => roomSequence.filter((r) => !view.labels.some((l) => l.room === r)), [roomSequence, view.labels]);

  /** 房间改名：报价行、图上标签、分组顺序表三方一起改 */
  const renameRoom = (from: string, raw: string): void => {
    const to = raw.trim();
    if (!to || to === from) return;
    setLines((prev) => prev.map((l) => (l.room.trim() === from ? { ...l, room: to } : l)));
    dispatch({ type: 'renameRoom', from, to });
  };

  /** 移动一个分组并同步重排 lines，让平铺视图的行序也跟着走 */
  const moveRoom = (next: string[]): void => {
    dispatch({ type: 'roomOrder', order: next });
    setLines((prev) => orderLinesByRooms(prev, next));
  };

  const moveGroup = (room: string, dir: -1 | 1): void => {
    const next = moveKey(roomSequence, room, roomSequence[roomSequence.indexOf(room) + dir], dir === 1);
    if (next !== roomSequence) moveRoom(next);
  };

  /** 整组拖拽落点：把 from 挪到 to 之前/之后 */
  const dropGroup = (from: string, to: string, after: boolean): void => {
    const next = moveKey(roomSequence, from, to, after);
    if (next !== roomSequence) moveRoom(next);
  };

  /** 组内行拖拽落点：直接改 lines 数组顺序 */
  const dropLine = (from: string, to: string, after: boolean): void => {
    setLines((prev) => moveLine(prev, from, to, after));
  };

  const groupDrag = useDragSort(groupBox, 'room', dropGroup);

  /** 联动定位：图上标签、行内房间、组头都写同一个 activeRoom */
  const pickRoom = (room: string): void => dispatch({ type: 'active', room });

  /** 图上已标注的房间才能从报价行跳过去看图 */
  const hasLabel = (room: string): boolean => view.labels.some((l) => l.room === room);

  const openPlan = (room: string): void => {
    dispatch({ type: 'active', room });
    dispatch({ type: 'planOpen', open: true });
  };

  /** 新增自定义房间分组：只是加一个空组头，后续把行填进来即可 */
  const saveRoom = (): void => {
    const room = newRoomDraft.trim();
    if (!room) {
      message.warning('请输入房间名');
      return;
    }
    if (roomSequence.includes(room)) {
      message.info('该房间分组已存在');
      setRoomModalOpen(false);
      setNewRoomDraft('');
      return;
    }
    moveRoom([...roomSequence, room]);
    dispatch({ type: 'filter', room: '' });
    setRoomModalOpen(false);
    setNewRoomDraft('');
    message.success(`已新增「${room}」分组`);
  };

  /** 上传户型图：压缩后直接进本页内存，标注完可导出 PNG */
  const pickPlanFile = async (file: File): Promise<void> => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('仅支持 JPG / PNG / WebP 户型图');
      return;
    }
    setPlanBusy(true);
    try {
      const url = await readAsDataUrl(await compressImage(file));
      dispatch({ type: 'planImage', url });
      message.success('户型图已载入，点「新增标签」或直接在图上标注房间');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  /** 放一个房间标签：先按栅格铺开避让重叠，之后用户可随手拖 */
  const addLabelFor = (room: string): void => {
    const n = view.labels.length;
    dispatch({
      type: 'addLabel',
      label: { id: nextId(), room, x: Math.min(0.88, 0.12 + (n % 4) * 0.25), y: Math.min(0.9, 0.16 + Math.floor(n / 4) * 0.22) },
    });
  };

  const addLabel = (): void => addLabelFor(unannotated[0] ?? `房间${view.labels.length + 1}`);

  /** 拖标签：按画布矩形归一化，触屏与鼠标同一条路径 */
  const startLabelDrag = (e: ReactPointerEvent, id: string): void => {
    e.stopPropagation();
    const move = (ev: PointerEvent): void => {
      const rect = stageBox.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return;
      labelDragged.current = true;
      dispatch({
        type: 'patchLabel',
        id,
        patch: {
          x: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
          y: Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
        },
      });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      // 延后一拍清标志，让随后的 click 判断出「刚才是拖动」，不误触发联动定位
      setTimeout(() => { labelDragged.current = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** 导出户型图 PNG：底图与标签一起画到 canvas 上再下载 */
  const exportPlanPng = async (): Promise<void> => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
      img.src = view.planImage;
    });
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 768;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      message.error('当前浏览器不支持 canvas 导出');
      return;
    }
    ctx.drawImage(img, 0, 0, w, h);
    const fs = Math.max(14, Math.round(h / 40));
    ctx.font = `${fs}px sans-serif`;
    for (const l of view.labels) {
      const cx = l.x * w;
      const cy = l.y * h;
      const bw = ctx.measureText(l.room).width + fs * 0.9;
      const bh = fs * 1.9;
      ctx.fillStyle = 'rgba(28, 27, 46, .82)';
      ctx.beginPath();
      ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, bh / 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(l.room, cx, cy);
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('IMAGE_ENCODE_FAILED'))), 'image/png');
    });
    downloadBlob(blob, `${project || '全屋智能'}-户型图标注.png`);
    message.success('户型图（含房间标注）已导出 PNG');
  };

  const totals = useMemo(() => {
    const sell = lines.reduce((s, l) => s + lineSellPrice(l, mode) * l.qty, 0);
    const cost = lines.reduce((s, l) => s + costPrice(l.product) * l.qty, 0);
    const count = lines.reduce((s, l) => s + l.qty, 0);
    // 返利口径：一/二级返点按进货额计提（不受覆盖价影响），设计师返点按对外成交额计提（含覆盖价）
    const l1 = lines.reduce((s, l) => s + (costPrice(l.product) * l.qty * l.product.rebateL1) / 100, 0);
    const l2 = lines.reduce((s, l) => s + (costPrice(l.product) * l.qty * l.product.rebateL2) / 100, 0);
    const designer = lines.reduce((s, l) => s + (lineSellPrice(l, mode) * l.qty * l.product.rebateDesigner) / 100, 0);
    return { sell, cost, count, profit: sell - cost, l1, l2, designer };
  }, [lines, mode]);

  const exportCsv = (): void => {
    if (!lines.length) {
      message.warning('请先添加产品');
      return;
    }
    const modeLabel = mode === 'retail' ? '官方指导价' : '工程价';
    const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
    // 补齐空单元格，保证每行列数一致
    const blanks = (n: number): string[] => Array.from({ length: n }, () => esc(''));
    // 行序跟随当前分组顺序，报价单读下来和屏幕上看到的一致
    const rows = [
      [esc('全屋智能方案报价单'), esc(project || '未命名项目'), esc('客户'), esc(customer || ''), esc('计价口径'), esc(modeLabel), ...blanks(5)],
      [esc('序号'), esc('房间'), esc('SKU'), esc('条码'), esc('SN 规则'), esc('品类'), esc('产品名称'), esc('规格'), esc('单位'), esc('数量'), esc(`单价(${modeLabel})`)],
      ...orderedLines.flatMap((l, i) => [
        [
          esc(i + 1), esc(l.room), esc(l.product.sku), esc(l.product.barcode), esc(l.product.snRule ? `${l.product.snRule}****` : ''),
          esc(catMeta(l.product.category).label), esc(l.product.name), esc(l.product.spec), esc(l.product.unit || '台'), l.qty,
          esc(`${plainNum(lineSellPrice(l, mode))}${l.unitPrice != null ? '*' : ''}`),
        ],
        [esc(''), esc(''), esc('经销成本单价'), esc(costPrice(l.product).toLocaleString('zh-CN')), esc('指导/工程/经销'), esc(`${l.product.priceRetail}/${l.product.priceProject}/${l.product.priceDealer}`),
          esc('返点%（一/二/设计师）'), esc(`${l.product.rebateL1}/${l.product.rebateL2}/${l.product.rebateDesigner}`), esc('质保'), esc(l.product.warranty >= 12 && l.product.warranty % 12 === 0 ? `${l.product.warranty / 12}年` : `${l.product.warranty}月`), esc('')],
      ]),
      [esc(''), esc('对外报价合计'), esc(totals.sell.toLocaleString('zh-CN')), esc('经销成本合计'), esc(totals.cost.toLocaleString('zh-CN')), esc('毛利合计'), esc((totals.sell - totals.cost).toLocaleString('zh-CN')), ...blanks(4)],
      [esc(''), esc('一级返利(按进货额)'), esc(totals.l1.toFixed(1)), esc('二级返利(按进货额)'), esc(totals.l2.toFixed(1)), esc('设计师返利(按成交额)'), esc(totals.designer.toFixed(1)), ...blanks(4)],
      // 户型图附表：坐标是归一化比例（0~1，左上角为原点），图本身另存 PNG 一起发给客户
      ...(labelRows.length
        ? [
            [esc('附表'), esc('户型图房间标注'), esc('房间'), esc('X(0~1)'), esc('Y(0~1)'), esc('件数'), esc('小计'), ...blanks(4)],
            ...labelRows.map((l) => [esc(''), esc(''), esc(l.room), l.x.toFixed(3), l.y.toFixed(3), l.count, plainNum(l.subtotal), ...blanks(4)]),
            [esc('说明'), esc('坐标为 0~1 归一化比例，左上角为原点；户型图（含标注）单独导出为 PNG 与本表一同交付。'), ...blanks(9)],
          ]
        : []),
      [esc('说明'), esc('以上价格与返利比例由部署者在产品中心维护，不含安装辅材与人工；实际成交价以合同为准。标 * 的单价为本次谈定单价，仅本次报价生效。'), ...blanks(9)],
    ];
    downloadBlob(new Blob([`\ufeff${rows.map((r) => r.join(','))}\n`], { type: 'text/csv;charset=utf-8' }), `${project || '全屋智能'}-报价单.csv`);
    message.success('报价单已导出');
  };

  /** 导出 Excel：HTML 表格包成 .xls，Excel/WPS 可直接打开，但不是原生 xls 二进制格式 */
  const exportExcel = (): void => {
    if (!lines.length) {
      message.warning('请先添加产品');
      return;
    }
    const modeLabel = mode === 'retail' ? '官方指导价' : '工程价';
    const esc = (v: string | number): string => String(v).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    const cell = (v: string | number, tag: 'td' | 'th'): string => `<${tag}>${esc(v)}</${tag}>`;
    const row = (cells: Array<string | number>, tag: 'td' | 'th' = 'td'): string => `<tr>${cells.map((c) => cell(c, tag)).join('')}</tr>`;
    const head = (cells: Array<string | number>, span: number): string => `<tr><th colspan="${span}">${esc(cells.join('　　'))}</th></tr>`;
    const body = orderedLines.map((l, i) =>
      row([
        i + 1,
        l.room,
        l.product.name,
        l.product.spec,
        l.qty,
        l.product.unit || '台',
        plainNum(lineSellPrice(l, mode)),
        plainNum(lineSellPrice(l, mode) * l.qty),
        l.note || (l.unitPrice != null ? `本次单价（标准价 ${plainNum(sellPrice(l.product, mode))}）` : ''),
      ]),
    );
    const html = [
      '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">',
      `<title>${esc(project || '全屋智能')}-报价单</title></head><body>`,
      '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:12px">',
      head([`${project || '全屋智能'} 方案报价单`], 9),
      head([`客户：${customer || '未填写'}`, `计价口径：${modeLabel}`, `设备合计：${totals.count} 件`, `导出时间：${new Date().toLocaleString('zh-CN')}`], 9),
      row(['序号', '房间', '产品名称', '规格', '数量', '单位', '单价', '小计', '备注'], 'th'),
      ...body,
      row(['', '', '', '', '', '合计', plainNum(totals.sell), '', ''], 'th'),
      // 户型图附表：坐标为 0~1 归一化比例（0~1，左上角为原点）
      ...(labelRows.length
        ? [
            head(['户型图房间标注（坐标为 0~1 归一化比例，左上角为原点；户型图含标注另存为 PNG）'], 9),
            row(['', '房间', 'X(0~1)', 'Y(0~1)', '件数', '小计', '', '', ''], 'th'),
            ...labelRows.map((l) => row(['', l.room, l.x.toFixed(3), l.y.toFixed(3), `${l.count} 件`, plainNum(l.subtotal), '', '', ''])),
          ]
        : []),
      head(['以上价格不含安装辅材与人工，实际成交价以合同为准；标注「本次单价」的行为逐项谈定价，仅本次报价生效。'], 9),
      '</table></body></html>',
    ].join('');
    downloadBlob(new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel' }), `${project || '全屋智能'}-报价单.xls`);
    message.success('报价单已导出（Excel 可直接打开）');
  };

  const grouped = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of products) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return [...map.entries()];
  }, [products]);

  /** 同 family 的多成员产品按 id 记下变体总数，选品区据此提示「N 个规格」 */
  const groups = useMemo(() => variantGroups(products), [products]);
  const variantCount = useMemo(() => {
    const count = new Map<string, number>();
    for (const list of groups.values()) for (const p of list) count.set(p.id, list.length);
    return count;
  }, [groups]);

  const variantLine = lines.find((l) => l.product.id === variantLineId) ?? null;
  const priceLine = lines.find((l) => l.product.id === priceLineId) ?? null;

  /** 报价行列定义：平铺视图与房间分组视图共用同一份，两边列完全一致 */
  const lineColumns: TableColumnsType<Line> = [
    { title: 'SKU', width: 92, render: (_, l) => <Text type="secondary" style={{ fontSize: 12 }}>{l.product.sku || '—'}</Text> },
    { title: '品类', width: 84, render: (_, l) => <Tag color={catMeta(l.product.category).color} style={{ marginInlineEnd: 0 }}>{catMeta(l.product.category).label}</Tag> },
    {
      title: '产品 / 规格',
      render: (_, l) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{l.product.name}</Text>
          {l.product.spec ? <div><Text type="secondary" style={{ fontSize: 11 }}>{l.product.spec}</Text></div> : null}
        </div>
      ),
    },
    { title: '数量', width: 110, render: (_, l) => (
      <Space size={4}>
        <InputNumber min={1} max={999} value={l.qty} onChange={(v) => setQty(l.product.id, Number(v ?? 0))} size="small" style={{ width: 64 }} />
        <Text type="secondary" style={{ fontSize: 12 }}>{l.product.unit || '台'}</Text>
      </Space>
    ) },
    {
      title: mode === 'retail' ? '指导价单价' : '工程价单价',
      width: 132,
      align: 'right',
      render: (_, l) => (
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          <div>
            <Text strong style={l.unitPrice != null ? { color: token.colorPrimary } : undefined}>
              ¥{money(lineSellPrice(l, mode))}
            </Text>
          </div>
          {l.unitPrice != null ? (
            <div>
              <Tag color="blue" style={{ marginInlineEnd: 6 }}>已改价</Tag>
              <Link onClick={() => resetUnitPrice(l.product.id)} style={{ fontSize: 11 }}>恢复标准价</Link>
            </div>
          ) : (
            <div><Text type="secondary" style={{ fontSize: 11 }}>标准价 ¥{sellPrice(l.product, mode)}</Text></div>
          )}
        </div>
      ),
    },
    { title: '经销成本', width: 92, align: 'right', render: (_, l) => <Text type="success">¥{costPrice(l.product)}</Text> },
    {
      title: '房间 / 备注',
      width: isNarrow ? 128 : 156,
      render: (_, l) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Space size={2} style={{ width: '100%' }}>
            <Input
              value={l.room}
              onChange={(e) => setLineText(l.product.id, { room: e.target.value })}
              placeholder="房间"
              size="small"
              maxLength={12}
              style={{ fontSize: 12 }}
            />
            {/* 图上已有该房间标签时给出跳转按钮：报价行 → 户型图标签的反向联动 */}
            {l.room.trim() && hasLabel(l.room) ? (
              <Tooltip title="在户型图上定位这个房间">
                <Button size="small" type="text" icon={<PictureOutlined />} onClick={() => openPlan(l.room)} style={{ paddingInline: 4 }} />
              </Tooltip>
            ) : null}
          </Space>
          <Input
            value={l.note}
            onChange={(e) => setLineText(l.product.id, { note: e.target.value })}
            placeholder="备注"
            size="small"
            maxLength={30}
            style={{ fontSize: 12 }}
          />
        </Space>
      ),
    },
    {
      title: '小计 / 毛利',
      width: 150,
      align: 'right',
      render: (_, l) => (
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          <div><Text strong>¥{money(lineSellPrice(l, mode) * l.qty)}</Text></div>
          <div><Text type="secondary">毛利 ¥{money((lineSellPrice(l, mode) - costPrice(l.product)) * l.qty)}</Text></div>
        </div>
      ),
    },
    {
      title: '操作',
      width: 124,
      render: (_, l) => (
        <Space size={4} wrap>
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openPrice(l)} style={{ paddingInline: 4 }}>改单价</Button>
          {variantSiblings(groups, l.product).length ? (
            <Button size="small" type="text" icon={<SwapOutlined />} onClick={() => setVariantLineId(l.product.id)} style={{ paddingInline: 4 }}>换规格</Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="智能报价"
        description="从产品库选品配单，同一产品可换规格、可逐项谈定单价，按房间分组与排序、在户型图上标注房间，按官方指导价或工程价切换计价口径，自动测算经销成本、毛利与多级返利，导出标准报价单"
        extra={
          <Space wrap>
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as PriceMode)}
              options={[{ label: '按官方指导价', value: 'retail' }, { label: '按工程价', value: 'project' }]}
            />
            <Button type="primary" icon={<DownloadOutlined />} disabled={!lines.length} onClick={exportCsv}
              style={{ background: BRAND_GRADIENT, border: 'none' }}>
              导出报价单 CSV
            </Button>
            <Button icon={<FileExcelOutlined />} disabled={!lines.length} onClick={exportExcel}>
              导出 Excel
            </Button>
          </Space>
        }
      />

      {/*
        主区两栏：产品库 + 报价单。
        宽屏留白的根因不是列宽数字，而是**外层 flex 容器自身没有 flex-grow**：
        它作为 block 级 div 默认 width=100%，但父级 pageContainerStyle 也没约束时，
        在 AntD Layout 的 flex 行里会退化成内容宽度，两栏加起来多宽就多宽，
        剩下的全部变成右侧空白。
        这里显式 flex:1 + minWidth:0（minWidth:0 是关键，否则 flex item 不会收缩到内容以下），
        再让右栏 flex:1 吃掉剩余宽度 —— 左侧产品库保持窄列（maxWidth 380），右侧铺满。
      */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
        {/* 左：产品库。
            宽度取 380px 上下：这是「名称 + 单价 + SKU + 规格」一行排得下的最小宽度，
            再窄就会出现「空调/伴侣」「智能摄/像头」这种断字。
            flex-basis 用 px 而非百分比，避免被右侧挤压；右侧 flex:1 吃满剩余，不留白。 */}
        <Card
          title="产品库（点击加入报价单）"
          size="small"
          style={{ flex: '0 1 380px', minWidth: 340, maxWidth: 420 }}
          styles={{ body: { padding: '10px 14px', maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
        >
          {grouped.map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <Tag color={catMeta(cat).color} style={{ marginBottom: 6 }}>{catMeta(cat).label}</Tag>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {list.map((p) => (
                  <Button key={p.id} block size="small" style={{ textAlign: 'left', height: 'auto', padding: '5px 10px', whiteSpace: 'normal' }} onClick={() => addProduct(p)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                      <span style={{ fontSize: 11, opacity: 0.7, flexShrink: 0 }}>¥{sellPrice(p, mode)}/{p.unit || '台'}</span>
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.6 }}>
                      {p.sku ? `SKU ${p.sku} · ` : ''}{p.perRoom || '按需布置'}
                      {variantCount.get(p.id) ? ` · ${variantCount.get(p.id)} 个规格` : ''}
                    </div>
                  </Button>
                ))}
              </Space>
            </div>
          ))}
        </Card>

        {/* 右：报价单 */}
        <Card
          style={{ flex: '3 1 560px', minWidth: 320 }}
          title={
            <Space wrap>
              <Input value={project} onChange={(e) => setProject(e.target.value)} maxLength={40} placeholder="项目名（如：140㎡三室两厅全屋智能）" style={{ width: 240 }} size="small" />
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={20} placeholder="客户称呼" style={{ width: 140 }} size="small" />
            </Space>
          }
        >
          {lines.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="报价单为空，从左侧产品库点击添加设备" style={{ padding: '40px 0' }} />
          ) : (
            <>
              {/* 工具条：分组视图开关、房间快速筛选、自定义房间、户型图标注 */}
              <Space wrap size={8} style={{ marginBottom: 10 }}>
                <Switch size="small" checked={view.grouped} onChange={() => dispatch({ type: 'grouped' })} />
                <Text style={{ fontSize: 13 }}>按房间分组视图</Text>
                {roomSequence.length ? (
                  <Space size={4} wrap>
                    {roomSequence.map((r) => (
                      <Tag
                        key={r}
                        color={view.filter === r ? 'blue' : undefined}
                        style={{ cursor: 'pointer' }}
                        onClick={() => dispatch({ type: 'filter', room: view.filter === r ? '' : r })}
                      >
                        {r} {roomStats.get(r)?.count ?? 0} 件
                      </Tag>
                    ))}
                  </Space>
                ) : null}
                {view.filter ? <Link onClick={() => dispatch({ type: 'filter', room: '' })} style={{ fontSize: 12 }}>清除筛选</Link> : null}
                <Button size="small" icon={<FolderAddOutlined />} onClick={() => setRoomModalOpen(true)}>新增自定义房间</Button>
                <Button size="small" icon={<PictureOutlined />} loading={planBusy} onClick={() => planInput.current?.click()}>
                  {view.planImage ? '更换户型图' : '上传户型图'}
                </Button>
                <Button size="small" disabled={!view.planImage} onClick={() => dispatch({ type: 'planOpen', open: true })}>
                  户型图房间标注
                </Button>
                <Button size="small" icon={<DownloadOutlined />} disabled={!view.labels.length} onClick={() => void exportPlanPng()}>
                  导出户型图 PNG
                </Button>
                <input
                  ref={planInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    // 清空后同一个文件再选一次也能触发 change
                    e.target.value = '';
                    if (f) void pickPlanFile(f);
                  }}
                />
              </Space>

              {view.grouped ? (
                <div ref={groupBox}>
                  {roomGroups.map((g) => (
                    <RoomGroup
                      key={g.room || '__none__'}
                      room={g.room}
                      rows={g.rows}
                      mode={mode}
                      columns={lineColumns}
                      collapsed={view.collapsed.includes(g.room)}
                      active={view.activeRoom === g.room && !!g.room}
                      narrow={isNarrow}
                      dragging={groupDrag.dragging === g.room}
                      hint={groupDrag.hint}
                      groupDrag={groupDrag.start(g.room)}
                      onToggle={() => dispatch({ type: 'collapse', room: g.room })}
                      onMove={(dir) => moveGroup(g.room, dir)}
                      onFilter={() => dispatch({ type: 'filter', room: view.filter === g.room ? '' : g.room })}
                      onDrop={() => dispatch({ type: 'dropRoom', room: g.room })}
                      onMoveLine={dropLine}
                    />
                  ))}
                </div>
              ) : (
                <Table<Line>
                  rowKey={(l) => l.product.id}
                  // 快速筛选在平铺视图同样生效，只是按行过滤
                  dataSource={view.filter ? lines.filter((l) => l.room.trim() === view.filter) : lines}
                  pagination={false}
                  size="small"
                  scroll={{ x: isNarrow ? 820 : 1080 }}
                  columns={lineColumns}
                />
              )}

              {/* 汇总卡：对外报价、成本、毛利、三级返利测算 */}
              <div
                style={{
                  marginTop: 14,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 10,
                }}
              >
                {[
                  { label: `对外报价合计（${mode === 'retail' ? '指导价' : '工程价'}）`, value: `¥${money(totals.sell)}`, strong: true },
                  { label: `设备 ${totals.count} 件 · 经销成本`, value: `¥${money(totals.cost)}` },
                  { label: '预估毛利', value: `¥${money(totals.profit)}` },
                  { label: '一级返利（进货额计提）', value: `¥${totals.l1.toFixed(0)}` },
                  { label: '二级返利（进货额计提）', value: `¥${totals.l2.toFixed(0)}` },
                  { label: '设计师返利（成交额计提）', value: `¥${totals.designer.toFixed(0)}` },
                ].map((c) => (
                  <div key={c.label} style={{ border: `1px solid rgba(0,0,0,.08)`, borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: 'rgba(0,0,0,.45)', marginBottom: 4 }}>{c.label}</div>
                    <Text strong style={{ fontSize: c.strong ? 18 : 15 }}>{c.value}</Text>
                  </div>
                ))}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
                返利口径：一级/二级返点按经销进货额计提，设计师返点按对外成交额计提；比例在「产品中心 → 编辑产品」维护，单价由部署者配置，平台不预设商业定价。
              </Text>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                逐项单价仅本次生效：它只存在于本页草稿，刷新页面即失效，也不会写回产品库；导出的 Excel 为 HTML 表格格式，Excel / WPS 可直接打开（不是原生 xls 二进制）。
              </Text>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                房间分组、排序、户型图标注同样只存在于本页草稿：按住 <HolderOutlined /> 拖动可排序（触屏同样可用，窄屏另有上移/下移按钮），导出的 CSV / Excel 按当前分组顺序输出并附房间标注坐标表，户型图含标注另存为 PNG。
              </Text>
            </>
          )}
        </Card>
      </div>

      {/* 新增自定义房间：只是先建一个空分组，把行的房间填成同名即可归入 */}
      <Modal
        title="新增自定义房间分组"
        open={roomModalOpen}
        onCancel={() => { setRoomModalOpen(false); setNewRoomDraft(''); }}
        onOk={saveRoom}
        okText="新增"
        cancelText="取消"
        width={isNarrow ? '92vw' : 420}
        destroyOnHidden
      >
        <Input
          value={newRoomDraft}
          onChange={(e) => setNewRoomDraft(e.target.value)}
          onPressEnter={saveRoom}
          placeholder="房间名（如：主卧 / 客厅 / 阳台）"
          maxLength={12}
          autoFocus
        />
      </Modal>

      {/* 户型图房间标注：拖标签定位置，标签与报价行靠房间名联动 */}
      <Modal
        title="户型图房间标注"
        open={view.planOpen}
        onCancel={() => dispatch({ type: 'planOpen', open: false })}
        footer={null}
        width={isNarrow ? '96vw' : 960}
        destroyOnHidden
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 460px', minWidth: 260 }}>
            <Space wrap size={8} style={{ marginBottom: 8 }}>
              <Button size="small" icon={<PictureOutlined />} loading={planBusy} onClick={() => planInput.current?.click()}>
                {view.planImage ? '更换户型图' : '上传户型图'}
              </Button>
              <Button size="small" icon={<PlusOutlined />} disabled={!view.planImage} onClick={addLabel}>新增标签</Button>
              <Button size="small" icon={<DownloadOutlined />} disabled={!view.labels.length} onClick={() => void exportPlanPng()}>
                导出 PNG
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>按住标签拖动即可挪位置，坐标按图归一化，缩放不跑位</Text>
            </Space>
            {view.planImage ? (
              <div
                ref={stageBox}
                style={{
                  position: 'relative',
                  lineHeight: 0,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 8,
                  overflow: 'hidden',
                  touchAction: 'none',
                  userSelect: 'none',
                }}
              >
                <img src={view.planImage} alt="户型图" draggable={false} style={{ width: '100%', display: 'block' }} />
                {view.labels.map((l) => (
                  <div
                    key={l.id}
                    onPointerDown={(e) => startLabelDrag(e, l.id)}
                    onClick={() => { if (!labelDragged.current) pickRoom(l.room); }}
                    style={{
                      position: 'absolute',
                      left: `${l.x * 100}%`,
                      top: `${l.y * 100}%`,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 10px',
                      borderRadius: 999,
                      fontSize: 12,
                      lineHeight: 1.7,
                      whiteSpace: 'nowrap',
                      cursor: 'grab',
                      touchAction: 'none',
                      background: view.activeRoom === l.room ? token.colorPrimary : 'rgba(28, 27, 46, .82)',
                      color: '#FFFFFF',
                      border: `1px solid ${view.activeRoom === l.room ? token.colorPrimary : 'rgba(255, 255, 255, .4)'}`,
                    }}
                  >
                    {l.room}
                  </div>
                ))}
                {/* 还没落标签的房间：虚线占位，点一下就在图上补一个标签 */}
                {unannotated.length ? (
                  <div style={{ position: 'absolute', left: 6, right: 6, bottom: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {unannotated.map((r) => (
                      <Tag
                        key={r}
                        style={{ marginInlineEnd: 0, cursor: 'pointer', borderStyle: 'dashed', background: 'rgba(255, 255, 255, .85)' }}
                        onClick={() => addLabelFor(r)}
                      >
                        ＋ {r}（该房间尚未在图上标注）
                      </Tag>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先上传户型平面图，再把房间标签拖到对应位置" />
            )}
          </div>
          <div style={{ flex: '0 1 250px', minWidth: 200 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              房间名在报价行、图上标签、导出附表三处同名联动：改这里会同步改掉该房间所有报价行与已有标签。
            </Text>
            <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8, maxHeight: '54vh', overflowY: 'auto' }}>
              {roomSequence.length ? roomSequence.map((r) => {
                const label = view.labels.find((l) => l.room === r);
                return (
                  <div
                    key={r}
                    style={{
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                      padding: '4px 6px',
                      borderRadius: 8,
                      background: view.activeRoom === r ? token.colorPrimaryBg : undefined,
                    }}
                  >
                    <Input
                      key={`${r}-${label?.id ?? ''}`}
                      defaultValue={r}
                      size="small"
                      maxLength={12}
                      style={{ flex: 1, fontSize: 12 }}
                      onPressEnter={(e) => renameRoom(r, (e.target as HTMLInputElement).value)}
                      onBlur={(e) => renameRoom(r, e.target.value)}
                    />
                    {label ? (
                      <Tooltip title={`图上坐标 ${label.x.toFixed(2)}, ${label.y.toFixed(2)}`}>
                        <Tag color="green" style={{ marginInlineEnd: 0, cursor: 'pointer' }} onClick={() => pickRoom(r)}>已标注</Tag>
                      </Tooltip>
                    ) : (
                      <Tooltip title="该房间尚未在图上标注">
                        <Tag style={{ marginInlineEnd: 0, borderStyle: 'dashed' }}>未标注</Tag>
                      </Tooltip>
                    )}
                    <Button
                      size="small"
                      type="text"
                      icon={<DeleteOutlined />}
                      disabled={!label}
                      onClick={() => dispatch({ type: 'dropLabel', id: label?.id ?? '' })}
                    />
                  </div>
                );
              }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先在报价行填房间名" />}
            </Space>
          </div>
        </div>
      </Modal>

      {/* 换规格：列出同 family 全部变体，点击替换当前行的产品 */}
      <Modal
        title={`换规格 · ${variantLine ? variantMeta(variantLine.product.name).base : ''}`}
        open={!!variantLine}
        onCancel={() => setVariantLineId(null)}
        footer={null}
        width={isNarrow ? '92vw' : 520}
        destroyOnHidden
      >
        <Text type="secondary" style={{ fontSize: 12 }}>选择规格替换本行产品，数量与房间保持不变</Text>
        <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8, maxHeight: '46vh', overflowY: 'auto' }}>
          {(variantLine ? variantFamily(groups, variantLine.product) : []).map((p) => {
            const current = variantLine?.product.id === p.id;
            return (
              <Button
                key={p.id}
                block
                onClick={() => switchVariant(p)}
                style={{
                  height: 'auto',
                  padding: '8px 10px',
                  whiteSpace: 'normal',
                  textAlign: 'left',
                  background: current ? token.colorPrimaryBg : undefined,
                  borderColor: current ? token.colorPrimary : undefined,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                  <span style={{ fontSize: 12, flexShrink: 0 }}>¥{sellPrice(p, mode)}/{p.unit || '台'}</span>
                </div>
                <div style={{ fontSize: 11, opacity: 0.65 }}>
                  {[p.spec, p.sku ? `SKU ${p.sku}` : '', current ? '当前规格' : ''].filter(Boolean).join(' · ')}
                </div>
              </Button>
            );
          })}
        </Space>
      </Modal>

      {/* 逐项单价覆盖：显示参考价区间，只填本次谈定价 */}
      <Modal
        title={`改单价 · ${priceLine?.product.name ?? ''}`}
        open={!!priceLine}
        onCancel={() => setPriceLineId(null)}
        onOk={savePrice}
        okText="应用"
        cancelText="取消"
        width={isNarrow ? '92vw' : 440}
        destroyOnHidden
      >
        {priceLine ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              参考价区间 ¥{priceLine.product.priceMin} ~ ¥{priceLine.product.priceMax}；当前
              {mode === 'retail' ? '指导价' : '工程价'} ¥{sellPrice(priceLine.product, mode)}，经销成本 ¥{costPrice(priceLine.product)}。
            </Text>
            <InputNumber
              value={priceDraft}
              onChange={(v) => setPriceDraft(v == null ? null : Number(v))}
              min={0}
              precision={2}
              step={10}
              placeholder={`本次单价，留空则按标准价 ¥${sellPrice(priceLine.product, mode)}`}
              style={{ width: '100%' }}
              addonBefore="¥"
            />
            <Text type="secondary" style={{ fontSize: 11 }}>逐项单价仅本次报价生效，不改产品库标准价。</Text>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
