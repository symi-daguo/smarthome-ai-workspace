/**
 * 报价附加费用的计算（纯函数，无 React 依赖）。
 *
 * 单独抽出来有两个理由：
 * 1. 涉及金额，正确性必须能用实测数字验证，而不是靠肉眼看界面；
 * 2. 百分比、fixed、none 三种模式的取值规则集中在一处，避免界面和导出各算一遍算出两个数。
 */

export type FeeMode = 'fixed' | 'percent' | 'none';

export interface FeeItem {
  name: string;
  mode: FeeMode;
  /** fixed 时为金额（元）；percent 时为百分比数值（如 3 表示 3%） */
  amount: number;
}

/** 常用费用模板：门店实际高频项 */
export const FEE_TEMPLATES: { name: string; amount: number | null }[] = [
  { name: '系统对接服务费用', amount: null },
  { name: '运输费', amount: null },
  { name: '上门安装费', amount: 200 },
  { name: '综合布线费', amount: 500 },
  { name: '系统调试费', amount: 300 },
];

/** 单项费用金额。base = 设备小计（百分比计费的基数） */
export function feeAmount(f: FeeItem, base: number): number {
  if (f.mode === 'none') return 0;
  if (f.mode === 'percent') return (base * f.amount) / 100;
  return f.amount;
}

/** 费用合计 */
export function feesTotal(fees: FeeItem[], base: number): number {
  return fees.reduce((s, f) => s + feeAmount(f, base), 0);
}
