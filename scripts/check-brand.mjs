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
  // 公共镜像仓库（Docker Hub 不可达时的备选源，见 docker-compose.yml 的镜像来源说明）
  'ghcr.io', 'quay.io',
  // Prisma 官方引擎二进制分发站（@prisma/fetch-engine 的默认下载源）
  'binaries.prisma.sh',
  // Apple 公证链路（notarytool / stapler / 票据交付）的官方端点。
  // 这些是**公证基础设施**，任何 macOS 开发者都要用，属于公开服务 ——
  // 文档里要写清「哪些域名必须绕过代理」，不写就没法照着配。
  // 注意：这是 Apple 的服务地址，不是「借鉴自谁」的痕迹。
  'api.apple-cloudkit.com', 'appstoreconnect.apple.com', 'notarytool.apple.com',
  'timestamp.apple.com', 'sequoia.apple.com', 'seed-sequoia.siri.apple.com',
  // 代码托管与官方文档
  // objects.githubusercontent.com 是 GitHub Release 下载的真实分发端点
  // （browser_download_url 会 302 到它），与 uploads.github.com 同一族 ——
  // 都是 GitHub 自己的公开服务，不是第三方商业平台。
  'github.com', 'api.github.com', 'uploads.github.com', 'objects.githubusercontent.com', 'www.w3.org', 'json.schemastore.org', 'www.prisma.io', 'itunes.apple.com',
  // 本机开发与示例
  'host.docker.internal', 'localhost',
  // example.com 是 RFC 2606 保留的示例域名（连同其子域），
  // 专门留给文档与示例用，不是真实商业平台 —— 可以进白名单。
  'example.com', 'work.example.com', 'evil.example', 'ollama.com', 'xxx.runpod.ws',
  // 本地模型服务与官方文档
  'lmstudio.ai', 'docs.vllm.ai', 'www.apple.com',
  // 源码注释里出现的模型厂商 API 与镜像站（与上面同一批服务，只是写在代码注释里）
  'com.minimax.agent.cn', 'platform.minimax.io', 'mirror.ccs.tencentyun.com', 'ghcr.io',
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

/**
 * 自曝「借鉴来源」的措辞：**借鉴动词 + 大写英文专有名词**。
 *
 * 为什么不能只拦动词：中文工程语境里「照抄上一轮的结论」「照搬本文」
 * 「校验范式照抄既有的 bindVideos」全是正常用法（照抄**自己**的代码），
 * 逐字拦动词会一天误报十几次 —— 闸门天天误报就等于没有闸门。
 * 而「照搬 <某个开源项目> 的做法」这种句子才是真问题：
 * **动词后面跟的是别人的产品名**。
 *
 * 所以判据落在两个条件同时成立上：动词 ∈ {照搬, 照抄, 仿照}，且紧跟一个
 * 大写开头的英文专有名词（许可证缩写与 README 这类通用词排除在外）。
 *
 * ── 反向测试样例（放在这里，不写在文档里）──────────────────────
 * 本文件在 PATTERN_EXEMPT 里，带具体名字的样例写在这里不会被自己抓到；
 * 写进任何 .md 都会被下面的规则命中 —— 连举例都不该在公开文档里出现
 * 具体的第三方产品名。
 *
 *   # 往任一受跟踪文件里追加一行「// 照搬 <某个开源项目> 的做法」
 *   # 期望：精确报 1 条「出现自曝借鉴来源的措辞」，撤掉后恢复全绿。
 *
 * 裸域名检测的反向测试样例同理：
 *   # 往任一受跟踪文件里追加一行「// 实测于 <某个第三方域名>」
 *   # 期望：报「出现未登记域名」，撤掉后恢复全绿。
 * ─────────────────────────────────────────────────────────────
 */
const BORROWED_PRODUCT = /(?:照搬|照抄|仿照)\s*(?:自)?\s*([A-Z][A-Za-z0-9]{2,})/g;
/** 通用词与许可证缩写：跟着「照抄」也不代表借鉴了谁 */
const BORROWING_NOT_PRODUCT = new Set([
  'README', 'MIT', 'BSD', 'Apache', 'GPL', 'AGPL', 'LGPL', 'ISC', 'SSPL', 'MPL', 'MSCL', 'CC0',
]);

