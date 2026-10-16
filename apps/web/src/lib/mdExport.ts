/**
 * 把 AI 回复导出为 Markdown / Word。
 *
 * 三个坑都在实现里，必须照着原样做，不能"简化"：
 *
 * 1. **Word 文件必须加 BOM**（`﻿`）。不加的话 Word 会按本地编码读，
 *    中文全是乱码——这是导出 Word 最常见的投诉来源。
 * 2. **先转义 HTML 再替换标签**。顺序反了就成了注入漏洞：
 *    模型返回的内容里如果有 `<script>`，先替换标签的话会被当 HTML 执行。
 * 3. **Word 命名空间** `xmlns:o` / `xmlns:w` 不能少，
 *    少了 Word 只会当成普通网页打开，排版全丢。
 *
 * 参考实现：platform.gougezn.com `app.js:1436-1482`（2026-10-16 REA 复核）
 */
import { downloadBlob } from './download';

/** HTML 转义。导出路径上唯一的注入防线，必须在标签替换之前调用 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 文件名时间戳：YYYYMMDD-HHmm，精确到分钟 */
export function fileStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Markdown 文本 → Word 可直接打开的 HTML（存为 .doc） */
export function contentToWordHtml(text: string): string {
  const body = escapeHtml(text)
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replaceAll('\n', '<br />');
  return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'></head><body style="font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.8;color:#222;">${body}</body></html>`;
}

/** 导出 Markdown（原文） */
export function downloadMarkdown(content: string, prefix = '智能体内容'): void {
  downloadBlob(new Blob([content], { type: 'text/markdown;charset=utf-8' }), `${prefix}-${fileStamp()}.md`);
}

/** 导出 Word。开头那个 BOM 是给 Word 认 UTF-8 用的，别删 */
export function downloadWord(content: string, prefix = '智能体内容'): void {
  downloadBlob(new Blob(['﻿' + contentToWordHtml(content)], { type: 'application/msword' }), `${prefix}-${fileStamp()}.doc`);
}
