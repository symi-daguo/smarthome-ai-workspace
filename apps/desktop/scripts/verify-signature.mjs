#!/usr/bin/env node
/**
 * macOS 签名闸门：打包后、公证前必跑。
 *
 * 检查两件事：
 *   1. **每一个 Mach-O 都用 Developer ID 签了名**。
 *      Apple 公证要求「所有分发的可执行文件都要有有效签名」，
 *      漏签一个就会拿到「The binary is not signed with a valid Developer ID certificate」。
 *   2. **整个 bundle 的封印是有效的**（codesign --verify --deep --strict）。
 *      封印记录了每个文件的哈希；运行期往 bundle 里写/改任何文件都会让封印失效，
 *      Apple 会判主可执行文件「The signature of the binary is invalid」。
 *
 * 第 2 条尤其重要：它能抓住「应用把自己改坏了」这类缺陷 ——
 * Prisma CLI 会把校验和不符的 schema engine 恢复成原始副本，
 * jiti 会把 .ts 配置的转译缓存写进 node_modules/.cache/，
 * 两者都发生在**已签名的 app bundle 内部**，直接让公证失败。
 *
 * 用法：node scripts/verify-signature.mjs [app 路径]
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, '..');
const RELEASE = join(DESKTOP_DIR, 'release');

/** Mach-O 的四种魔数（arm64 / x86_64 / fat / fat64） */
const MACHO_MAGICS = new Set([
  'cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'feedfacf', 'cffaedfe',
]);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` —— ${detail}`}`);
  if (!ok) failures += 1;
}

/**
 * 跑一条命令并把 stdout 与 stderr 合起来返回。
 *
 * `codesign -dv` 的结果**写在 stderr**，execFileSync 只返回 stdout ——
 * 那样会把每个文件都判成「未签名」，闸门就成了永远红的假警报。
 */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 跑一条命令，失败时抛错（错误输出也一并带上） */
function runOrThrow(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败（exit ${r.status}）：\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 递归找出所有 Mach-O 文件（跳过软链：软链指向的文件会在真实路径上被扫到） */
function findMachOs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      findMachOs(p, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const magic = readMagic(p);
    if (magic && MACHO_MAGICS.has(magic)) out.push(p);
  }
  return out;
}

/**
 * 读文件头 4 字节。
 *
 * 注意：`readFileSync(path, { length: 4 })` 的 length **只对文件描述符有效**，
 * 对路径会被忽略而把整个文件读完（25MB 的引擎读三次 = 白烧 IO），
 * 而且 hex 会是整个文件的长度 —— 判断永远不成立，闸门会「扫到 0 个」然后假通过。
 */
function readMagic(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    return n === 4 ? buf.toString('hex') : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveAppPath() {
  const arg = process.argv[2];
  if (arg) return resolve(arg);
  if (!existsSync(RELEASE)) return null;
  const macDirs = readdirSync(RELEASE).filter((n) => n.startsWith('mac-'));
  for (const d of macDirs) {
    const full = join(RELEASE, d);
    for (const n of readdirSync(full)) {
      if (n.endsWith('.app')) return join(full, n);
    }
  }
  return null;
}

const APP = resolveAppPath();
if (!APP) {
  console.error('[verify-signature] 找不到 .app，请先执行 pnpm --filter @app/desktop dist:mac');
  process.exit(1);
}
console.log(`[verify-signature] 检查目标：${APP}`);

// ---- 1. 每个 Mach-O 都要 Developer ID 签名 ----
const machos = findMachOs(APP);
// 自检：扫不到文件说明扫描本身坏了（魔数判断写错、路径不对），
// 这种「0 个漏签」的 PASS 比不检查更糟 —— 必须先证明扫到了东西。
check(`Mach-O 扫描本身有效（扫到 ${machos.length} 个）`, machos.length > 0, '一个都没扫到，扫描逻辑可能坏了');
const unsigned = [];
for (const p of machos) {
  const out = run('codesign', ['-dv', '--verbose=2', p]);
  if (!out.includes('Developer ID Application')) unsigned.push(p);
}
check(
  `全部 Mach-O 都用 Developer ID 签名（扫到 ${machos.length} 个）`,
  unsigned.length === 0,
  unsigned.length ? `漏签 ${unsigned.length} 个：\n${unsigned.slice(0, 10).map((p) => `      ${p}`).join('\n')}` : '',
);

// ---- 2. bundle 封印有效 ----
let verifyOut = '';
let verifyOk = true;
try {
  verifyOut = runOrThrow('codesign', ['--verify', '--deep', '--strict', '--verbose=4', APP]);
} catch (e) {
  verifyOk = false;
  verifyOut = String(e.message);
}
const broken = verifyOut.split('\n').filter((l) => /file added|file modified|invalid|missing/i.test(l));
check(
  'bundle 封印有效（codesign --verify --deep --strict）',
  verifyOk,
  verifyOk ? '' : broken.slice(0, 10).join('\n'),
);

console.log('');
console.log(failures === 0 ? '签名闸门：全部通过' : `签名闸门：${failures} 项未通过`);
process.exit(failures === 0 ? 0 : 1);
