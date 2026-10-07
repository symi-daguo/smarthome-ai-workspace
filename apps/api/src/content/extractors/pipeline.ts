import { Logger } from '@nestjs/common';
import type { LlmService } from '../../llm/llm.service.js';
import { FIELD_SPECS, assessDeficiencies, ruleExtract, scoreQuality } from './fields.js';
import { parseUploadedFile } from './p1-upload.js';
import { parseWebPage } from './p2-url.js';
import { parseTranscript } from './p3-transcript.js';
import type { DocType, ExtractInput, ExtractionResult, NormalizedText } from './types.js';

const logger = new Logger('ExtractionPipeline');

/**
 * 统一管道：三源输入 -> NormalizedText -> 字段抽取（规则 + LLM 增强）
 * -> 完整性校验 -> 质量评分。所有外部内容均视为不可信，LLM 结果仅按
 * 预置字段白名单接收，其余键丢弃。
 */
export async function runExtraction(input: ExtractInput, llm?: LlmService): Promise<ExtractionResult> {
  let doc: NormalizedText;
  if (input.source === 'UPLOAD') {
    if (!input.file) throw new Error('FILE_REQUIRED');
    doc = await parseUploadedFile(input.file);
  } else if (input.source === 'URL') {
    doc = await parseWebPage(input.sourceRef);
  } else {
    if (!input.text?.trim()) throw new Error('TRANSCRIPT_TEXT_REQUIRED');
    doc = parseTranscript({ title: input.sourceRef, text: input.text });
  }

  const docType: DocType = input.docType;
  const fields = ruleExtract(doc, docType);

  // P3 纪要优先走 LLM 结构化；key 未配置/失败时静默降级规则结果
  if (input.source === 'TRANSCRIPT' && llm?.isConfigured()) {
    try {
      const specs = FIELD_SPECS[docType];
      const specHint = specs.map((s) => `"${s.key}"(${s.label})`).join('、');
      const llmFields = await llm.chatObject<Record<string, string>>({
        systemPrompt: `你是信息抽取引擎。从用户提供的${docType === 'meeting' ? '对话/会议纪要' : '文本'}中抽取字段：${specHint}。`,
        prompt: doc.content.slice(0, 12_000),
      });
      for (const spec of specs) {
        const value = llmFields[spec.key]?.trim();
        if (value) {
          fields.set(spec.key, { key: spec.key, label: spec.label, value: value.slice(0, 500), required: spec.required, confidence: 90 });
        }
      }
    } catch (error) {
      logger.warn(`LLM 纪要抽取失败，使用规则结果: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    docType,
    title: doc.title,
    content: doc.content,
    fields: [...fields.values()],
    deficiencies: assessDeficiencies(docType, fields),
    score: scoreQuality(docType, fields),
  };
}
