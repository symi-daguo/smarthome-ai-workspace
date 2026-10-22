/**
 * Prisma schema engine 的定位与获取。
 *
 * 单独成模块的原因：这个逻辑踩过三次坑，每次的根因都不一样，
 * 而它们**只在打包机上暴露**（本机 macOS 上一切正常）。集中放一个文件、
 * 配一个能单跑的测试，才能把「Windows 上引擎到底叫什么」这种认知固化下来。
 *
 * 三个坑：
 *
 * 1. **文件名不能自己拼。** 官方源里的文件名用的是「Prisma 平台标识」，
 *    不是「node 的 platform + arch」。实测（2026-10-22）：
 *      darwin arm64 → `schema-engine-darwin-arm64`
 *      windows x64  → `schema-engine-windows.exe`（**不带架构后缀**）
 *    官方源里的原始文件更简单，Windows 上就叫 `schema-engine.exe.gz`。
 *    之前按 `schema-engine-win32-x64.exe` 找，在 Windows 上必然找不到。
 *
 * 2. **postinstall 的失败是静默的。** @prisma/engines 的 postinstall 用
 *    `failSilent: true` 调 download()，失败只写进 `DEBUG=prisma:download` 日志，
 *    安装照样返回成功 —— 真正的原因一个字都看不到。
 *    它还有一把 20 秒的 `download-lock` 并发锁，崩溃残留的锁会让后续调用
 *    直接跳过下载（表现是「秒返回、啥也没干」）。
 *
 * 3. **pnpm 在 Windows 的 CI 上压根没执行这个 postinstall。**
 *    安装日志里有 `prisma preinstall`，没有 `engines postinstall`。
 *
 * 所以这里不指望 postinstall，直接调 @prisma/fetch-engine 的 download()
 * 并把 failSilent 关掉 —— 失败会抛出来，DNS 解析不了 / 403 / 超时都能看到原文。
 */
import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** 各平台在 Prisma 引擎文件名里的标识片段 */
const PLATFORM_MARKERS = {
  darwin: ['darwin'],
  win32: ['windows', 'win32'],
  linux: ['linux', 'debian', 'musl', 'rhel'],
};

/** @prisma/engines 包在 pnpm 虚拟目录下的实际位置（带版本号的那一层） */
export function findEnginesPackageDir(nmPnpm) {
  if (!existsSync(nmPnpm)) return null;
  for (const entry of readdirSync(nmPnpm)) {
    if (!entry.startsWith('@prisma+engines@')) continue;
    const dir = join(nmPnpm, entry, 'node_modules', '@prisma', 'engines');
    if (existsSync(dir)) return { dir, version: entry.slice('@prisma+engines@'.length) };
  }
  return null;
}

/** 文件名里有没有别的平台的标识（有就说明不是本平台的引擎） */
export function looksLikeCurrentPlatform(fileName, platform = process.platform) {
  const lower = fileName.toLowerCase();
  for (const [p, markers] of Object.entries(PLATFORM_MARKERS)) {
    if (p === platform) continue;
    if (markers.some((m) => lower.includes(m))) return false;
  }
  return true;
}

/**
 * 读文件头几字节，确认这是本平台的可执行文件。
 *
 * 为什么还要查这个：文件名能对上不代表内容对 —— 下载到别的平台的引擎，
 * 在 Windows 上会报「不是有效的 Win32 应用」，在 macOS 上会报「无法执行二进制文件」，
 * 排查起来比一开始就拦下更费时间。
 */
export function isExecutableForCurrentPlatform(filePath, platform = process.platform) {
  let head;
  try {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    head = buf.toString('hex');
  } catch {
    return false;
  }
  if (platform === 'win32') return head.startsWith('4d5a'); // MZ
  if (platform === 'darwin') {
    // Mach-O 的几种魔数（含大小端与 fat 二进制）
    return ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(head);
  }
  return head.startsWith('7f454c46'); // ELF
}

/**
 * 在 @prisma/engines 包目录里找出当前平台的 schema engine。
 *
 * 扫目录 + 平台标识筛选 + 二进制魔数校验，三道都过才算数。
 */
export function findSchemaEngine(nmPnpm, platform = process.platform) {
  const pkg = findEnginesPackageDir(nmPnpm);
  if (!pkg) return null;
  for (const name of readdirSync(pkg.dir)) {
    if (!name.startsWith('schema-engine')) continue;
    if (!looksLikeCurrentPlatform(name, platform)) continue;
    const p = join(pkg.dir, name);
    if (!existsSync(p) || !isExecutableForCurrentPlatform(p, platform)) continue;
    return { path: p, name, version: pkg.version };
  }
  return null;
}

/**
 * 直接向官方源下载 schema engine，落到 enginesDir。
 *
 * 与 @prisma/engines 的 postinstall 用的是同一套下载逻辑（同一个包、同一个版本），
 * 区别只有两点：failSilent 关掉（失败能抛出来）、直接指定目标目录。
 */
export async function downloadEngine(enginesDir) {
  const requireEngines = createRequire(join(enginesDir, 'package.json'));
  const { download, BinaryType } = requireEngines('@prisma/fetch-engine');
  const { enginesVersion } = requireEngines('@prisma/engines-version');
  await download({
    binaries: { [BinaryType.SchemaEngineBinary]: enginesDir },
    version: enginesVersion,
    failSilent: false,
    showProgress: false,
  });
  return enginesVersion;
}
