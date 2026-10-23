#!/usr/bin/env node
/**
 * zip 产物自检：确认每个 zip 里的非 ASCII 文件名都带 UTF-8 标志位（0x800）。
 *
 * 为什么要有这道闸门：
 * app bundle 目录名是中文「智能家居AI工作台.app」。electron-builder 打 zip 时
 * **没有**在文件名含非 ASCII 时置 0x800 标志，于是 Windows 资源管理器按 CP437
 * 解读这些字节，解压出来是乱码目录名（「µÖ║Φâ╜σ«╢σ▒à...」）。
 * 字节本身是标准 UTF-8，缺的只是一个标志位。
 *
 * 判据落在**内容**上：真读一遍 zip 的 central directory，
 * 数「非 ASCII 文件名里有多少个缺 0x800」。不是看配置项写没写、也不是看脚本跑没跑过 ——
 * 那两种判据都会在「脚本没被调用」时误判成通过。
 *
 * 同时验证数据区完好：抽若干条目读出来比 CRC（zipfile.read 会校验），
 * 确认「只改标志位」没有连带破坏内容。
 *
 * 用法：node scripts/verify-zip-utf8.mjs [zip 路径…]
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyZipUtf8Flags } from './fix-zip-utf8.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE = join(resolve(HERE, '..'), 'release');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` —— ${detail}`}`);
  if (!ok) failures += 1;
}

const args = process.argv.slice(2);
const targets = args.length > 0
  ? args
  : (existsSync(RELEASE)
    ? readdirSync(RELEASE).filter((f) => f.endsWith('.zip')).map((f) => join(RELEASE, f))
    : []);

if (targets.length === 0) {
  console.log('没有可检查的 zip（release/ 下没有 .zip）');
  process.exit(0);
}

for (const z of targets) {
  if (!existsSync(z)) {
    check(`${z} 存在`, false);
    continue;
  }
  const v = verifyZipUtf8Flags(z);
  check(
    `${z.split('/').pop()} 的非 ASCII 文件名都带 UTF-8 标志（${v.nonAscii} 个，缺 ${v.bad} 个）`,
    v.nonAscii === 0 || v.bad === 0,
    v.bad > 0 ? `缺标志的条目：${v.bad} 个` : '',
  );
  check(
    `${z.split('/').pop()} 的 local header 也都带 UTF-8 标志（缺 ${v.badLocal} 个）`,
    v.badLocal === 0,
  );
  if (v.samples.length) {
    console.log(`  样例文件名：${v.samples.join(' | ')}`);
  }
}

if (failures > 0) {
  console.error(`\nzip UTF-8 自检失败 ${failures} 项`);
  process.exit(1);
}
console.log('\nzip UTF-8 自检全部通过');
