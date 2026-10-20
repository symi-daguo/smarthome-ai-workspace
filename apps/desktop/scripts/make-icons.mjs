#!/usr/bin/env node
/**
 * 生成桌面端图标。
 *
 * 复用前端已有的 apps/web/public/icon.svg（同一套品牌图形，不另造一套），
 * 用 macOS 自带的 qlmanage 渲染成 PNG，再用 iconutil 合成 .icns。
 *
 * 为什么不用 SVG 直接打包：macOS 的 .app 图标必须是 .icns，
 * electron-builder 不会自动从 SVG 生成它。
 *
 * 产物：
 *   apps/desktop/build/icon.icns  macOS 应用图标（含 10 种尺寸）
 *   apps/desktop/build/icon.png   512×512，Windows / Linux 用
 *
 * Windows 的 .ico 不在这里生成：electron-builder 会自己从这张 512×512 PNG
 * 转出多尺寸 .ico（electron-builder.yml 的 win.icon 指向的就是它）。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '../..');
const BUILD_DIR = join(DESKTOP_DIR, 'build');
const SVG = join(REPO_ROOT, 'apps/web/public/icon.svg');

if (!existsSync(SVG)) {
  throw new Error(`找不到图标源文件：${SVG}`);
}
mkdirSync(BUILD_DIR, { recursive: true });

/** .iconset 的标准文件名：<逻辑尺寸>[@2x].png */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const work = mkdtempSync(join(tmpdir(), 'symi-icon-'));
try {
  // qlmanage 只能「一个尺寸一次」，所以按需渲染再复用
  const rendered = new Map();
  const render = (size) => {
    if (rendered.has(size)) return rendered.get(size);
    const outDir = join(work, `q${size}`);
    mkdirSync(outDir, { recursive: true });
    execFileSync('qlmanage', ['-t', '-s', String(size), '-o', outDir, SVG], { stdio: 'ignore' });
    const produced = join(outDir, `${SVG.split('/').pop()}.png`);
    if (!existsSync(produced)) throw new Error(`qlmanage 没有产出 ${size}px 的 PNG`);
    const target = join(work, `render-${size}.png`);
    copyFileSync(produced, target);
    rendered.set(size, target);
    return target;
  };

  const iconset = join(work, 'icon.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const [name, size] of ICONSET) {
    copyFileSync(render(size), join(iconset, name));
  }

  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(BUILD_DIR, 'icon.icns')]);

  // 512×512 PNG：Windows / Linux 用（electron-builder 会自行转成多尺寸 .ico）
  copyFileSync(render(512), join(BUILD_DIR, 'icon.png'));

  const sizes = ICONSET.map(([n]) => n).join(', ');
  console.log(`[icons] 已生成 ${join(BUILD_DIR, 'icon.icns')}（${sizes}）`);
  console.log(`[icons] 已生成 ${join(BUILD_DIR, 'icon.png')}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
