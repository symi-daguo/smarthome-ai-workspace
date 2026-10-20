#!/usr/bin/env node
/**
 * macOS 公证脚本（签名已完成，这里只做「提交 → 装订」）。
 *
 * 用法（两行出公证包）：
 *   source ~/.symi/notary.env && npm run notarize
 *
 * 关键前提（踩过的坑）：
 *   - `notarytool submit` **不接受 .app**，只接受 zip / dmg / pkg。
 *     所以要先用 ditto 把 .app 压成 zip 提交，再对 .app 本身 stapler staple。
 *   - 电子签章（ticket）必须**同时**装订在 .app 和最终分发的 dmg 上，
 *     只装订 dmg 的话，从 dmg 拖出来的 app 离线打开仍会提示「无法验证开发者」。
 *   - 顺序不能反：先公证 .app → 装订 → 再用装订后的 .app 重打 dmg → 再公证 dmg。
 *     直接把「未装订」的 .app 打成 dmg 再公证，Gatekeeper 仍会拦。
 *   - `stapler` **不支持 zip**（只认 UDIF 镜像、可执行 bundle、flat 安装包）。
 *     所以 zip 不装订、也不单独提交：zip 里装的是**已装订的 app**，ticket 跟着 app 走。
 *     真正分发给用户的安装包是 dmg，它既被公证也被装订。
 *   - `electron-builder --prepackaged` **不会重新签名**：
 *     两个 doSignAfterPack 调用点都在 doPack() 里，而 prepackaged 模式下 doPack() 直接 return。
 *     所以用装订后的 app 重打 dmg 不会把 ticket 破坏掉。
 *   - 大包上传会断：.app 打出来 716MB，压缩 266MB，要整包传到 Apple 的 S3。
 *     链路上行一慢（实测直连 143KB/s）就会在分片上传中途 `HTTPClientError.connectTimeout`，
 *     而服务端那侧的提交记录已经建好、状态停在 In Progress —— **超时不等于失败**。
 *     脚本对此分两种处置：传输类失败**换 S3 端点重传**，等待类失败**轮询提交历史**。
 *
 * 代理：脚本继承环境变量。跨境链路上行慢时，先 export 代理再跑：
 *   export HTTPS_PROXY=http://127.0.0.1:7890
 *   source ~/.symi/notary.env && npm run notarize
 *
 * 凭据来源：~/.symi/notary.env（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
 * APPLE_TEAM_ID / NOTARY_PROFILE），由调用方 source 进来。
 * 本脚本只把凭据写进本机钥匙串的 notarytool profile，不打印、不落盘。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, '..');
const CONFIG_FILE = join(DESKTOP_DIR, 'electron-builder.yml');

/** 产物目录：与 electron-builder.yml 里 directories.output 保持一致 */
function outputDir() {
  const yml = readFileSync(CONFIG_FILE, 'utf8');
  const m = yml.match(/^\s{2}output:\s*(\S+)\s*$/m);
  return join(DESKTOP_DIR, m ? m[1] : 'release');
}

const OUT_DIR = outputDir();

const APPLE_ID = process.env.APPLE_ID;
const APPLE_PASSWORD = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const TEAM_ID = process.env.APPLE_TEAM_ID;
const PROFILE = process.env.NOTARY_PROFILE || 'symi-notarize';

function log(msg) {
  console.log(`[notarize] ${msg}`);
}

function fail(msg) {
  console.error(`[notarize] ${msg}`);
  process.exit(1);
}

/**
 * 打印命令时抹掉凭据。
 * notarytool store-credentials 的密码是 app-specific password，
 * 直接拼进日志就等于把凭据落到磁盘上（与本脚本「不打印、不落盘」的约定冲突）。
 */
