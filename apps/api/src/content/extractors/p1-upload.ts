import mammoth from 'mammoth';
import { JSDOM } from 'jsdom';
import type { NormalizedText } from './types.js';

const MAX_CONTENT_CHARS = 200_000;

/** 取 Node Buffer 的独立 ArrayBuffer 副本（规避 Buffer pool 偏移与跨版本类型差异） */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function cleanText(html: string): string {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const text = dom.window.document.getElementById('root')?.textContent ?? '';
  dom.window.close();
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function parseDocx(buffer: Buffer): Promise<{ title: string; content: string }> {
  const raw = await mammoth.extractRawText({ arrayBuffer: toArrayBuffer(buffer) });
  const content = raw.value.slice(0, MAX_CONTENT_CHARS);
  const title = content.split('\n').map((l) => l.trim()).find(Boolean) ?? 'DOCX 文档';
  return { title: title.slice(0, 100), content };
}

async function parseXlsx(buffer: Buffer): Promise<{ title: string; content: string }> {
  // exceljs 体积较大且仅 XLSX 需要，动态引入缩短冷启动
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  // exceljs 内置旧版 @types/node 的 Buffer 类型，与项目 Buffer<ArrayBufferLike> 名义不兼容；
  // 运行时按 Uint8Array 视图读取，直接传 Buffer 即可
  await workbook.xlsx.load(buffer as unknown as Uint8Array as never);

  const lines: string[] = [];
  workbook.eachSheet((sheet) => {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = (row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)));
      if (cells.some((c) => c.trim())) lines.push(cells.join(' | '));
    });
    lines.push('');
  });
  const content = lines.join('\n').slice(0, MAX_CONTENT_CHARS);
  return { title: workbook.worksheets[0]?.name ?? 'XLSX 表格', content };
}

async function parsePdf(buffer: Buffer): Promise<{ title: string; content: string }> {
  // Node ESM 环境使用 legacy 构建，禁用 worker
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(toArrayBuffer(buffer)), useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 200); i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    pages.push(textContent.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  const content = pages.join('\n').slice(0, MAX_CONTENT_CHARS);
  return { title: content.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 100) ?? 'PDF 文档', content };
}

/** P1 上传资料解析：TXT/MD 原生、DOCX/XLSX/PDF 走专用适配器，输出前做脚本剥离 */
export async function parseUploadedFile(input: {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}): Promise<NormalizedText> {
  const ext = input.originalName.split('.').pop()?.toLowerCase() ?? '';
  const nameWithoutExt = input.originalName.replace(/\.[^.]+$/, '');

  let parsed: { title: string; content: string };
  if (ext === 'docx' || input.mimeType.includes('word')) {
    parsed = await parseDocx(input.buffer);
  } else if (ext === 'xlsx' || input.mimeType.includes('spreadsheet')) {
    parsed = await parseXlsx(input.buffer);
  } else if (ext === 'pdf' || input.mimeType.includes('pdf')) {
    parsed = await parsePdf(input.buffer);
  } else if (ext === 'html' || ext === 'htm') {
    parsed = { title: nameWithoutExt, content: cleanText(input.buffer.toString('utf-8')) };
  } else {
    // txt / md / csv / json 等纯文本
    const decoded = input.buffer.toString('utf-8').slice(0, MAX_CONTENT_CHARS);
    parsed = { title: nameWithoutExt || '文本文档', content: cleanText(decoded) };
  }

  if (!parsed.content) {
    throw new Error('UNSUPPORTED_OR_EMPTY_FILE: 文件无法解析或内容为空（支持 TXT/MD/DOCX/XLSX/PDF/HTML）');
  }

  return {
    title: parsed.title,
    content: parsed.content,
    baseConfidence: 100,
    meta: { fileName: input.originalName, fileType: ext || input.mimeType },
  };
}
