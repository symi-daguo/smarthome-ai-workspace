import { Injectable } from '@nestjs/common';

/**
 * 交付前预检闸门（`canGenerate` + `warnings[]`）。
 *
 * 判定规则在服务端、前端只读结论，所以本服务是**唯一判定方**：
 * 前端渲染它返回的 warnings，Agent 也能直接调它做自动核对。
 *
 * 检测什么：逐页扫内部待办语句。「待确认」「暂无资料」「TBD」这类内容混进交付物，
 * 客户看到"此处待现场核实"会直接当成方案没做完 —— 静默净化掉又会让人以为系统吃了内容，
 * 所以正确做法是**明确告诉用户第几页有问题**，让他决定改还是删。
 *
 * 与前端 `lib/planSanitize.ts` 的关系：那边负责**净化**（生成客户版正文），
 * 这边负责**报出位置**（哪一页哪个字段有问题）。两边的正则必须同规则，
 * 否则会出现「净化没删但预检报了」或反过来的不一致 —— 所以下方注释里逐条写明
 * 规则来源与两处刻意改进，改动必须两边同步。
 */

export interface PreflightWarning {
  /** 页号，0-based，与 pages 数组一致（对外展示时 +1） */
  index: number;
  /** 页标题，方便门店直接定位 */
  heading: string;
  /** 命中字段：heading / subtitle / bullets / body / narration / quote */
  field: string;
  /** 命中的原文片段（截断，便于判断严重程度） */
  snippet: string;
}

export interface PreflightResult {
  /** 是否可以交付。无内部语句且页数非 0 才为 true */
  canDeliver: boolean;
  pageCount: number;
  warnings: PreflightWarning[];
}

/** 单条上限：逐条报会让界面变成刷屏，且一页里同一句反复出现没有信息量 */
const MAX_WARNINGS_PER_PAGE = 6;
/** 片段截断长度 */
const SNIPPET_MAX = 60;

/**
 * 行级待办语句。
 * 与 `lib/planSanitize.ts` 的 CUSTOMER_PENDING 同规则，含那里的两处刻意改进：
 * 1. 三个否定回顾「无需确认」「不再需要核实」「不需核实」是结论不是待办，不能报。
 *    常见写法只写了 (?<!无)(?<!不)，漏了「不再」——lookbehind 只看紧邻一个字符，
 *    「不再需要核实」里「需要核实」前面是「再」，保护失效，整句会被误判。
 * 2. 行尾「：暂无」「：不详」也算占位。
 */
const PENDING = new RegExp(
  '待\\s*(?:(?:客户|业主|现场|后续|进一步|最终|上门|到场)\\s*)*'
  + '(?:确认|补充|补齐|补|核实|核验|复核|核对|核价|报价|评估|协商|测量|定|填写|提供|沟通|完善)'
  + '|尚未(?:提供|确认|明确|确定)'
  + '|未(?:提供|确认|明确|确定|填写|核实|核验|复核)'
  + '|暂无(?:资料|数据|信息|依据|报价|预算)'
  + '|(?<!无)(?<!不)(?<!再)(?:需|需要|须|尚需|仍需|有待)'
  + '(?:客户|业主|现场|后续|进一步|结合原图和现场|结合现场|再|予以|进行|具体条件|条件)*\\s*'
  + '(?:确认|核实|核验|复核|核对|补充)'
  + '|(?:确认|核实|核验)后'
  + '|[：:]\\s*(?:不详|未知|暂无|暂缺|待补|[-—–/])\\s*$'
  // 「待办事项」「资料缺口」这类词本身要防否定：门店常写「本页无待办事项，全部已确认」，
  // 不加保护会把这句原样判成有问题 —— 预检一旦误报，门店就不会再信它了。
  // 「没有待办事项」的前两字是「没有」，lookbehind 只看紧邻一个字符，必须单独排一次。
  + '|(?<!无)(?<!没有)(?<!不含)(?:资料缺口|待办事项)'
  + '|(?<!无)(?<!没有)TBD'
  + '|TODO|XXX',
  'i',
);

/** 进入「整块跳过」的标题行：它之后到 RESUME_HEADING 之前整块都是内部待办 */
const SKIP_HEADING = /^(?:待确认事项|待补充资料|内部核对)[：:]?\s*$/;
/** 结束跳过、恢复输出的结论行 */
const RESUME_HEADING = /^(?:已确认|已提供|本次优先|可选升级|预留后做|下一步)\s*[：:]/;
/** 整行都是占位符（「暂无」「未知」「---」等） */
const PLACEHOLDER_ONLY = /^(?:暂无|未知|不详|待补|[-—–/])+$/;