function redact(args) {
  const out = [];
  let hideNext = false;
  for (const a of args) {
    if (hideNext) {
      out.push('***');
      hideNext = false;
      continue;
    }
    if (a === '--password' || a === '--apple-id') {
      out.push(a);
      hideNext = true;
      continue;
    }
    const eq = a.match(/^(--password|--apple-id)=(.+)$/);
    if (eq) {
      out.push(`${eq[1]}=***`);
      continue;
    }
    out.push(a);
  }
  return out.join(' ');
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${redact(args)}`);
  // codesign / stapler 的结果都写在 stderr，用 spawnSync 才能一次拿到两路输出
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败（exit ${r.status}）：\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从提交历史里找某个文件名的最近一次提交（history 按时间倒序） */
function latestSubmission(fileName) {
  const out = run('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE, '--output-format', 'json']);
  const parsed = JSON.parse(out);
  const hit = (parsed.history ?? []).find((h) => h.name === fileName);
  return hit ?? null;
}

/**
 * 提交公证并等结果。
 *
 * 这里要对付两件完全不同的事：
 *
 * 1) **上传中断**（传输层失败）。本项目 .app 打出来 716MB，压缩 266MB，
 *    要整包传到 Apple 的 S3。上行链路一抖就会断在半路：
 *    实测一次在第 33 个分片（≈整个文件的最后一片）上 `HTTPClientError.connectTimeout`，
 *    notarytool 直接退出，但**服务端那侧的提交记录已经建好、状态停在 In Progress**。
 *    这种失败必须**重传**（notarytool 不支持断点续传），并且换 S3 端点重试：
 *    加速端点与常规端点在跨境链路上表现不一样。
 *
 * 2) **等待超时**（扫描没出结果）。Apple 官方说扫描「通常在一小时内」，
 *    而 `--wait` 有超时上限。关键是 **超时不等于失败** ——
 *    notarytool 文档写明「The Notary service will continue processing even if the
 *    timeout is reached」。所以这里改成轮询提交历史，直到 Accepted / Invalid。
 *
 * 两种失败的处置完全不同，不能混为一谈：传输失败要重传，等待超时要轮询。
 *
 * 判定顺序有讲究：**先判等待超时，再判传输失败**。
 * 之前反过来，导致「等待超时」的报错里只要带一个 network/HTTPClientError 字样
 * 就被当成上传中断，于是**重新上传了一遍同一个文件**（216MB 白传一次，
 * Apple 还要多扫一遍）。实测 dmg 那次就是这么把提交历史弄成两条同名 In Progress 的。
 */
const WAIT_TIMEOUT = /timed out|timeout is reached|exceeded.{0,20}timeout|timeout.{0,20}exceeded/i;
const TRANSPORT_ERROR = /abortedUpload|HTTPClientError|connectTimeout|connection reset|ECONNRESET|EPIPE|premature|network/i;

/** 报错里取最后一行非空内容（报错常以空行结尾，直接取 last 会打出空括号） */
function lastMeaningfulLine(msg) {
  const lines = String(msg).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 160) : '(无输出)';
}

async function submitAndWait(file, label) {
  const fileName = basename(file);

  // 提交前先看历史：这个文件是不是已经在处理中了？
  // 有的话直接轮询，**不重复上传**（216MB 传一次要 25 分钟，Apple 还要多扫一遍）。
  // 上一次跑崩/被杀/误判超时后重跑本脚本，就会走到这条分支。
  const already = latestSubmission(fileName);
  if (already && already.status === 'In Progress') {
    log(`  ${fileName} 已有在处理中的提交（${already.id}），直接等结果，不重复上传`);
    await pollUntilFinal(fileName, label);
    return;
  }

  // 第 1 次用加速端点，之后改用常规端点：两个端点在跨境链路上表现不一样
  const variants = ['--s3-acceleration', '--no-s3-acceleration'];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const flag = variants[attempt - 1];
    log(`提交 ${label} 公证：${fileName}（${flag}，第 ${attempt}/3 次）`);
    try {
      run('xcrun', [
        'notarytool', 'submit', file,
        '--keychain-profile', PROFILE,
        '--wait', '--timeout', '30m',
        flag,
      ]);
      return;
    } catch (e) {
      const msg = String(e.message);
      // 等待超时优先判定：服务端仍在处理，绝不能当成上传失败去重传
      if (WAIT_TIMEOUT.test(msg)) {
        log('  等待超时，改为轮询提交历史（服务端仍在处理）');
        await pollUntilFinal(fileName, label);
        return;
      }
      if (TRANSPORT_ERROR.test(msg)) {
        // 硬保障：只要这个文件已经有一条在处理中的提交，就**绝不重复上传**。
        // 216MB 传一次要 25 分钟，Apple 还要多扫一遍；而报错文本本身不总是可靠
        // （等待超时的报错也可能夹带 network 之类的字样）。宁可等，也不重传。
        const pending = latestSubmission(fileName);
        if (pending && pending.status === 'In Progress') {
          log(`  已有在处理中的提交（${pending.id}），不重复上传，改为轮询`);
          await pollUntilFinal(fileName, label);
          return;
        }
        if (attempt < 3) {
          log(`  上传中断（${lastMeaningfulLine(msg)}），10 秒后换端点重传`);
          await sleep(10_000);
          continue;
        }
        throw new Error(`${label} 上传连续 3 次中断，最后一次：\n${msg.slice(-2000)}`);
      }
      // 其余非传输类失败：多半也是服务端在处理，同样走轮询
      log(`  非传输类失败（${lastMeaningfulLine(msg)}），改为轮询提交历史`);
      await pollUntilFinal(fileName, label);
      return;
    }
  }
}

/** 轮询提交历史直到出终态（Accepted / Invalid / Rejected） */
async function pollUntilFinal(fileName, label) {
  const deadline = Date.now() + 60 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(20_000);
    const hit = latestSubmission(fileName);
    if (!hit) {
      log(`  提交历史里还没找到 ${fileName}，继续等`);
      continue;
    }
    if (hit.status !== last) {
      log(`  ${fileName} → ${hit.status}`);
      last = hit.status;
    }
    if (hit.status === 'Accepted') return;
    if (hit.status === 'Invalid' || hit.status === 'Rejected') {
      const detail = run('xcrun', ['notarytool', 'log', hit.id, '--keychain-profile', PROFILE]);
      throw new Error(`${label} 公证被拒（${hit.id}）：\n${detail.slice(-4000)}`);
    }
  }
  throw new Error(`${label} 公证等待超时（60 分钟）仍未出结果，最后状态：${last || '未知'}`);
}

for (const [name, value] of Object.entries({ APPLE_ID: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD: APPLE_PASSWORD, APPLE_TEAM_ID: TEAM_ID })) {
  if (!value) {
    fail(`缺少环境变量 ${name}。请先执行：source ~/.symi/notary.env`);
  }
}

// ---------------------------------------------------------------- 1. 找到产物

if (!existsSync(OUT_DIR)) {
  fail(`找不到打包产物目录 ${OUT_DIR}。请先执行：pnpm --filter @app/desktop dist:mac`);
}
const macDirs = readdirSync(OUT_DIR).filter((n) => n.startsWith('mac-'));
if (macDirs.length === 0) {
  fail(`${OUT_DIR} 下没有 mac-* 目录，请先执行：pnpm --filter @app/desktop dist:mac`);
}
const APP_PATH = join(OUT_DIR, macDirs[0]);
const apps = readdirSync(APP_PATH).filter((n) => n.endsWith('.app'));
if (apps.length === 0) {
  fail(`${APP_PATH} 下没有 .app，请先执行：pnpm --filter @app/desktop dist:mac`);
}
const APP = join(APP_PATH, apps[0]);
const PRODUCT = apps[0].replace(/\.app$/, '');
log(`目标应用：${APP}`);

// ---------------------------------------------------------------- 2. 确认已签名

const info = run('codesign', ['-dv', '--verbose=2', APP]);
const authority = info.split('\n').find((l) => l.includes('Authority=')) ?? '';
if (!authority.includes('Developer ID Application')) {
  fail(`应用没有用 Developer ID 签名（${authority.trim() || '未检测到 Authority'}），公证必然被拒。请确认钥匙串里有 Developer ID Application 证书。`);
}
log(`签名信息：${authority.trim()}`);

// 签名闸门：每个 Mach-O 都要 Developer ID 签名 + bundle 封印有效。
// 这两项任一不过，Apple 会直接拒收（实测报过
// 「The binary is not signed with a valid Developer ID certificate」
//  与「The signature of the binary is invalid」）。
log('跑签名闸门（每个 Mach-O 的签名 + bundle 封印）');
run('node', [join(HERE, 'verify-signature.mjs'), APP]);

// ---------------------------------------------------------------- 3. 写入钥匙串 profile

log(`写入钥匙串 profile：${PROFILE}`);
run('xcrun', [
  'notarytool',
  'store-credentials',
  PROFILE,
  '--apple-id', APPLE_ID,
  '--password', APPLE_PASSWORD,
  '--team-id', TEAM_ID,
]);

// ---------------------------------------------------------------- 4. 公证 + 装订 .app

const TMP = join(OUT_DIR, '.notarize-tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const APP_ZIP = join(TMP, `${PRODUCT}.zip`);
// app zip 已有 Accepted 提交就别再压一遍、传一遍：
// 压缩产物每次都不一样（时间戳、压缩流），重传只会让 Apple 多扫一次，
// 而且「已公证的那一份」与「刚压出来的这一份」对不上号。
// 崩溃后重跑脚本时，这一步能省掉 25 分钟上传。
const appPrior = latestSubmission(`${PRODUCT}.zip`);
if (appPrior && appPrior.status === 'Accepted') {
  log(`app zip 已有 Accepted 提交（${appPrior.id}），跳过压缩与提交`);
} else {
  log('压缩 .app（notarytool 不接受 .app，只接受 zip/dmg/pkg）');
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', APP, APP_ZIP]);

  log('提交公证（等待结果，最长 30 分钟）');
  await submitAndWait(APP_ZIP, 'app');
}

log('装订电子签章到 .app');
run('xcrun', ['stapler', 'staple', APP]);
run('xcrun', ['stapler', 'validate', APP]);
// 装订会往 bundle 里加电子签章，改完之后要重新确认封印仍然有效
run('node', [join(HERE, 'verify-signature.mjs'), APP]);

// ---------------------------------------------------------------- 5. 用装订后的 .app 重打 dmg

const ARCH = macDirs[0].replace('mac-', '');
const VERSION = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')).version;
const DMG = join(OUT_DIR, `${PRODUCT}-${VERSION}-${ARCH}.dmg`);
const ZIP_OUT = join(OUT_DIR, `${PRODUCT}-${VERSION}-${ARCH}-mac.zip`);

// dmg 打到独立暂存目录：release/ 里本来就躺着上一次构建的同名 dmg，
// 靠「修改时间比 app 新」来猜哪个是新的并不可靠（stapler 不一定改 app 目录的 mtime）。
const STAGE = join(TMP, 'dmg-out');
mkdirSync(STAGE, { recursive: true });

// 已经提交过的 dmg 不重打。
// 为什么：重打出来的是**新字节**（时间戳、压缩流都不同），与 Apple 那边已公证的
// 那一份不是同一个东西 —— 拿旧票据去装订新文件会失败，或者装订成功但
// 与实际公证内容对不上。重跑脚本时这是最容易踩的坑。
const priorSubmission = latestSubmission(basename(DMG));
const reuseDmg = Boolean(priorSubmission) && existsSync(DMG);
if (reuseDmg) {
  log(`复用已提交的 dmg（${basename(DMG)}，提交号 ${priorSubmission.id} / ${priorSubmission.status}），不重打`);
} else {
  log('用装订后的 .app 重打 dmg');
  try {
    const builder = join(DESKTOP_DIR, 'node_modules/.bin/electron-builder');
    run(builder, [
      '--mac', 'dmg',
      '--prepackaged', APP,
      '--publish', 'never',
      '--config', join(DESKTOP_DIR, 'electron-builder.yml'),
      '--config.directories.output', STAGE,
    ], { cwd: DESKTOP_DIR });
  } catch (e) {
    log(`electron-builder --prepackaged 失败（${e.message}），改用 hdiutil 直接打 dmg`);
    const stage = join(TMP, 'dmg-stage');
    mkdirSync(stage, { recursive: true });
    execFileSync('cp', ['-R', APP, join(stage, `${PRODUCT}.app`)]);
    execFileSync('ln', ['-s', '/Applications', join(stage, 'Applications')]);
    run('hdiutil', [
      'create',
      '-volname', PRODUCT,
      '-srcfolder', stage,
      '-ov', '-format', 'UDZO',
      join(STAGE, `${PRODUCT}.dmg`),
    ]);
  }

  // 暂存目录里只应该有一个 dmg
  const staged = readdirSync(STAGE).filter((n) => n.endsWith('.dmg'));
  if (staged.length !== 1) {
    fail(`dmg 产出异常：${STAGE} 下有 ${staged.length} 个 dmg（期望 1 个）`);
  }
  renameSync(join(STAGE, staged[0]), DMG);
  log(`dmg：${DMG}`);
}

log('提交 dmg 公证');
await submitAndWait(DMG, 'dmg');
log('装订电子签章到 dmg');
run('xcrun', ['stapler', 'staple', DMG]);
run('xcrun', ['stapler', 'validate', DMG]);

// ---------------------------------------------------------------- 6. 分发用 zip（装订后的 .app）

log('生成分发用 zip（装订后的 .app）');
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', APP, ZIP_OUT]);
// 分发 zip **不单独提交公证**，这是有意的取舍，不是漏做：
//   1. `stapler` 根本不支持 zip（只认 UDIF 镜像 / 可执行 bundle / flat 安装包），
//      所以就算提交了也装订不进 zip，只能留一份服务端记录；
//   2. zip 里装的就是**已公证并装订的 app**，ticket 随 app 走，
//      Gatekeeper 校验的也是 app —— 用户解压后双击，行为与从 dmg 里拖出来完全一致；
//   3. 本项目 .app 压缩后 266MB，直连上行实测只有 143~200KB/s（单次上传 ≈ 25 分钟），
//      多提交一个 zip 等于多一轮 25 分钟的传输窗口与一次断流风险。
// 真正分发给用户的安装包是 dmg，它既被公证也被装订。
log('分发 zip 不单独提交公证（stapler 不支持 zip，app 的 ticket 随包走）');

// electron-builder 留下的 blockmap 描述的是**重打之前**那个 dmg/zip 的哈希，
// 现在文件已被替换，blockmap 就是错的。本项目没接自动更新，留着只会误导人。
for (const name of readdirSync(OUT_DIR)) {
  if (!name.endsWith('.blockmap')) continue;
  rmSync(join(OUT_DIR, name), { force: true });
  log(`清掉过期 blockmap：${name}`);
}

// ---------------------------------------------------------------- 7. 校验

/**
 * 挂载 dmg，复验里面的 app 仍带电子签章。
 *
 * 这一步是**附加验证**，不是公证本身：到这一步时 app 与 dmg 早已 Accepted 并装订完毕。
 * 所以它失败**不应该**让整个脚本以失败告终 —— 那是「产物没问题但附加检查跑不了」，
 * 报成「公证失败」会误导人。
 *
 * 挂载在受限环境（容器 / 沙箱 / 无 mount 权限）下会被拒（`hdiutil: attach failed - 权限被拒绝`），
 * 这时降级成警告并继续，如实说明「未实测」，不假装验过了。
 */
log('校验 dmg 内的 app 仍带电子签章（对应「从 dmg 拖出来离线打开」的真实路径）');
const MOUNT = join(TMP, 'mnt');
mkdirSync(MOUNT, { recursive: true });
let mounted = false;
let mountCmd = null;
try {
  run('hdiutil', ['attach', DMG, '-nobrowse', '-readonly', '-mountpoint', MOUNT]);
  mounted = true;
  mountCmd = 'hdiutil attach';
} catch (e) {
  // hdiutil attach 已弃用，新系统建议用 diskutil image attach
  try {
    run('diskutil', [
      'image', 'attach', DMG,
      '--mountOptions', 'nobrowse,readOnly',
      '--mountPoint', MOUNT,
    ]);
    mounted = true;
    mountCmd = 'diskutil image attach';
  } catch (e2) {
    log(`  ⚠️ 挂载 dmg 失败（${String(e.message).split('\n').pop().trim()}）`);
    log('  dmg 与 app 的公证与装订均已成功（见上面的 Accepted 与 stapler 输出）；');
    log('  这一步只是「从 dmg 拖出来双击」的额外复验，在无 mount 权限的环境里跑不了。');
  }
}

if (mounted) {
  try {
    const appInDmg = join(MOUNT, `${PRODUCT}.app`);
    if (!existsSync(appInDmg)) {
      log(`  ⚠️ dmg 里没有找到 ${PRODUCT}.app，跳过内层复验`);
    } else {
      run('xcrun', ['stapler', 'validate', appInDmg]);
      const dmgVerdict = run('spctl', ['-a', '-t', 'exec', '-vv', appInDmg]);
      console.log(dmgVerdict.trim());
    }
  } finally {
    try {
      if (mountCmd === 'diskutil image attach') run('diskutil', ['unmount', MOUNT]);
      else run('hdiutil', ['detach', '-quiet', MOUNT]);
    } catch {
      /* 卸载失败不影响结论 */
    }
  }
}

log('Gatekeeper 评估 .app');
try {
  const verdict = run('spctl', ['-a', '-t', 'exec', '-vv', APP]);
  console.log(verdict.trim());
} catch (e) {
  fail(`Gatekeeper 评估未通过：${e.stdout ?? ''}${e.stderr ?? ''}`);
}

rmSync(TMP, { recursive: true, force: true });
log('公证完成');
log(`  应用：${APP}`);
log(`  安装包：${DMG}`);
log(`  分发包：${ZIP_OUT}`);
