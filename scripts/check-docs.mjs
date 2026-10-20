/**
 * GitHub Markdown（GFM）友好性检查。
 *
 * 「文档在编辑器里看着正常，渲染到 GitHub 上就乱了」是开源仓库最常见的低级问题。
 * 这里自动查四类最容易出问题的：
 *
 *   1. 相对链接指向的文件/锚点是否真的存在（GitHub 上点不开最劝退）
 *   2. 表格的列数是否一致（列数不齐 GitHub 不会报错，但会渲染成一团乱麻）
 *   3. 代码块是否成对闭合（漏一个 ``` 后面全文都变成代码块）
 *   4. 标题层级是否跳跃（h1 → h3，中间没有 h2）
 *
 * 用法：node scripts/check-docs.mjs [仓库根目录]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
let problems = 0;
const report = (file, msg) => {
  problems += 1;
  console.log(`FAIL ${file}: ${msg}`);
};

/** 递归收集所有 md（跳过依赖与产物目录）；只收 git 已跟踪的，保证检查的就是会入库的那批 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'release', 'runtime', '.next', 'coverage', 'replica'].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 取 markdown 里所有链接的目标（跳过 http/mailto/锚点） */
function linksOf(text) {
  const out = [];
  // 行内链接与图片
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]);
  // 引用式链接定义
  for (const m of text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) out.push(m[1]);
  return out;
}

/** 生成标题锚点（GitHub 的 slug 规则近似） */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

for (const file of collect(ROOT)) {
  const rel = file.replace(`${ROOT}/`, '');
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // --- 1. 代码块闭合 ---
  let fence = null;
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (!m) continue;
    const marker = m[1][0];
    if (fence === null) fence = { marker, line: i + 1 };
    else if (marker === fence.marker) fence = null;
  }
  if (fence) report(rel, `代码块未闭合（始于第 ${fence.line} 行）`);

  // --- 2. 表格列数一致 ---
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*\|.*\|\s*$/.test(line)) continue;
    // 表头下一行必须是分隔行
    const next = lines[i + 1] ?? '';
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(next)) continue;
    // GFM 里单元格内的竖线必须写成 \| ，转义过的竖线不算列分隔符
    const cols = (s) => s.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length;
    const head = cols(line);
    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const row = lines[j];
      if (!/^\s*\|.*\|\s*$/.test(row)) break;
      if (cols(row) !== head) {
        report(rel, `第 ${j + 1} 行列数 ${cols(row)} ≠ 表头 ${head}（表格会渲染错位）`);
      }
    }
    i = j - 1;
  }

  // --- 3. 标题层级跳跃 ---
  const headings = [];
  let inFence = false;
  let fenceMark = null;
  for (const [i, line] of lines.entries()) {
    const fm = line.match(/^\s*(```+|~~~+)/);
    if (fm) {
      if (!inFence) { inFence = true; fenceMark = fm[1][0]; }
      else if (fm[1][0] === fenceMark) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) headings.push({ level: h[1].length, text: h[2], line: i + 1 });
  }
  for (let i = 1; i < headings.length; i += 1) {
    if (headings[i].level > headings[i - 1].level + 1) {
      report(rel, `第 ${headings[i].line} 行标题 h${headings[i - 1].level} → h${headings[i].level} 跳级`);
    }
  }

  // --- 4. 相对链接指向存在 ---
  const anchors = new Set(headings.map((h) => slug(h.text)));
  for (const raw of linksOf(text)) {
    let target = raw.replace(/^<|>$/g, '');
    if (/^(https?:|mailto:|#|data:)/i.test(target)) {
      // 锚点检查：只在同文件内
      if (target.startsWith('#')) {
        const a = decodeURIComponent(target.slice(1)).toLowerCase();
        if (a && !/^l\d+(-l\d+)?$/i.test(a) && !anchors.has(a)) report(rel, `锚点链接失效：${target}`);
      }
      continue;
    }
    const [filePart, anchor] = target.split('#');
    const abs = resolve(dirname(file), decodeURIComponent(filePart));
    if (!existsSync(abs)) {
      report(rel, `链接指向不存在的文件：${target}`);
      continue;
    }
    // GitHub 的 #L12 / #L12-L34 是**行号锚点**（指向代码行），不是标题锚点，不必在标题里找
    if (anchor && /^L\d+(-L\d+)?$/i.test(anchor)) continue;
    if (anchor) {
      const targetText = readFileSync(abs, 'utf8');
      const targetSlugs = new Set();
      let tf = false;
      let tMark = null;
      for (const line of targetText.split('\n')) {
        const fm = line.match(/^\s*(```+|~~~+)/);
        if (fm) {
          if (!tf) { tf = true; tMark = fm[1][0]; } else if (fm[1][0] === tMark) { tf = false; }
          continue;
        }
        if (tf) continue;
        const h = line.match(/^#{1,6}\s+(.*)$/);
        if (h) targetSlugs.add(slug(h[1]));
      }
      const a = decodeURIComponent(anchor).toLowerCase();
      if (a && !targetSlugs.has(a)) {
        report(rel, `跨文件锚点失效：${target}（目标文件里没有对应标题）`);
      }
    }
  }
}

console.log(problems === 0 ? '\nMarkdown 检查：全部通过' : `\nMarkdown 检查：${problems} 处问题`);
process.exitCode = problems === 0 ? 0 : 1;