/**
 * 裸域名（不带协议的）。
 *
 * 只认常见顶级域，且要求**独立出现**：
 * - 前面不能是标识符字符（`foo-bar.com` 里的横杠也算）；
 * - 后面不能紧跟 `.标识符` —— 否则 `bubbleRoles.ai.footer` 这种「camelCase 属性链」
 *   会被拆成「域名 bubbleRoles.ai」，那是代码不是网址；
 * - 第一段不能是 JS 常见全局对象（`console.info`、`this.site`、`rect.top` 这类属性访问）。
 *
 * 这些排除不是洁癖：闸门天天误报就等于没有闸门。
 */
const BARE_DOMAIN =
  /(?<![\w.$-])([a-z0-9][a-z0-9-]*)((?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|co|ai|app|dev|xyz|top|site|cc|me|info))(?!\.[a-z0-9])(?![\w-])/gi;
/** 属性访问误报：这些词打头的是代码标识符，不是域名首段 */
const JS_GLOBALS = new Set([
  'this', 'console', 'modal', 'message', 'rect', 'window', 'document', 'globalThis',
  'options', 'props', 'state', 'config', 'params', 'res', 'err', 'data', 'event',
]);

/**
 * 域名检测的文件级豁免。
 *
 * 这两个文件必然含域名字面量：闸门自身要写白名单，lockfile 是机器生成的
 * （里面全是包仓库地址，与「第三方商业平台」无关）。
 */
const DOMAIN_EXEMPT = new Set(['scripts/check-brand.mjs', 'pnpm-lock.yaml']);

let problems = 0;
const report = (file, msg) => {
  problems += 1;
  console.log(`FAIL ${file}: ${msg}`);
};

/**
 * 要扫的文件清单。
 *
 * `--cached`（已跟踪）+ `--others --exclude-standard`（未跟踪且**未被 .gitignore 排除**）
 * —— 两者合起来正好是「**将要进入交付物**的文件」：
 *   - `--cached`：已入库的文件；
 *   - `--others --exclude-standard`：工作区里还没 git add、但这次提交会带上的新文件。
 *
 * 为什么必须带上 `--others`（2026-10-26 实测踩到）：
 * 只用 `git ls-files` 时，**新文件在提交前完全逃过闸门** ——
 * 于是「本地跑闸门全绿、CI 跑闸门全红」：本地扫的是提交前的文件集合，
 * CI 扫的是提交后的文件集合，两者不是一回事（实际就靠这个盲区，
 * 让一份文档里的反面示例漏到了 CI 才被抓住）。
 * 提交前的检查结论必须等于 CI 的结论，否则这道闸门等于没有。
 *
 * 仍然**不扫**被 .gitignore 排除的文件：那些是本地材料与构建产物，
 * 不属于交付物（`--exclude-standard` 正是按 .gitignore 规则排除）。
 */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard'], {
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

    for (const m of text.matchAll(BORROWED_PRODUCT)) {
      if (BORROWING_NOT_PRODUCT.has(m[1])) continue;
      report(rel, `出现自曝借鉴来源的措辞「${m[0].trim()}」（公开仓库不该写明代码是从谁那儿拿的）`);
    }
  }

  for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/g)) {
    if (DOMAIN_EXEMPT.has(rel)) break;
    const host = m[1].toLowerCase();
    if (ALLOWED_DOMAINS.has(host)) continue;
    if (!unknownDomains.has(host)) unknownDomains.set(host, new Set());
    unknownDomains.get(host).add(rel);
  }

  // 裸域名（没有协议）：注释里写「实测于 xxx.com」时最容易漏出去。
  // 原来的检测只认 `https?://` 形式，裸域名整个漏掉 ——
  // 而「别人家的站点地址」恰恰更常出现在注释里（解释某个结构的实测来源）。
  if (!DOMAIN_EXEMPT.has(rel)) {
    for (const m of text.matchAll(BARE_DOMAIN)) {
      const host = m[0].toLowerCase();
      // 属性访问误报：`console.info` / `this.site` / `r.top` 这类
      if (JS_GLOBALS.has(m[1].toLowerCase())) continue;
      // 单字符首段几乎不会是域名首段（`r.top` 是几何记号）
      if (m[1].length < 2) continue;
      if (ALLOWED_DOMAINS.has(host)) continue;
      if (!unknownDomains.has(host)) unknownDomains.set(host, new Set());
      unknownDomains.get(host).add(rel);
    }
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
