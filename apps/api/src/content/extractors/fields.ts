import type { Deficiency, DocType, ExtractedFieldValue, NormalizedText } from './types.js';

/**
 * 文档类型 -> 必需字段集（完整性校验基线）。
 * key 同时作为 LLM 结构化抽取的字段名，保持前后端一致。
 */
export interface FieldSpec {
  key: string;
  label: string;
  required: boolean;
}

export const FIELD_SPECS: Record<DocType, FieldSpec[]> = {
  product: [
    { key: 'name', label: '产品名称', required: true },
    { key: 'model', label: '型号', required: true },
    { key: 'price', label: '价格', required: true },
    { key: 'specs', label: '规格参数', required: true },
    { key: 'sellingPoints', label: '核心卖点', required: true },
  ],
  meeting: [
    { key: 'topic', label: '会议主题', required: true },
    { key: 'time', label: '时间', required: true },
    { key: 'participants', label: '参会人', required: false },
    { key: 'decisions', label: '关键结论', required: true },
    { key: 'todos', label: '待办事项', required: false },
  ],
  generic: [{ key: 'summary', label: '内容摘要', required: true }],
};

// 置信度：结构化字段中规则命中文本为 85，LLM 抽取为 90，用户确认补全后为 100
const RULE_CONFIDENCE = 85;

interface RulePattern {
  key: string;
  patterns: RegExp[];
}

/** 从中文正文里按字段标签/常见写法提取值的规则集 */
const PRODUCT_RULES: RulePattern[] = [
  {
    key: 'model',
    patterns: [
      /(?:产品型号|型号|Model)[:：]\s*([A-Za-z0-9][A-Za-z0-9\-_/]{1,40})/,
      /\b([A-Z]{1,4}[-–]?\d{2,5}[A-Za-z0-9\-]{0,20})\b/,
    ],
  },
  {
    key: 'price',
    patterns: [
      /(?:售价|价格|报价|指导价|零售价)[:：]?\s*[¥￥]?\s*([0-9][0-9,]*(?:\.\d{1,2})?\s*(?:元|万|块)?)/,
      /[¥￥]\s*([0-9][0-9,]*(?:\.\d{1,2})?)/,
    ],
  },
];

const MEETING_RULES: RulePattern[] = [
  {
    key: 'time',
    patterns: [
      /(?:会议时间|时间)[:：]\s*([0-9]{4}[-/年][0-9]{1,2}[-/月][0-9]{1,2}日?(?:\s+[0-9:：]{4,5})?)/,
      /\b([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:\s+[0-9:]{4,5})?)\b/,
    ],
  },
  {
    key: 'participants',
    patterns: [/(?:参会人|参会人员|与会人员)[:：]\s*([^\n。；;]{2,120})/],
  },
];

function pickFirst(content: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = content.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** 切分正文里的短句（用于摘要/卖点候选） */
function firstSentences(content: string, max = 120): string {
  const compact = content.replace(/[ \t]+/g, ' ').trim();
  const parts = compact.split(/[。\n；;]/).map((s) => s.trim()).filter(Boolean);
  return (parts[0] ?? compact.slice(0, max)).slice(0, max);
}

/**
 * 规则抽取：对三源均生效的保底通道，P3 会在其结果上用 LLM 覆盖增强。
 * 不信任输入中的任何 HTML/脚本，调用方负责在适配层剥离。
 */
export function ruleExtract(doc: NormalizedText, docType: DocType): Map<string, ExtractedFieldValue> {
  const fields = new Map<string, ExtractedFieldValue>();
  const specs = FIELD_SPECS[docType];
  const put = (key: string, value: string | null, confidence = RULE_CONFIDENCE): void => {
    if (!value) return;
    const spec = specs.find((s) => s.key === key);
    if (!spec || fields.has(key)) return;
    fields.set(key, { key, label: spec.label, value: value.slice(0, 500), required: spec.required, confidence });
  };

  if (docType === 'product') {
    for (const rule of PRODUCT_RULES) put(rule.key, pickFirst(doc.content, rule.patterns));
    put('name', doc.title || firstSentences(doc.content, 60), 80);
    put('specs', pickFirst(doc.content, [/(?:规格|参数|配置)[:：]\s*([^\n]{4,200})/]), 80);
    put(
      'sellingPoints',
      pickFirst(doc.content, [/(?:卖点|核心卖点|产品亮点|优势)[:：]\s*([^\n]{4,300})/]) ?? firstSentences(doc.content),
      75,
    );
  } else if (docType === 'meeting') {
    for (const rule of MEETING_RULES) put(rule.key, pickFirst(doc.content, rule.patterns));
    put('topic', doc.title || pickFirst(doc.content, [/(?:会议主题|主题)[:：]\s*([^\n。；;]{2,80})/]), 85);
    put(
      'decisions',
      pickFirst(doc.content, [/(?:会议结论|关键结论|决议|结论)[:：]\s*([^\n]{4,400})/]) ?? firstSentences(doc.content),
      75,
    );
    put('todos', pickFirst(doc.content, [/(?:待办|后续行动|行动项)[:：]\s*([^\n]{4,400})/]), 80);
  } else {
    put('summary', firstSentences(doc.content, 200), 80);
  }

  return fields;
}

/** 按必需字段集核对缺失项，产出 deficiency 列表 */
export function assessDeficiencies(
  docType: DocType,
  fields: Map<string, ExtractedFieldValue>,
): Deficiency[] {
  const result: Deficiency[] = [];
  for (const spec of FIELD_SPECS[docType]) {
    const got = fields.get(spec.key)?.value.trim();
    if (spec.required && !got) {
      result.push({ fieldKey: spec.key, label: spec.label, reason: `必需字段「${spec.label}」未从内容中识别，请人工确认补全` });
    }
  }
  return result;
}

/** 质量评分：必填完整率 70% + 已提取字段平均置信度 30%，四舍五入为整数 */
export function scoreQuality(docType: DocType, fields: Map<string, ExtractedFieldValue>): number {
  const specs = FIELD_SPECS[docType];
  const required = specs.filter((s) => s.required);
  const filledRequired = required.filter((s) => fields.get(s.key)?.value.trim()).length;
  const coverage = required.length === 0 ? 1 : filledRequired / required.length;

  const extracted = [...fields.values()].filter((f) => f.value.trim());
  const avgConfidence =
    extracted.length === 0 ? 0 : extracted.reduce((sum, f) => sum + f.confidence, 0) / extracted.length / 100;

  return Math.round(coverage * 70 + avgConfidence * 30);
}
