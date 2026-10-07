/**
 * S2 内容提取管道统一类型
 * 三源（上传/网页/纪要）适配器都输出 NormalizedText，由规则+LLM 完成字段抽取与质检
 */

export type DocType = 'product' | 'meeting' | 'generic';

/** 适配器输出的标准化文本块 */
export interface NormalizedText {
  title: string;
  content: string;
  /** 来源可引用性：文件直读=100，网页正文=90，LLM 推断视字段而定 */
  baseConfidence: number;
  meta?: Record<string, string>;
}

export interface ExtractedFieldValue {
  key: string;
  label: string;
  value: string;
  required: boolean;
  confidence: number;
}

export interface Deficiency {
  fieldKey: string;
  label: string;
  reason: string;
}

export interface ExtractionResult {
  docType: DocType;
  title: string;
  content: string;
  fields: ExtractedFieldValue[];
  deficiencies: Deficiency[];
  /** 0-100 质量评分 */
  score: number;
}

/** 管道输入 */
export interface ExtractInput {
  source: 'UPLOAD' | 'URL' | 'TRANSCRIPT';
  sourceRef: string;
  docType: DocType;
  /** 文本/纪要源直接给出正文；上传源给出文件 Buffer */
  text?: string;
  file?: { buffer: Buffer; originalName: string; mimeType: string };
}
