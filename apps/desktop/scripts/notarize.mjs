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
import { homedir } from 'node:os';
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

/**
 * 专用钥匙串文件（不依赖登录钥匙串）。
 *
 * 踩过的坑：用 `notarytool store-credentials` 存进**登录钥匙串**后，
 * 过一段时间条目就取不到了（报 "No Keychain password item found"），
 * 公证流程在轮询阶段直接崩 —— 而此时文件已经上传、钱（时间）已经花掉。
 * 登录钥匙串会被系统清理，这个稳定性赌不起。
 *
 * 改用独立钥匙串文件：它只被这个脚本管理，不受登录钥匙串清理影响，
 * 也不会把凭据混进用户的日常钥匙串。
 * 代价是要自己解锁一次（用同一个 app-specific password 当钥匙串口令）。
 */
const KEYCHAIN_PATH = process.env.NOTARY_KEYCHAIN || join(homedir(), '.symi', 'notary.keychain');

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
 *
 * 注意 `security create-keychain -p <密码>` 走的是短选项 `-p`，
 * 它也是同一个 app-specific password —— 漏掉这条就等于把凭据打进日志。
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
    if (a === '--password' || a === '--apple-id' || a === '-p') {
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

/**
 * 跑一条命令。
 *
 * 失败时抛出的消息里**也必须抹掉凭据** —— 原实现把 args 原样拼进错误消息，
 * 而 store-credentials 失败时这条消息会被打进日志，等于凭据照样落盘。
 */
function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${redact(args)}`);
  // codesign / stapler 的结果都写在 stderr，用 spawnSync 才能一次拿到两路输出
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${redact(args)} 失败（exit ${r.status}）：\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 确保专用钥匙串存在且已解锁（不存在才创建） */
function ensureKeychain() {
  if (!existsSync(KEYCHAIN_PATH)) {
    mkdirSync(dirname(KEYCHAIN_PATH), { recursive: true });
    run('security', ['create-keychain', '-p', APPLE_PASSWORD, KEYCHAIN_PATH]);
  }
  run('security', ['unlock-keychain', '-p', APPLE_PASSWORD, KEYCHAIN_PATH]);
}

/** 所有 notarytool 调用统一带上专用钥匙串 */
/**
 * 所有 notarytool 调用统一带上专用钥匙串。
 *
 * 顺带在调用前确保钥匙串是**解锁**的。
 *
 * 踩过的坑（实测 2026-10-21）：系统会在空闲一段时间后自动锁上钥匙串，
 * 之后 `notarytool` 直接报 `The notary.keychain is locked`。
 * 公证流程里有很长的等待（上传 + 扫描），等待期间被锁是常事 ——
 * 一旦在等待阶段崩掉，前面传的几百 MB 就白费了。
 * 所以每次调用前都解锁一次（解锁是本地操作，不花钱）。
 */
function notaryArgs(args) {
  try {
    run('security', ['unlock-keychain', '-p', APPLE_PASSWORD, KEYCHAIN_PATH]);
  } catch {
    /* 解锁失败就让它按原样继续，后面的 notarytool 会给出真实错误 */
  }
  return ['notarytool', ...args, '--keychain', KEYCHAIN_PATH];
}

/**
 * 这条提交在 Apple 侧**是否真实存在**。
 *
 * 为什么要探：上传大文件是分片传的，传到一半断了的话，
 * notarytool 本地的 history 里**仍然会留下一条 In Progress 记录**，
 * 但 Apple 侧其实没有这条提交（取 log 会报 "submissionId does not exist"）。
 * 不探这一下，脚本会以为「已提交、正在处理」，一路空等，
 * 重跑也走同一条分支 —— 变成永远传不上去的死循环。
 *
 * 判据：`notarytool log` 对**扫描已开始**的提交返回退出码 0 并输出 JSON；
 * 对不存在的提交返回退出码 69 并在 stderr 写
 * "Submission log is not yet available or submissionId does not exist"。
 *
 * **实测过的重要陷阱（2026-10-21）**：
 * 退出码 69 有两种完全不同的成因，返回的**文案一模一样**：
 *   1. 这条提交压根没送达（上传中断）—— 需要重传；
 *   2. 这条提交刚建好、**字节还在传**，扫描还没开始 —— **绝不能重传**。
 * 实测「正在上传中的 245MB 提交」与「上一轮上传中断的死记录」，
 * 两者 `notarytool log` 的返回码与文案**完全相同**（都是 69 + 同一句话）。
 *
 * 所以**单次探不到绝不能作数**：调用方必须连续探多次仍探不到，
 * 且确认不是「刚提交还在传」，才能判定为死记录。
 * 这也是为什么下面所有使用点都有「连续 N 次」的计数，而不是单次判断。
 */
function submissionExists(id) {
  try {
    run('xcrun', notaryArgs(['log', id, '--keychain-profile', PROFILE]));
    return true;
  } catch {
    return false;
  }
}

/**
 * 从提交历史里找某个文件名的**全部**提交（按时间倒序）。
 *
 * 排序显式做，不依赖 Apple 返回的顺序：
 * 历史上同名的提交会堆积（本项目就有「上一轮上传中断留下的死记录」+
 * 「本轮正常上传的活记录」两条同名记录），靠返回顺序取第一条是隐式假设，
 * 哪天 Apple 改了排序就会取错 —— 取错的后果是白等一小时或白传 245MB。
 */
function submissionsFor(fileName) {
  const out = run('xcrun', notaryArgs(['history', '--keychain-profile', PROFILE, '--output-format', 'json']));
  const parsed = JSON.parse(out);
  return (parsed.history ?? [])
    .filter((h) => h.name === fileName)
    .sort((a, b) => String(b.createdDate ?? '').localeCompare(String(a.createdDate ?? '')));
}

/** 同名提交里最新的那一条 */
function latestSubmission(fileName) {
  return submissionsFor(fileName)[0] ?? null;
}

/**
 * 同名提交里**最近一条已 Accepted** 的。
 *
 * 为什么不能只看最新那条：
 * 最新那条往往是「上一次上传中断留下的死记录」（In Progress），
 * 而**真正公证成功的那条可能排在它下面**（1.0.1 实测就是这个情况：
 * 最新的死记录把已 Accepted 的记录盖住了）。
 * 只看最新会白白丢掉一次 245MB 上传。
 */
function latestAccepted(fileName) {
  return submissionsFor(fileName).find((h) => h.status === 'Accepted') ?? null;
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

/**
 * 提交记录的「宽限期」：记录建了不到这么久，一律不判死。
 *
 * 依据（实测 2026-10-21）：`notarytool submit` 先在 Apple 侧建好提交记录、
 * 拿到 submission id，**然后才传字节**。所以记录出现的那一刻，
 * 字节往往还在路上 —— 此时 `notarytool log` 必然探不到（返回 69），
 * 但这条提交是**活的**。
 *
 * 本机实测 245MB 上传耗时：链路好时 **2 分钟**（1.7~2.2MB/s），
 * 链路差时 25 分钟（143KB/s）。取 30 分钟作宽限期：
 * 覆盖最坏情况，又不至于让「已死但很新」的记录空等太久
 * （每条死记录要等满 30 分钟才允许重传，代价可控）。
 *
 * 可以用环境变量 {@link NOTARY_UPLOAD_GRACE_SECONDS} 覆盖（排查时用）：
 * 已确认某条记录确实是死记录时，把宽限期调短可以立刻重传，不必干等。
 */
const UPLOAD_GRACE_MS = Math.max(
  0,
  Number(process.env.NOTARY_UPLOAD_GRACE_SECONDS ?? 30 * 60) * 1000,
);

/** 报错里取最后一行非空内容（报错常以空行结尾，直接取 last 会打出空括号） */
function lastMeaningfulLine(msg) {
  const lines = String(msg).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 160) : '(无输出)';
}

/**
 * 判断 history 里的这条 In Progress 记录是不是「上传中断留下的死记录」。
 *
 * **不能靠单次探测下结论**（实测 2026-10-21）：
 * `notarytool log` 返回 69 有两种成因，返回文案一模一样 ——
 *   1. 这条提交压根没送达（上一轮上传在分片途中断了）→ 该重传；
 *   2. 这条提交刚建好、**字节还在传**，扫描没开始 → **重传就是白传 245MB**。
 * 「正在上传的提交」和「上传中断的死记录」探测结果完全相同。
 *
 * 所以判死要同时满足三个条件：
 *   a. 连续探测 3 次都探不到（单次不作数）；
 *   b. 这条记录已经存在足够久（超过 {@link UPLOAD_GRACE_MS}）——
 *      刚建的记录还在传，不能判死；
 *   c. 期间 history 里它一直是 In Progress（没变成 Accepted/Invalid）。
 *
 * 条件 b 的处理方式很关键：**太新不能直接放弃，而是等到超过宽限期再判**。
 * 否则「刚中断、最新那条恰好不可见」时会走进「不判死 → 只等不传 → 轮询 60 分钟
 * 才报错」的死循环 —— 正是这个脚本上一轮卡住的方式。
 *
 * 返回 true = 确认是死记录，可以重传。
 */
async function isDeadSubmission(hit, fileName, label) {
  const created = Date.parse(hit.createdDate ?? '');
  const born = Number.isFinite(created) ? created : Date.now();
  // 宽限期从「这条记录建起来」算起，不是从现在开始 ——
  // 上一轮留下的记录可能已经躺了很久，不该再给它 30 分钟。
  const graceUntil = born + UPLOAD_GRACE_MS;

  // 等宽限期用 while 而不是改循环变量：
  // 改 `i` 会让 for 的边界失效（i=0 后 ++i 又从 1 开始，等于无限循环）。
  while (Date.now() < graceUntil) {
    if (submissionExists(hit.id)) {
      log(`  ${fileName} 的提交（${hit.id}）在 Apple 侧已可见 —— 是活记录，不是死记录`);
      return false;
    }
    const waitMs = Math.min(graceUntil - Date.now() + 5_000, 15 * 60 * 1000);
    log(`  ${fileName} 的提交（${hit.id}）还在宽限期内（还剩 `
      + `${Math.ceil((graceUntil - Date.now()) / 1000)} 秒），字节可能仍在上传 —— 等它过了宽限期再判定`);
    await sleep(Math.max(waitMs, 5_000));
  }

  for (let i = 1; i <= 3; i += 1) {
    if (submissionExists(hit.id)) {
      log(`  ${fileName} 的提交（${hit.id}）在 Apple 侧已可见 —— 是活记录，不是死记录`);
      return false;
    }
    const age = Math.round((Date.now() - born) / 1000);
    log(`  ${fileName} 的提交（${hit.id}）在 Apple 侧探不到（${i}/3），该记录已存在 ${age} 秒`);
    if (i < 3) await sleep(15_000);
  }
  log(`  ${fileName} 的提交（${hit.id}）连续 3 次探不到且已存在 `
    + `${Math.round((Date.now() - born) / 1000)} 秒 —— 判定为上传中断留下的死记录`);
  return true;
}

async function submitAndWait(file, label) {
  const fileName = basename(file);

  // 提交前先看历史：这个文件是不是已经在处理中了？
  // 有的话直接轮询，**不重复上传**（216MB 传一次要 25 分钟，Apple 还要多扫一遍）。
  // 上一次跑崩/被杀/误判超时后重跑本脚本，就会走到这条分支。
  const already = latestSubmission(fileName);
  if (already && already.status === 'In Progress') {
    // 只有确认这条记录是「上传中断留下的死记录」，才允许重传；
    // 否则一律「只等不传」（宁可等，也不白传 245MB）。
    if (!(await isDeadSubmission(already, fileName, label))) {
      log(`  ${fileName} 已有在处理中的提交（${already.id}），直接等结果，不重复上传`);
      await pollUntilFinal(fileName, label);
      return;
    }
    log(`  ${fileName} 的历史记录（${already.id}）是上传中断留下的死记录 —— 重新上传`);
  }

  // 第 1 次用加速端点，之后改用常规端点：两个端点在跨境链路上表现不一样
  const variants = ['--s3-acceleration', '--no-s3-acceleration'];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const flag = variants[attempt - 1];
    log(`提交 ${label} 公证：${fileName}（${flag}，第 ${attempt}/3 次）`);
    try {
      run('xcrun', notaryArgs([
        'submit', file,
        '--keychain-profile', PROFILE,
        '--wait', '--timeout', '30m',
        flag,
      ]));
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
        //
        // 但「history 里有」不等于「上传真的送达了」：上传中途断掉时，
        // history 里同样会留下一条 In Progress 的死记录。
        // 要用同一套判死逻辑（连续探测 + 宽限期）确认，不能单次探不到就重传。
        const pending = latestSubmission(fileName);
        if (pending && pending.status === 'In Progress') {
          if (!(await isDeadSubmission(pending, fileName, label))) {
            log(`  已有在处理中的提交（${pending.id}），不重复上传，改为轮询`);
            await pollUntilFinal(fileName, label);
            return;
          }
          log(`  历史里的提交（${pending.id}）是上传中断留下的死记录`);
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

/**
 * 轮询提交历史直到出终态（Accepted / Invalid / Rejected）。
 *
 * 这里**不能只查 history**。
 *
 * 踩过的坑：history 是 Apple 按「文件名」给的列表，它会把一条**上传根本没送达**
 * 的提交也显示成 In Progress（提交记录在上传开始前就建好了，
 * 但字节没传完）。只等 history 的话，脚本会一路空等满 60 分钟才报错，
 * 而重跑还是走同一条「已在处理中」的分支 —— 永远传不上去。
 *
 * 所以每次轮询都要**同时探一次 Apple 侧**（notarytool log）：
 * 连续探不到、且 history 一直是 In Progress，就判定「上传没送达」，
 * 立刻退出让操作者重跑（重跑会走重传分支）。
 *
 * 「探不到」要连续 3 次（每次间隔 20 秒）才作数：
 * `notarytool log` 的报错文案是「log 不可用 **或** id 不存在」共用的，
 * 扫描刚提交、结果还没生成的那一小段时间里也会探不到 —— 单次探不到不作数。
 */
async function pollUntilFinal(fileName, label) {
  const deadline = Date.now() + 60 * 60 * 1000;
  let last = '';
  let missing = 0;
  let unreachable = 0;
  while (Date.now() < deadline) {
    await sleep(20_000);
    const hit = latestSubmission(fileName);
    if (!hit) {
      missing += 1;
      // 正常情况下 history 里立刻就有这条记录。一直找不到说明提交压根没到 Apple，
      // 空等一小时没有意义 —— 早退出，重跑脚本会重新上传。
      if (missing >= 15) {
        throw new Error(`${label} 提交在 Apple 侧查不到（提交未上传成功），请重跑脚本`);
      }
      log(`  提交历史里还没找到 ${fileName}（第 ${missing} 次），继续等`);
      continue;
    }
    missing = 0;
    if (hit.status !== last) {
      log(`  ${fileName} → ${hit.status}`);
      last = hit.status;
    }
    if (hit.status === 'Accepted') return;
    if (hit.status === 'Invalid' || hit.status === 'Rejected') {
      const detail = run('xcrun', notaryArgs(['log', hit.id, '--keychain-profile', PROFILE]));
      throw new Error(`${label} 公证被拒（${hit.id}）：\n${detail.slice(-4000)}`);
    }
    // 还在 In Progress：探一下 Apple 侧，确认这条提交是真的存在。
    // 注意：**单次探不到不作数** —— 「字节还在传」与「上传已死」探测结果相同，
    // 判死要连续 3 次都探不到，且记录已过宽限期（见 isDeadSubmission 的说明）。
    if (!submissionExists(hit.id)) {
      unreachable += 1;
      log(`  ${fileName} 仍是 In Progress，但 Apple 侧取不到（${unreachable}/3）`);
      if (unreachable >= 3) {
        // 再确认一次记录年龄：刚建的记录可能只是字节还在传，不能判死。
        // 宽限期没过就继续等（每轮 20 秒自然推进），不判死、不放弃。
        const created = Date.parse(hit.createdDate ?? '');
        const born = Number.isFinite(created) ? created : Date.now();
        const age = Date.now() - born;
        if (age < UPLOAD_GRACE_MS) {
          log(`  该提交才建了 ${Math.round(age / 1000)} 秒，`
            + '字节可能还在上传 —— 不判死，继续等');
          unreachable = 0;
          continue;
        }
        throw new Error(
          `${label} 提交（${hit.id}）在 Apple 侧不存在 —— 上传没有真正送达，` +
          '请重跑脚本（会走重传分支）',
        );
      }
    } else {
      unreachable = 0;
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
const VERSION = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')).version;
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

log(`准备专用钥匙串：${KEYCHAIN_PATH}`);
ensureKeychain();
log(`写入钥匙串 profile：${PROFILE}`);
run('xcrun', notaryArgs([
  'store-credentials',
  PROFILE,
  '--apple-id', APPLE_ID,
  '--password', APPLE_PASSWORD,
  '--team-id', TEAM_ID,
]));

// ---------------------------------------------------------------- 4. 公证 + 装订 .app

const TMP = join(OUT_DIR, '.notarize-tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// 临时 zip 的文件名**必须带版本号**。
//
// 踩过的坑：原来固定叫「智能家居AI工作台.zip」，而 notarytool 的提交历史是按
// **文件名**匹配的，于是上一版本公证过的同名记录会被当成本次「已公证」——
// 但那张 ticket 对应的是**旧字节**（旧代码打出来的 app）。
// 后果是：跳过压缩提交 → 拿旧 ticket 装订新 app → stapler 报
// 「Could not find base64 encoded ticket」直接失败。
// 带版本号后，各版本的提交记录天然分开，不会串。
const APP_ZIP = join(TMP, `${PRODUCT}-${VERSION}.zip`);
// 已有 Accepted 提交也别再压一遍、传一遍：
// 压缩产物每次都不一样（时间戳、压缩流），重传只会让 Apple 多扫一次，
// 而且「已公证的那一份」与「刚压出来的这一份」对不上号。
// 崩溃后重跑脚本时，这一步能省掉 25 分钟上传。
//
// 但「同名的 Accepted 记录」**不能单独作为复用的理由** —— 必须再确认
// 当前这份 app 确实已经带上了电子签章（stapler validate 通过）。
// 只有这两条同时成立，才说明「公证的就是现在这份字节」。
const appPrior = latestAccepted(`${PRODUCT}-${VERSION}.zip`);
// 「已有票据能直接装订到当前 app」时置 true：省掉一次 245MB 上传
let appTicketReusable = false;
let appAlreadyStapled = false;
try {
  run('xcrun', ['stapler', 'validate', APP]);
  appAlreadyStapled = true;
} catch {
  appAlreadyStapled = false;
}
if (appPrior && appPrior.status === 'Accepted' && appAlreadyStapled) {
  log(`app zip 已有 Accepted 提交（${appPrior.id}）且当前 app 已带有效电子签章，跳过压缩与提交`);
} else {
  if (appPrior && appPrior.status === 'Accepted') {
    log(`注意：历史里有同名的 Accepted 提交（${appPrior.id}），但当前 app 未带电子签章 —— 先按未公证处理`);
  }

  /**
   * 先试着把那张已有票据装订到当前 app 上 —— 成功就说明这张票对当前 app 有效，
   * **完全不必再上传 245MB**。
   *
   * 依据（实测 2026-10-21）：Apple 的票据是按 **app 的代码签名哈希（cdhash）**
   * 匹配的，**不是按压缩包的字节**。`notarytool submit` 提交的是 zip，
   * 但扫描时解包、对里面的 app 签名哈希出票。
   * 于是：上一轮压缩出来的那个 zip（字节与本轮不同）如果公证通过了，
   * 它对应的是**同一份 app**，那张票**照样能装订到当前 app 上**。
   *
   * 这解释了 1.0.1 实测里一个差点白费的事实：
   *   - `ee72de07` 那次上传其实成功了（Accepted），只是脚本当时没认出来；
   *   - 它对应的 zip 字节（sha `391d4679…`）与本轮压出来的（sha `2ffe3e47…`）**不同**，
   *     所以「比 sha256」会判为不可复用 —— 但那张票**本来就能用**，
   *     `stapler staple` 直接装订成功。
   *
   * 所以判据是「**装订能不能成功**」，而不是「字节一不一样」：
   * 装订成功 = Apple 认这张票对当前 app 有效（这是最终事实，无需推断）；
   * 装订失败 = 票不对应当前 app，重传。
   */
  if (appPrior && appPrior.status === 'Accepted') {
    log('尝试把已公证的票据直接装订到当前 app（票据按 app 的签名哈希匹配，与压缩包字节无关）');
    try {
      run('xcrun', ['stapler', 'staple', APP]);
      run('xcrun', ['stapler', 'validate', APP]);
      log(`装订成功 —— 已公证的提交（${appPrior.id}）对应的正是当前这份 app，省掉一次 245MB 上传`);
      appTicketReusable = true;
    } catch {
      log('  装订失败 —— 这张票不对应当前 app，需重新上传');
      appTicketReusable = false;
    }
  }

  if (!appTicketReusable) {
    log('压缩 .app（notarytool 不接受 .app，只接受 zip/dmg/pkg）');
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', APP, APP_ZIP]);
    log('提交公证（等待结果，最长 30 分钟）');
    await submitAndWait(APP_ZIP, 'app');
  }
}

log('装订电子签章到 .app');
run('xcrun', ['stapler', 'staple', APP]);
run('xcrun', ['stapler', 'validate', APP]);
// 装订会往 bundle 里加电子签章，改完之后要重新确认封印仍然有效
run('node', [join(HERE, 'verify-signature.mjs'), APP]);

// ---------------------------------------------------------------- 5. 用装订后的 .app 重打 dmg

const ARCH = macDirs[0].replace('mac-', '');
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
//
// 找的是**最近一条已 Accepted** 的同名提交（不是最新那条）：
// 最新那条常常是「上传中断留下的死记录」（In Progress），
// 真正公证成功的那条排在它下面 —— 只看最新会白白丢掉一次 226MB 上传。
const priorSubmission = latestAccepted(basename(DMG));
// 只有「已 Accepted」才能复用：In Progress 时 ticket 还没下来，复用会导致装订失败
const reuseDmg = priorSubmission?.status === 'Accepted' && existsSync(DMG);
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
  // 超时是必须的：受限环境里 attach 可能**挂起**（不报错也不返回），
  // 没有超时整个流程会永远停在这一步（2026-10-21 实测踩到）。
  run('hdiutil', ['attach', DMG, '-nobrowse', '-readonly', '-mountpoint', MOUNT], { timeout: 120_000 });
  mounted = true;
  mountCmd = 'hdiutil attach';
} catch (e) {
  // hdiutil attach 已弃用，新系统建议用 diskutil image attach
  try {
    run('diskutil', [
      'image', 'attach', DMG,
      '--mountOptions', 'nobrowse,readOnly',
      '--mountPoint', MOUNT,
    ], { timeout: 120_000 });
    mounted = true;
    mountCmd = 'diskutil image attach';
  } catch (e2) {
    log('  直接挂载失败，改用「转目录镜像再挂载」的路径');
    // 实测（2026-10-21）：在受限环境里 attach 会**挂起**（不报错也不返回），
    // 而 `hdiutil convert -format UDTO` 转成目录镜像后再挂载**不需要特权**，
    // 这条路径在本机实测通过。挂载命令都带超时，避免整个流程被挂住。
    const CDR = join(TMP, 'dmg-verify.cdr');
    try {
      run('hdiutil', ['convert', DMG, '-format', 'UDTO', '-o', CDR, '-quiet'], { timeout: 300_000 });
      run('hdiutil', ['attach', CDR, '-nobrowse', '-readonly', '-mountpoint', MOUNT], { timeout: 120_000 });
      mounted = true;
      mountCmd = 'hdiutil attach';
    } catch (e3) {
      log(`  ⚠️ 挂载 dmg 失败（${String(e3.message).split('\n').pop().trim()}）`);
      log('  dmg 与 app 的公证与装订均已成功（见上面的 Accepted 与 stapler 输出）；');
      log('  这一步只是「从 dmg 拖出来双击」的额外复验，在无 mount 权限的环境里跑不了。');
    }
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
