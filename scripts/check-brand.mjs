/**
 * 品牌与开源合规闸门。
 *
 * 背景：项目最早参考过一款商业产品的功能形态（clean-room：只学功能与交互模式，
 * 不取第三方的代码 / 素材 / 文案 / 商标）。公开发布前必须能**证明**这件事，
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
 * 工作区里可能留着已被 .gitignore 排除的本地材料（过程记录），
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
  // Prisma 官方引擎二进制分发站（@prisma/fetch-engine 的默认下载源）
  'binaries.prisma.sh',
  // 代码托管与官方文档
  'github.com', 'api.github.com', 'uploads.github.com', 'www.w3.org', 'json.schemastore.org', 'www.prisma.io', 'itunes.apple.com',
  // 本机开发与示例
  'host.docker.internal', 'localhost',
  // example.com 是 RFC 2606 保留的示例域名（连同其子域），
  // 专门留给文档与示例用，不是真实商业平台 —— 可以进白名单。
  'example.com', 'work.example.com', 'evil.example', 'ollama.com', 'xxx.runpod.ws',
  // 本地模型服务与官方文档
  'lmstudio.ai', 'docs.vllm.ai', 'www.apple.com',
]);

/**
 * 允许出现这些模式字面量的文件。
 * 只有闸门自身：模式必须写在这里才能生效。
 * 除它之外，任何文件出现商标标记 / 公司名 / 本机路径 / 过程自述措辞都算问题 ——
 * 连合规文档本身也不例外，它要解释这些概念时用别的说法。
 */
const PATTERN_EXEMPT = new Set(['scripts/check-brand.mjs']);

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

// 公开仓库里不该出现的「过程自述」与「参照措辞」。
// 公开文档要讲清楚**产品是什么、怎么用**，不是讲我们怎么来的 ——
// 那种叙述既暴露内部分析过程，也让读者误以为代码是搬来的。
// 模式里的英文缩写用词边界：README 里含该缩写但不是独立单词，不会误判。
//
// 「对标」的处理（2026-10 改）：只拦「对标站」，**放行裸的「对标」**。
// 原因：「对标账号情报」是本产品自己的功能名（用户配置要盯的对标账号 →
// 采集热门内容 → 映射到我们业务），正文、界面、接口、文档里都要用这个词。
// 早先的正则 `对标(?!题)` 会把功能名一起拦掉，等于功能没法叫自己的名字。
// 真正的第三方产品名由下面的商标词表与域名白名单负责拦，
// 不需要靠「对标」这两个字来兜底。
const PROCESS_NARRATION = /\bREA\b|逆向|反编译|参考站|对标站|目标系统|目标站|原系统|同类产品/g;

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

    const narration = text.match(PROCESS_NARRATION);
    if (narration) {
      report(rel, `出现过程自述 / 参照措辞「${narration[0]}」（公开文档只讲产品本身，不讲实现过程）`);
    }
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
