/**
 * 预算分配建议：生态占比与分摊算式。
 *
 * 为什么独立成纯 TS 模块（而不是留在 `pages/PlanStudio.tsx` 里）：
 * 分摊算式**必须能被一条可运行的检查直接断言**。
 *
 * 它曾经写成 `budgetTotal * percent * 10 / 10` —— `percent` 是**百分数**
 * （22 表示 22%），却按 `* 10` 算，结果差 100 倍：
 * 预算 13 万时「安防 22%」显示成 286 万，
 * 界面上的「合计 / 预算」会凭空多出 1700 万，
 * 而且这个错值会**落库**、还会作为生成提示词的硬约束传给模型。
 *
 * `.tsx` 带 JSX，Node 里 import 不了 —— 这类纯算式必须放在纯 TS 模块里，
 * 才谈得上「一条可运行的检查兜住」。
 */

/** 生态建议占比（合计 100%），用于预算分配建议条 */
export const ECOSYSTEM_SPLIT = [
  { key: 'security', name: '安防', percent: 22, color: '#4A90D9' },
  { key: 'lighting', name: '灯光', percent: 24, color: '#E8A33D' },
  { key: 'shading', name: '遮阳', percent: 10, color: '#7C9E6B' },
  { key: 'media', name: '影音', percent: 18, color: '#9A6BC9' },
  { key: 'hvac', name: '暖通', percent: 14, color: '#4FB0A5' },
  { key: 'network', name: '网络', percent: 12, color: '#C96B6B' },
];

/**
 * 预算分配建议的解析值：门店改过的用覆盖值，其余按建议占比算。
 *
 * 「解析」这一步只此一处，提交给后端的就是门店在建议条上看到的金额 ——
 * 算两遍就会出现「界面一个数、库里另一个数」。
 *
 * 单位与口径（**percent 是百分数**，22 表示 22%）：
 *   预算 13 万、安防占 22% → 13 × 22 / 100 = 2.86 → 取 0.1 万精度 = **2.9 万**。
 * 保留 1 位小数是因为这个单位是「万元」，0.1 万 = 1000 元；
 * 比到元更细没有意义，反而会让门店觉得数字在跳。
 */
export function splitAmount(
  percent: number,
  override: number | null | undefined,
  budgetTotal: number | null,
): number {
  if (override !== null && override !== undefined) return override;
  if (budgetTotal === null) return 0;
  return Math.round((budgetTotal * percent) / 100 * 10) / 10;
}

/**
 * 建议条的一行：占比 + 解析出来的金额。
 * 界面渲染与提交映射共用同一份算式，避免「界面一个数、库里另一个数」。
 */
export interface SplitRow {
  key: string;
  name: string;
  percent: number;
  color: string;
  /** 解析后的金额（万元） */
  value: number;
}

/** 生成建议条各行（门店改过的用覆盖值，其余按占比算） */
export function splitRows(
  overrides: Record<string, number | null | undefined>,
  budgetTotal: number | null,
): SplitRow[] {
  return ECOSYSTEM_SPLIT.map((row) => ({
    ...row,
    value: splitAmount(row.percent, overrides[row.key], budgetTotal),
  }));
}

/**
 * 提交给后端的「生态中文名 → 金额（万元）」映射。
 *
 * 键用**中文名**而不是内部 key：这份数据要直接进生成提示词、也要让 Agent 读得懂；
 * 前后端各抄一份生态清单必然漂移，所以生态清单只有这一份来源。
 */
export function buildBudgetSplit(
  overrides: Record<string, number | null | undefined>,
  budgetTotal: number | null,
): Record<string, number> {
  return Object.fromEntries(
    splitRows(overrides, budgetTotal).map((row) => [row.name, row.value]),
  );
}
