/**
 * 方案页的共用纯函数：预览（PlanSlide）与导出（planPptx）必须算出一模一样的结果。
 *
 * 为什么单独抽一份：
 * `parseBudget` / `parseStages` / `fmt` 此前在 `lib/planPptx.ts` 与
 * `components/PlanSlide.tsx` 里**逐字重复**（parseBudget 只差一行类型标注）。
 * 两份实现改一处忘另一处，就会出现「门店在页面上看到的金额与导出 PPTX 的金额对不上」
 * —— 客户拿着 PPT 去比价，差一分钱就是交付事故。
 *
 * 这里只放**纯函数**：不碰 React、不碰 DOM、不碰网络，
 * 于是预览端与导出端可以各自 import 同一份，两边永远跑偏不了。
 */

/** 预算页要点解析出来的分项（"分项名：下限-上限"） */
export interface BudgetItem {
  name: string;
  min: number;
  max: number;
}

/**
 * 解析预算页要点"分项名：下限-上限"为图表数据；无法解析的退回普通要点。
 *
 * 口径（预览与导出必须一致）：
 * - 每一条都要匹配「名字：数字-数字」，有一条不匹配就整体放弃（返回 null）
 * - 下限/上限必须是正数
 * - 至少两条才成图表（一条画不出对比）
 */
export function parseBudget(bullets: string[]): BudgetItem[] | null {
  const items: BudgetItem[] = [];
  for (const b of bullets) {
    const m = b.match(/^(.+?)\s*[：:]\s*([\d,]+)\s*[-–~]\s*([\d,]+)/);
    if (!m) return null;
    const min = Number(m[2].replace(/,/g, ''));
    const max = Number(m[3].replace(/,/g, ''));
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return null;
    items.push({ name: m[1].trim(), min, max });
  }
  return items.length >= 2 ? items : null;
}

/**
 * 解析交付页要点为流程步骤：去前导编号，首段为名称，其余（含子标题）归入说明。
 *
 * 至少三条才成时间轴（两步画不出"流程"），最多取前 6 步。
 */
export function parseStages(bullets: string[]): { name: string; desc: string }[] | null {
  const stages = bullets.map((b) => {
    const cleaned = b.replace(/^\s*0?\d{1,2}\s*[.、::｜|]?\s*/, '');
    const idx = cleaned.search(/[｜|：:]/);
    if (idx < 0) return { name: cleaned.trim(), desc: '' };
    return { name: cleaned.slice(0, idx).trim(), desc: cleaned.slice(idx + 1).replace(/[｜|]/g, ' ').trim() };
  });
  const ok = stages.filter((s) => s.name && s.desc);
  return ok.length >= 3 ? ok.slice(0, 6) : null;
}

/** 金额简写：满万显示"X万"，其余原样 */
export function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万` : `${n}`;
}
