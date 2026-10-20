/**
 * 报价单产品变体归组规则（纯函数，无 React 依赖）
 *
 * 其他产品在产品中心常按规格拆成多条记录（例如「智能面板(单火)」「智能面板(双火)」），
 * 报价时需要在同一行内换规格而不是新增一行，这里只负责把产品名解析成 family + spec，
 * 具体怎么展示、怎么替换由 QuoteStudio 决定。
 */

/** 产品名解析结果：base 为归组键，spec 为识别出的规格后缀 */
export interface VariantMeta {
  /** 归组键 = 去掉规格后的名称；base 相同即同一 family */
  key: string;
  /** 去掉规格后的名称，用于弹窗标题展示 */
  base: string;
  /** 识别出的规格后缀；为空串表示没有规格，family 就是它自己 */
  spec: string;
}

/**
 * 规格词白名单：只有末段整段命中才认为这是规格。
 * 不做「末段够短就算规格」的猜测，避免把「WiFi 网关」这类名称误拆成两个 family。
 */
const SPEC_WORDS = [
  '单火', '双火', '零火', '无火', '单火版', '双火版', '零火版',
  '白', '黑', '香槟金', '玫瑰金', '珍珠白', '曜石黑', '香槟', '银色', '金色', '灰色',
  '86型', '118型', '86盒', '118盒',
  '标准版', '基础版', '增强版', '旗舰版', '豪华版', '专业版', '迷你版',
  'pro', 'plus', 'max', 'mini', 'ultra',
];

/** 末段是否命中规格词表（拉丁字母规格按小写比较） */
function isSpecWord(word: string): boolean {
  return SPEC_WORDS.includes(word.toLowerCase());
}

/** 名称归一化：全角括号转半角、去首尾空白、合并中间多余空格 */
function normalize(name: string): string {
  return name.replace(/（/g, '(').replace(/）/g, ')').trim().replace(/\s+/g, ' ');
}

/**
 * 反复剥离名称尾部的括号组：`面板(单火)(白色)` → base `面板`、spec `单火 / 白色`。
 * 多个括号全部并入 spec，才能和只写一层括号的兄弟产品归到同一 family。
 */
function splitBrackets(name: string): { base: string; spec: string } {
  let rest = name;
  const specs: string[] = [];
  for (;;) {
    const m = rest.match(/^(.+?)\s*\(\s*([^()]+?)\s*\)\s*$/);
    if (!m) break;
    rest = m[1].trim();
    specs.unshift(m[2]);
  }
  return specs.length ? { base: rest, spec: specs.join(' / ') } : { base: rest, spec: '' };
}

/** 解析产品名：先看尾部括号，再看「分隔符 + 白名单规格词」；都没有则 family 就是自己 */
export function variantMeta(name: string): VariantMeta {
  const raw = normalize(name);
  if (!raw) return { key: '', base: '', spec: '' };
  const byBracket = splitBrackets(raw);
  if (byBracket.spec) return { key: byBracket.base, base: byBracket.base, spec: byBracket.spec };
  // 规格词要求整段命中；单字规格（白/黑）只在用短横线之类分隔时才认，裸空格太容易误伤
  const m = raw.match(/^(.+?)([\s\-/·、]+)(\S{1,10})$/);
  if (m && isSpecWord(m[3]) && (m[3].length >= 2 || /[-\/·、]/.test(m[2]))) {
    return { key: m[1].trim(), base: m[1].trim(), spec: m[3] };
  }
  return { key: raw, base: raw, spec: '' };
}

/**
 * 把产品按 family 归组。
 * 只保留成员数大于 1 的组：单人 family 没有「换规格」的意义，也不该出现在弹窗里。
 */
export function variantGroups<T extends { name: string }>(products: T[]): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const p of products) {
    const key = variantMeta(p.name).key;
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }
  const multi = new Map<string, T[]>();
  for (const [key, list] of buckets) if (list.length > 1) multi.set(key, list);
  return multi;
}

/** 某产品所在 family 的全部变体（含自己）；不属于任何多成员 family 时返回空数组 */
export function variantFamily<T extends { name: string }>(groups: Map<string, T[]>, product: T): T[] {
  return groups.get(variantMeta(product.name).key) ?? [];
}

/** 可切换到的其它变体（不含自己）；为空表示这一行没有「换规格」 */
export function variantSiblings<T extends { name: string }>(groups: Map<string, T[]>, product: T): T[] {
  return variantFamily(groups, product).filter((p) => p.name !== product.name);
}
