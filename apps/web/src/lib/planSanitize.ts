/**
 * 客户版文案净化。
 *
 * 为什么要做：方案交付客户前，文案里混着「待确认」「资料缺口」「TBD」这类**内部语句**——
 * 客户看到"此处待现场核实"会直接当成方案没做完，是投诉源。
 *
 * 实现分三层，缺一层都会漏：
 * 1. 行级正则：命中"待办语句"的整行剔除
 * 2. 块级跳过：「待确认事项：」这种小节标题之后的整块都跳过，直到遇到「已确认：」这类结论行
 * 3. 纯占位行：「暂无」「---」这类整行占位符也要剔除（正则匹配不到）
 *
 * 被剔除的内容不是丢掉，而是原样返回给调用方，由界面折叠展示——
 * 让门店知道自己这边"还有什么没填"，而不是以为系统吃了内容。
 *
 * 设计依据：replica/audit-2026-10-13.md §7.20（记录了对照实现与两处刻意改进）
 */

/** 行级待办语句 */
const CUSTOMER_PENDING = new RegExp(
  // 「待确认」「待客户补充」「待现场核实」等
  '待\\s*(?:(?:客户|业主|现场|后续|进一步|最终|上门|到场)\\s*)*'
  + '(?:确认|补充|补齐|补|核实|核验|复核|核对|核价|报价|评估|协商|测量|定|填写|提供|沟通|完善)'
  + '|尚未(?:提供|确认|明确|确定)'
  + '|未(?:提供|确认|明确|确定|填写|核实|核验|复核)'
  + '|暂无(?:资料|数据|信息|依据|报价|预算)'
  // 注意三个否定回顾：「无需确认」「不再需要核实」是结论不是待办，不能删。
  // 常见写法只写了 (?<!无)(?<!不)，漏了「不再」——因为 lookbehind 只看紧邻的一个字符，
  // 「不再需要核实」里"需要核实"前面是"再"，保护失效，整句会被误杀。
  // 这里补上 (?<!再)，少一次误删。
  + '|(?<!无)(?<!不)(?<!再)(?:需|需要|须|尚需|仍需|有待)'
  + '(?:客户|业主|现场|后续|进一步|结合原图和现场|结合现场|再|予以|进行|具体条件|条件)*\\s*'
  + '(?:确认|核实|核验|复核|核对|补充)'
  + '|(?:确认|核实|核验)后'
  // 行尾出现「：暂无」「：不详」也算占位
  + '|[：:]\\s*(?:不详|未知|暂无|暂缺|待补|[-—–/])\\s*$'
  + '|资料缺口|待办事项|TBD|TODO|XXX',
  'i',
);

/** 进入「整块跳过」的标题行 */
const SKIP_HEADING = /^(?:待确认事项|待补充资料|内部核对)[：:]?\s*$/;

/** 结束跳过、恢复输出的结论行 */
const RESUME_HEADING = /^(?:已确认|已提供|本次优先|可选升级|预留后做|下一步)\s*[：:]/;

/** 整行都是占位符（「暂无」「未知」「---」等），正则可能匹配不到，要单独判 */
const PLACEHOLDER_ONLY = /^(?:暂无|未知|不详|待补|[-—–/])+$/;

export interface SanitizeResult {
  /** 可给客户看的正文 */
  text: string;
  /** 被剔除的原始行，供门店自己核对（界面折叠展示，不进客户版） */
  removed: string[];
}

/**
 * 把一段文案拆成「客户可见」与「内部待办」两部分。
 *
 * @param value 原始文案（字段值）
 * @param keepStructural 是否保留纯结构标签。只对「页型」放行——
 *   它是结构标签（封面/空间/场景/预算），不是给客户读的句子，过滤掉会让排版缺块。
 */
export function sanitizeForCustomer(value: unknown, keepStructural = false): SanitizeResult {
  const removed: string[] = [];
  if (keepStructural) return { text: String(value ?? '').trim(), removed };
  let skip = false;
  const kept = String(value ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      if (SKIP_HEADING.test(line.trim())) {
        skip = true;
        removed.push(line);
        return false;
      }
      if (skip) {
        if (RESUME_HEADING.test(line)) {
          skip = false;
        } else {
          if (line.trim()) removed.push(line);
          return false;
        }
      }
      const t = line.trim();
      if (CUSTOMER_PENDING.test(line) || PLACEHOLDER_ONLY.test(t)) {
        if (t) removed.push(line);
        return false;
      }
      return true;
    })
    .join('\n')
    .trim();
  return { text: kept, removed };
}

/** 只要客户可见正文时的便捷封装 */
export function customerText(value: unknown): string {
  return sanitizeForCustomer(value).text;
}
