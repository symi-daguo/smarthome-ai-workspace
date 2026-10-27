/**
 * 设备清单与报价：**算出来**，不是**写出来**。
 *
 * 为什么不用方案文案里的预算区间：那是模型给的估算，没有依据。
 * 实测同一套点位（24 点 / 18 种设备），产品库参考零售价合计 9776 元，
 * 而模型写的预算区间是 53000-80000 元 —— 方向没错（差额是辅材与人工），
 * 但它并不知道这套方案实际用了哪 18 种设备。
 *
 * 报价清单必须由「真实点位 + 产品库价格」推出：
 *   数量 = 该款设备在平面图上的点位个数
 *   单价 = 产品库的参考零售价（priceRetail；没填时回退 priceMax，见 quoteUnitPrice）
 * 这样清单与平面图天然一一对应，客户翻两页就能对着核。
 *
 * 口径：**不含**辅材、布线、安装与调试费用（页面上写明了）——
 * 设备价与整包工程价差好几倍，混在一起必然引发纠纷。
 *
 * 为什么放后端：分享页是免鉴权公开页，客户端拿不到产品库价格。
 * 放后端算，PPTX、讲稿、分享页三处拿到的是**同一份**数据，不会各算各的。
 */

/** 报价清单的一行 */
export interface QuoteItem {
  name: string;
  category: string;
  /** 台数（同款设备在平面图上的点位个数） */
  qty: number;
  /** 参考零售价（元/台） */
  unitPrice: number;
  /** 小计 = qty × unitPrice */
  subtotal: number;
}

/** 报价汇总 */
export interface QuoteSummary {
  items: QuoteItem[];
  /** 设备参考零售合计（元） */
  total: number;
  /** 台数合计 */
  deviceCount: number;
  /** 品类数 */
  kindCount: number;
  /** 安装调试费率（百分比，租户级设置） */
  installRate: number;
  /** 安装调试费（元）= 设备合计 × 费率 */
  installFee: number;
  /** 整包合计（元）= 设备合计 + 安装调试费 */
  grandTotal: number;
}

/** 点位里报价要用的字段 */
export interface QuotePoint {
  productId?: string | null;
  name: string;
  category: string;
}

/** 产品库里报价要用的字段 */
export interface QuoteProduct {
  id: string;
  name: string;
  category: string;
  priceRetail?: number | null;
  /** 指导价：priceRetail 为 0 时的兜底（见 quoteUnitPrice） */
  priceMax?: number | null;
}

/**
 * 报价单价口径（**唯一真源**）。
 *
 * 规则：priceRetail 优先；它是 0（没填）时回退 priceMax；两个都没有才是 0。
 *
 * 为什么必须回退 priceMax：建产品时 priceRetail 缺省 0，而
 * `syncLegacyPriceRange` 在两个价格都没填时直接 return，priceMax 保留用户填的值 ——
 * 于是「priceMin=699, priceMax=999」的产品会得到 priceRetail=0、priceMax=999。
 * 只看 priceRetail 的算法算出 ¥0，而前端口径是 `priceRetail || priceMax || 0`（显示 ¥999），
 * 同一台设备在报价页与分享页/PPTX 里价钱不一样，客户看到的是「报价单上没有这台设备的钱」。
 *
 * 三处口径（前端 QuoteStudio、后端报价、户型识别候选）必须一致，
 * 所以这里抽成一个函数，谁用都调它，别再各写一遍 `||`。
 */
export function quoteUnitPrice(
  product: { priceRetail?: number | null; priceMax?: number | null } | null | undefined,
): number {
  return Number(product?.priceRetail || product?.priceMax || 0);
}

/**
 * 报价取产品的租户条件（与产品列表同口径：公共库 + 本租户）。
 *
 * 报价结果会进**免鉴权的公开分享页** —— 产品查询一旦不带租户条件，
 * 别的租户的产品与价格就会出现在本页面上。ids 来自客户端传的 layoutPoints，
 * 未经归属校验，只能靠这个 where 圈死范围。
 */
export function quoteProductWhere(
  tenantId: string,
  ids: string[],
): { id: { in: string[] }; OR: { tenantId: null | string }[] } {
  return { id: { in: ids }, OR: [{ tenantId: null }, { tenantId }] };
}

/**
 * 从 DB 的 layoutPoints（Json 字段）里取出报价要用的字段。
 *
 * 为什么要单独过一遍：layoutPoints 是 Json，形状不保证统一 ——
 * 早期数据可能没有 productId，也可能带 x/y 等无关字段。
 * 这里只取报价真正用得到的三个字段，缺 name 或 category 的行直接丢掉
 * （连名字都没有的行没法在报价单里出现）。
 */
export function quotePointsOf(raw: unknown): QuotePoint[] {
  if (!Array.isArray(raw)) return [];
  const out: QuotePoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const category = typeof o.category === 'string' ? o.category.trim() : '';
    if (!name || !category) continue;
    out.push({
      productId: typeof o.productId === 'string' && o.productId ? o.productId : null,
      name,
      category,
    });
  }
  return out;
}

/**
 * 由点位与产品库算报价清单。
 *
 * 匹配顺序：productId → 产品名。点位只存了 id 时按 id 匹配最准；
 * 存了 id 但产品已从库里删除时退回按名称匹配（避免整行丢失）。
 * 两边都匹配不到的单价按 0 计，**行仍然保留** ——
 * 少列一项客户会以为那台设备不用买，金额算错反而更容易被发现。
 *
 * 报价分两项，这是 2026 年主流智能家居报价单的标准结构：
 *   设备价   = 逐项单价 × 数量（能逐条核对的硬件清单）
 *   安装调试费 = 设备价 × 租户费率（默认 20%，门店可改）
 *   整包合计 = 两者之和
 * 设备价与整包价差好几倍，只报一个数必然引发纠纷。
 */
export function buildQuoteSummary(
  points: QuotePoint[] | null | undefined,
  products: QuoteProduct[] | null | undefined,
  installRate = 20,
): QuoteSummary | null {
  if (!points?.length) return null;
  const list = products ?? [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const byName = new Map(list.map((p) => [p.name, p]));

  const agg = new Map<string, QuoteItem>();
  for (const pt of points) {
    const prod = (pt.productId ? byId.get(pt.productId) : undefined) ?? byName.get(pt.name);
    // 单价口径与前端 QuoteStudio 一致：priceRetail 为 0 时回退 priceMax（见 quoteUnitPrice）
    const price = quoteUnitPrice(prod);
    const key = `${pt.category} ${pt.name}`;
    const cur = agg.get(key);
    if (cur) {
      cur.qty += 1;
      cur.subtotal = cur.qty * cur.unitPrice;
    } else {
      agg.set(key, { name: pt.name, category: pt.category, qty: 1, unitPrice: price, subtotal: price });
    }
  }

  const items = [...agg.values()];
  // 排序：按品类分组（品类按首次出现顺序），组内按小计降序
  const catOrder: string[] = [];
  for (const it of items) if (!catOrder.includes(it.category)) catOrder.push(it.category);
  items.sort((a, b) => {
    const ca = catOrder.indexOf(a.category);
    const cb = catOrder.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return b.subtotal - a.subtotal;
  });

  const total = items.reduce((s, it) => s + it.subtotal, 0);
  const rate = Math.max(0, Math.min(100, Math.round(installRate)));
  const installFee = Math.round((total * rate) / 100);
  return {
    items,
    total,
    deviceCount: items.reduce((s, it) => s + it.qty, 0),
    kindCount: items.length,
    installRate: rate,
    installFee,
    grandTotal: total + installFee,
  };
}
