/**
 * 浏览器端文件下载工具（2026-10-14 抽出）
 *
 * 之前 QuoteStudio 内部私有一份，LightingStudio 导出回路清单时又需要一份——
 * 同一段 8 行代码写两遍就是重复造轮子，提到 lib 共用。
 *
 * 同时提供 CSV 构造：带 UTF-8 BOM，否则 Excel 打开中文会乱码。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // 必须挂到文档里再点：不挂的话 Electron 内嵌浏览器会下载成功，
  // 但套不上 a.download 的文件名，产物变成 Downloads 下无名的
  // `.com.<bundleId>.XXXXXX` 文件（实测 PPTX 连续踩中，讲稿因体量小侥幸成功）。
  // style 设为 none 避免点击瞬间出现未排版的无名链接。
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立即 revoke 会让部分浏览器下载失败，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** CSV 单元格转义：含逗号/引号/换行时用双引号包裹，内部引号翻倍 */
export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 生成带 BOM 的 CSV 文本。
 * `rows` 第一行通常是表头；`\\uFEFF` 是 BOM，让 Excel 正确识别 UTF-8。
 */
export function csvText(rows: string[][]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** 触发 CSV 下载（自动带 BOM） */
export function downloadCsv(rows: string[][], filename: string): void {
  downloadBlob(new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' }), filename);
}
