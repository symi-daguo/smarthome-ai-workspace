/**
 * 品牌与开源合规闸门。
 *
 * 背景：项目最早是照着一款同类商业产品做功能对标（clean-room：只学功能与交互模式，
 * 不取对方的代码 / 素材 / 文案 / 商标）。公开发布前必须能**证明**这件事，
 * 而且要能持续证明 —— 所以把「有没有漏进第三方品牌痕迹」做成机器闸门，
 * 而不是靠人记得检查。
 *
 * 扫 git 已跟踪文件，查四类：
 *   1. 第三方注册商标符号（跟在名字后面的 U+00AE / U+2122）
 *   2. 第三方公司名（有限公司 / 股份公司 / Inc. / Corp. / Ltd.）
 *   3. 本机绝对路径链接（file:///Volumes/... 在 GitHub 上点不开，还公开本机目录结构）
 *   4. 未登记的外链域名 —— 白名单只放「公开模型 API / 包 registry / 官方文档」，
 *      出现新域名必须人工确认后加白名单。新域名 = 一次显式审查，不是障碍。
 *
 * **只扫 git 已跟踪的文件**（`git ls-files`），不扫工作区 ——
 * 工作区里可能留着已被 .gitignore 排除的本地材料（逆向过程记录），
 * 扫工作区会误判；干净克隆（= CI 与别人克隆下来）才是交付物。
 *
 * 用法：node scripts/check-brand.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 允许出现的域名。
 * 原则：只放**公开服务**（模型厂商 API、镜像仓库、官方文档站、本机开发域名）。
 * 任何第三方商业平台的域名都不该出现在这里。
 */
const ALLOWED_DOMAINS = new Set([
  // 模型厂商 API
  'api.minimaxi.com', 'platform.minimaxi.com',
  'api.openai.com', 'platform.openai.com',
  'api.deepseek.com', 'platform.deepseek.com',
  'api.moonshot.cn', 'platform.moonshot.cn',
  'open.bigmodel.cn',
  'dashscope.aliyuncs.com',
  'bailian.console.aliyun.com',
  // 包仓库与镜像
  'registry.npmjs.org', 'www.npmjs.com', 'registry.npmmirror.com',
  // 代码托管与官方文档
  'github.com', 'www.w3.org', 'json.schemastore.org', 'www.prisma.io', 'itunes.apple.com',
  // 本机开发与示例
  'host.docker.internal', 'localhost',
  'example.com', 'evil.example', 'ollama.com', 'xxx.runpod.ws',
  // 本地模型服务与官方文档
  'lmstudio.ai', 'docs.vllm.ai', 'www.apple.com',
]);

/**
 * 允许出现「公司名模式」的文件。
 * 只有这两个：闸门自身要写出这些模式，合规文档要解释这些模式。
 * 除它们之外，任何文件出现公司名模式都算问题。
 */
const PATTERN_EXEMPT = new Set(['scripts/check-brand.mjs', 'COMPLIANCE.md']);

// 注册商标符号：必须紧跟在名字后面才算「商标标记」，
// 单独出现在正文里（例如合规文档里解释这个符号）不算。
const TM_MARK = /[\p{L}\p{N}][®™]/u;
// 公司名：中文用「有限公司 / 有限责任公司 / 股份有限公司」，英文用词边界
const COMPANY_CN = /[\p{Script=Han}]{2,}(?:有限责任公司|股份有限公司|有限公司|股份公司)/u;
const COMPANY_EN = /\b(?:Inc|Corp|Ltd)\.\s/g;
// 本机绝对路径链接。
// 必须带**真实的用户名段**才算命中：`file:///Volumes/hasskit/...` 是坏链接；
// 而 AGENTS.md / CHANGELOG 里为了说明「别这么写」而出现的 `file:///Volumes/...`
// 与 `file:///Volumes/<本机用户名>/...` 是反例，不该被当成坏链接。
const LOCAL_FILE_URL = /file:\/\/\/(?:Volumes|Users)\/[A-Za-z0-9._-]+\//g;

let problems = 0;
const report = (file, msg) => {
  problems += 1;
  console.log(`FAIL ${file}: ${msg}`);
};

function trackedFiles() {
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** 二进制文件（图片、字体、wasm…）跳过：读前 8KB 找 NUL 字节 */
function isBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

const files = trackedFiles();
if (files.length === 0) {
  console.log('品牌检查：不在 git 仓库里，跳过');
  process.exit(0);
}

const unknownDomains = new Map();

for (const rel of files) {
  let buf;
  try {
    buf = readFileSync(join(ROOT, rel));
  } catch {
    continue; // 已删除或读不到（软链等），不报
  }
  if (isBinary(buf)) continue;
  const text = buf.toString('utf8');

  if (!PATTERN_EXEMPT.has(rel)) {
    const tm = text.match(TM_MARK);
    if (tm) report(rel, `出现注册商标标记「${tm[0]}」（第三方品牌痕迹）`);

    const cn = text.match(COMPANY_CN);
    if (cn) report(rel, `出现公司名「${cn[0]}」（第三方主体名称）`);

    const en = text.match(COMPANY_EN);
    if (en) report(rel, `出现公司名后缀「${en[0].trim()}」（第三方主体名称）`);

    const local = text.match(LOCAL_FILE_URL);
    if (local) report(rel, `出现本机绝对路径链接「${local[0]}」（GitHub 上点不开，还公开本机目录结构）`);
  }

  for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/g)) {
    const host = m[1].toLowerCase();
    if (ALLOWED_DOMAINS.has(host)) continue;
    if (!unknownDomains.has(host)) unknownDomains.set(host, new Set());
    unknownDomains.get(host).add(rel);
  }
}

for (const [host, where] of unknownDomains) {
  const sample = [...where].slice(0, 3).join('、');
  report(
    '（域名白名单）',
    `出现未登记域名「${host}」（${sample}${where.size > 3 ? ' 等' : ''}）。`
    + '确认它不是第三方商业平台后，加进 scripts/check-brand.mjs 的 ALLOWED_DOMAINS',
  );
}

if (problems === 0) {
  console.log(`品牌检查：全部通过（已扫 ${files.length} 个已跟踪文件）`);
} else {
  console.log(`品牌检查：${problems} 项未通过`);
}
process.exit(problems === 0 ? 0 : 1);