/**
 * 紧邻的重复词组（模型偶发的叠字错误）。
 *
 * 实测案例：模型把 quote「装好只是开始，会用才是交付」的句式套进 heading，
 * 生成出「落地交付｜从方案确认到会用会用」—— 客户一眼看到就怀疑整份方案没走心。
 *
 * 判据要精确，否则误报比漏报更伤：
 * 1. 重复组是**两个字**（3 字组会误伤「一步一步」这类正常表达）；
 * 2. 组内两个字**不同**（「看看」「好好」「谢谢」是叠词，放过；「会用」不是）；
 * 3. 重复组紧邻出现，中间没有标点或空格。
 *
 * 已知局限：「一步一步」与「会用会用」在字符层面同构，规则区分不了 ——
 * 只能靠白名单把前者列出来。**取舍是宁可漏报也不误报**：
 * 预检一旦误报，门店就不信它了；漏报一条，用户在逐页校对时看一眼就发现了。
 */
const REPEATED_BIGRAM = /([\u4e00-\u9fa5]{2})\1/g;

/**
 * 合法的双字重复组（正常表达，不算错误）。
 * 键是重复的那两个字。
 */
const REPEAT_ALLOWLIST = new Set([
  '一步', '一一', '天天', '人人', '家家', '日日', '月月', '年年', '处处', '事事',
  '各各', '分分', '点点', '些些', '件件', '条条', '次次', '遍遍', '样样', '种种',
  '多多', '少少', '好好', '很好', '看看', '想想', '说说', '听听', '尝尝', '试试', '走走',
  '坐坐', '聊聊', '玩玩', '动动', '等等', '常常', '往往', '渐渐', '刚刚', '恰恰',
  '偏偏', '单单', '仅仅', '默默', '暗暗', '悄悄', '深深', '远远', '频频', '连连',
  '桩桩', '笔笔', '句句', '字字', '声声', '念念', '历历',
]);

/** 需要逐字段检查的文本字段 */
const TEXT_FIELDS = ['heading', 'subtitle', 'body', 'narration', 'quote'] as const;

interface PlanPageLike {
  type?: string;
  heading?: string;
  subtitle?: string;
  bullets?: string[] | null;
  body?: string;
  narration?: string;
  quote?: string;
}

@Injectable()
export class PlanPreflightService {
  /**
   * 逐页扫描内部待办语句。
   * 与净化侧一致，同样分三层：行级正则 / 整块跳过 / 纯占位行 ——
   * 少一层就会漏报或误报。
   */
  inspect(pages: unknown): PreflightResult {
    const list = Array.isArray(pages) ? (pages as PlanPageLike[]) : [];
    const warnings: PreflightWarning[] = [];

    for (let i = 0; i < list.length; i += 1) {
      const page = list[i] ?? {};
      const hit = (field: string, text: unknown): void => {
        if (warnings.filter((w) => w.index === i).length >= MAX_WARNINGS_PER_PAGE) return;
        const snippet = this.findSnippet(text);
        if (snippet) {
          warnings.push({ index: i, heading: page.heading ?? `第 ${i + 1} 页`, field, snippet });
        }
      };

      for (const f of TEXT_FIELDS) hit(f, page[f]);
      for (const b of page.bullets ?? []) hit('bullets', b);
    }

    return {
      canDeliver: list.length > 0 && warnings.length === 0,
      pageCount: list.length,
      warnings,
    };
  }

  /** 在一段文本里找出第一处待办语句，返回截断后的片段；没有则返回 null */
  private findSnippet(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const lines = value.split(/\r?\n/);
    let skipping = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (skipping) {
        if (RESUME_HEADING.test(line)) skipping = false;
        continue;
      }
      if (SKIP_HEADING.test(line)) {
        skipping = true;
        // 标题本身也是内部语句，单独报一条
        return this.clip(line);
      }
      if (PLACEHOLDER_ONLY.test(line)) return this.clip(line);
      if (PENDING.test(line)) return this.clip(line);
      const dup = this.findRepeatedBigram(line);
      if (dup) return this.clip(dup);
    }
    return null;
  }

  /**
   * 找出一处「紧邻重复的双字词组」，返回带上下文的片段；没有则返回 null。
   *
   * 组内两字相同（看看/好好/谢谢）时放过 —— 那是叠词，不是错误。
   */
  private findRepeatedBigram(line: string): string | null {
    REPEATED_BIGRAM.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REPEATED_BIGRAM.exec(line)) !== null) {
      const gram = m[1];
      // 「一步一步」这类：组内两字不同但整体是正常词，规则区分不了 —— 放过。
      // 只报「组内两字相同」之外、且重复的是**明显不成词**的情况由下方白名单兜底。
      if (gram[0] === gram[1]) continue;
      // 常见正常叠词/固定搭配：这些是合法表达，误报会让预检失去可信度
      if (REPEAT_ALLOWLIST.has(gram)) continue;
      const start = Math.max(0, m.index - 6);
      const end = Math.min(line.length, m.index + gram.length * 2 + 6);
      return line.slice(start, end);
    }
    return null;
  }

  private clip(s: string): string {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > SNIPPET_MAX ? `${one.slice(0, SNIPPET_MAX)}…` : one;
  }
}
