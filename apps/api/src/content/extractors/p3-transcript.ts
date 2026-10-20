import type { NormalizedText } from './types.js';

/**
 * P3 对话纪要：用户直接粘贴纪要原文，结构化字段由管道编排层调用
 * LLM function calling（JSON）完成；原文本身为可信用户输入，仅做长度收口。
 */
export function parseTranscript(input: { title?: string; text: string }): NormalizedText {
  const content = input.text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').slice(0, 200_000);
  const title =
    input.title?.trim() ||
    content.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 100) ||
    '对话纪要';
  return { title, content, baseConfidence: 100, meta: { source: 'transcript' } };
}
