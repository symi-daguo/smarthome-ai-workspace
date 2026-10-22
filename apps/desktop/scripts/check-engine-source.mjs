#!/usr/bin/env node
/**
 * 探活 Prisma schema engine 的下载源，并把「引擎到底在不在」变成明面上的信号。
 *
 * 为什么需要这个脚本（实测踩过的坑）：
 *
 * 1. @prisma/engines 的 postinstall 负责把当前平台的 schema engine 从
 *    binaries.prisma.sh 下载下来，但它的下载是 `failSilent: true` ——
 *    失败只写进 `DEBUG=prisma:download` 日志，安装照样返回成功。
 *    **真正的原因一个字都看不到。**
 *
 * 2. 它还有一把 20 秒的 `download-lock` 并发锁。崩溃残留的锁会让后续调用
 *    直接跳过下载 —— 表现是「秒返回、啥也没干」，重试几次全被这把锁挡掉。
 *
 * 3. pnpm 在 Windows 的 CI 上干脆没执行它：安装日志里有 `prisma preinstall`，
 *    没有 `engines postinstall`。于是引擎根本不存在，migrate 必然失败。
 *
 * 所以在 CI 里显式跑一次这个脚本：域网通不通、postinstall 跑没跑、引擎在不在，
 * 三件事各占一行，不用翻几千行安装日志去猜。
 *
 * 退出码：
 *   0 = 引擎已在（不需要额外下载），或源可达（prepare-runtime 会自己补下）
 *   1 = 源不可达 —— 引擎肯定拿不到，必须先解决网络
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const NM_PNPM = join(process.argv[2] ?? process.cwd(), 'node_modules', '.pnpm');

if (!existsSync(NM_PNPM)) {
  console.error(`找不到 ${NM_PNPM} —— 先跑 pnpm install`);
  process.exit(1);
}

const entry = readdirSync(NM_PNPM).find((e) => e.startsWith('@prisma+engines@'));
if (!entry) {
  console.error('node_modules/.pnpm 下没有 @prisma/engines —— 依赖没装全');
  process.exit(1);
}

const enginesDir = join(NM_PNPM, entry, 'node_modules', '@prisma', 'engines');
console.log(`[engine] @prisma/engines ${entry.slice('@prisma+engines@'.length)}`);
console.log(`[engine] 包目录：${enginesDir}`);

const files = readdirSync(enginesDir);
const engines = files.filter((f) => f.startsWith('schema-engine'));
console.log(`[engine] 目录内文件：${files.join(', ')}`);
console.log(`[engine] 引擎二进制：${engines.length ? engines.join(', ') : '（没有）'}`);

const requireEngines = createRequire(join(enginesDir, 'package.json'));
const { enginesVersion } = requireEngines('@prisma/engines-version');
// 与 @prisma/fetch-engine 的 getBinaryName 同一套规则：
// 平台标识用 Prisma 的（不是 node 的 platform+arch），windows 额外带 .exe。
const binaryTarget = process.platform === 'win32'
  ? 'windows'
  : (process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin') : 'linux-musl');
const fileName = binaryTarget === 'windows' ? 'schema-engine.exe' : 'schema-engine';
const url = `https://binaries.prisma.sh/all_commits/${enginesVersion}/${binaryTarget}/${fileName}.gz`;

console.log(`[engine] commit：${enginesVersion}`);
console.log(`[engine] 源地址：${url}`);

try {
  const res = await fetch(url, { method: 'HEAD' });
  console.log(`[engine] 源可达：HTTP ${res.status}${res.ok ? '' : '（不是 2xx）'}`);
  if (!res.ok) {
    console.error('[engine] 引擎源返回异常状态码 —— 引擎多半下不下来');
    process.exit(1);
  }
} catch (e) {
  const cause = e instanceof Error && e.cause && e.cause.code ? `（${e.cause.code}）` : '';
  console.error(`[engine] 源不可达：${e instanceof Error ? e.message : String(e)}${cause}`);
  process.exit(1);
}

if (engines.length) {
  console.log('[engine] 结论：引擎已就位');
} else {
  console.log('[engine] 结论：引擎不在，但源可达 —— prepare-runtime 会直接下载补上');
}
