#!/usr/bin/env node
/**
 * 桌面端运行时资源准备脚本。
 *
 * 产出 apps/desktop/runtime/ 目录（打包时整目录塞进 app bundle 的 Resources）：
 *   runtime/pg      内嵌 PostgreSQL 二进制（initdb / pg_ctl / postgres + 动态库 + share）
 *   runtime/api     API 编译产物 + 生产依赖 + prisma/{schema.prisma,migrations}
 *   runtime/web/dist 前端产物
 *
 * 三件套的取舍都在这里落地，理由写在各自的裁剪步骤注释里。
 *
 * 用法：
 *   node scripts/prepare-runtime.mjs                # 完整流程（含前后端编译）
 *   node scripts/prepare-runtime.mjs --skip-build   # 跳过编译，只重装运行时（迭代快）
 *   node scripts/prepare-runtime.mjs --no-trim      # 不做任何体积裁剪（用于对照）
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '../..');
const RUNTIME = join(DESKTOP_DIR, 'runtime');

const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes('--skip-build');
const NO_TRIM = argv.includes('--no-trim');

/** 内嵌 PostgreSQL 的平台包名（与 @embedded-postgres/* 的包名一一对应） */
const PG_PACKAGE = {
  'darwin-arm64': '@embedded-postgres/darwin-arm64',
  'darwin-x64': '@embedded-postgres/darwin-x64',
  'linux-x64': '@embedded-postgres/linux-x64',
  'win32-x64': '@embedded-postgres/windows-x64',
}[`${process.platform}-${process.arch}`];

/** 被裁掉的方言：桌面端只用 PostgreSQL，其余方言的 wasm 纯占地方 */
const DIALECT_RE = /\.(cockroachdb|mysql|sqlite|sqlserver)\./;

let savedBytes = 0;

function log(msg) {
  console.log(`[prepare-runtime] ${msg}`);
}

/**
 * 目录体积，按 inode 去重（与 `du` 口径一致）。
 *
 * 为什么要去重：pnpm 的隔离布局里 `node_modules/<pkg>` 是指向
 * `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>` 的软链，
 * 按软链跳过会少算一大截，按软链累加又会重复算 —— 只有按 inode 去重才对。
 */
function dirSize(dir, seen = new Set()) {
  if (!existsSync(dir)) return 0;
  let st;
  try {
    st = statSync(dir);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    try {
      const s = statSync(p);
      if (seen.has(s.ino)) continue;
      seen.add(s.ino);
      if (s.isDirectory()) total += dirSize(p, seen);
      else total += s.size;
    } catch {
      /* 断链忽略 */
    }
  }
  return total;
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function rel(target) {
  return target.startsWith(RUNTIME) ? target.replace(RUNTIME, 'runtime') : target;
}

/** 删除一个路径并累计省下的体积 */
function drop(target, reason) {
  if (!existsSync(target)) return 0;
  const size = dirSize(target);
  rmSync(target, { recursive: true, force: true });
  savedBytes += size;
  log(`  裁掉 ${rel(target)}（${fmtSize(size)}）—— ${reason}`);
  return size;
}

/** 删除目录下匹配的文件名 */
function dropMatching(dir, matcher, reason) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!matcher(name)) continue;
    const p = join(dir, name);
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      /* ignore */
    }
    rmSync(p, { recursive: true, force: true });
    savedBytes += size;
    log(`  裁掉 ${rel(p)}（${fmtSize(size)}）—— ${reason}`);
  }
}

/** 递归删除匹配的文件（用于全局清 sourcemap / TS 声明） */
function stripFiles(root, matcher, reason) {
  if (!existsSync(root)) return;
  let count = 0;
  let size = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!matcher(entry.name)) continue;
      try {
        size += statSync(p).size;
        rmSync(p, { force: true });
        count += 1;
      } catch {
        /* ignore */
      }
    }
  };
  walk(root);
  if (count > 0) {
    savedBytes += size;
    log(`  清掉 ${count} 个 ${reason}（${fmtSize(size)}）`);
  }
}

function run(cmd, args, cwd = REPO_ROOT) {
  log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/**
 * 收集一个软链指向的 .pnpm 条目名。
 * pnpm 的隔离布局里，node_modules/<pkg> 是指向 ../../<pkg>@<ver>/node_modules/<pkg> 的软链，
 * 所以「这个包属于哪个 .pnpm 条目」可以从 realpath 里反推。
 */
function collectLink(p, out) {
  try {
    if (!lstatSync(p).isSymbolicLink()) return;
    const real = realpathSync(p);
    const marker = `${sep}.pnpm${sep}`;
    const idx = real.lastIndexOf(marker);
    if (idx === -1) return;
    out.add(real.slice(idx + marker.length).split(sep)[0]);
  } catch {
    /* 断链忽略 */
  }
}

/**
 * 在 .pnpm 虚拟仓库里按「包名前缀」找到某个包的实体目录。
 * 例：findInPnpm(nmPnpm, '@prisma+studio-core@', '@prisma/studio-core')
 * 返回 .pnpm/<entry>/node_modules/@prisma/studio-core
 */
function findInPnpm(nmPnpm, prefix, relPath) {
  if (!existsSync(nmPnpm)) return null;
  for (const entry of readdirSync(nmPnpm)) {
    if (!entry.startsWith(prefix)) continue;
    const p = join(nmPnpm, entry, 'node_modules', relPath);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 扫掉「不再被任何入口引用」的 .pnpm 条目。
 *
 * 为什么要单独做这一步：pnpm 的隔离布局里，删掉一个顶层包，
 * 它独占的传递依赖会变成孤儿目录（@prisma/studio-core 带着 pglite / elkjs / react
 * 一整套，@napi-rs/canvas 带着 27MB 的平台二进制）。
 * 这些目录不会被 pnpm 自动回收，打进安装包就是纯浪费。
 */
function sweepOrphans(nmDir) {
  const pnpmDir = join(nmDir, '.pnpm');
  if (!existsSync(pnpmDir)) return;
  const entries = readdirSync(pnpmDir).filter((n) => n !== 'lock.yaml' && !n.startsWith('node_modules'));

  /** 每个 .pnpm 条目依赖了哪些 .pnpm 条目 */
  const depsOf = new Map();
  for (const entry of entries) {
    const inner = join(pnpmDir, entry, 'node_modules');
    const deps = new Set();
    if (existsSync(inner)) {
      for (const name of readdirSync(inner)) {
        if (name.startsWith('@')) {
          const scopeDir = join(inner, name);
          if (!existsSync(scopeDir)) continue;
          for (const sub of readdirSync(scopeDir)) collectLink(join(scopeDir, sub), deps);
        } else {
          collectLink(join(inner, name), deps);
        }
      }
    }
    depsOf.set(entry, deps);
  }

  /** 顶层软链 = 依赖树的根 */
  const roots = new Set();
  for (const name of readdirSync(nmDir)) {
    if (name === '.pnpm') continue;
    const p = join(nmDir, name);
    if (name.startsWith('@')) {
      if (!existsSync(p)) continue;
      for (const sub of readdirSync(p)) collectLink(join(p, sub), roots);
    } else {
      collectLink(p, roots);
    }
  }

  // 从根出发求传递闭包
  const reachable = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || reachable.has(entry)) continue;
    reachable.add(entry);
    for (const dep of depsOf.get(entry) ?? []) stack.push(dep);
  }

  for (const entry of entries) {
    if (reachable.has(entry)) continue;
    drop(join(pnpmDir, entry), '不再被任何入口引用的传递依赖');
  }

  // 清掉指向已删目录的断链（否则打包时 rsync 会报错，运行时 require 也会抛）
  for (const entry of entries) {
    const inner = join(pnpmDir, entry, 'node_modules');
    if (!existsSync(inner)) continue;
    for (const name of readdirSync(inner)) {
      const targets = name.startsWith('@')
        ? (existsSync(join(inner, name)) ? readdirSync(join(inner, name)).map((s) => join(inner, name, s)) : [])
        : [join(inner, name)];
      for (const t of targets) {
        try {
          if (lstatSync(t).isSymbolicLink() && !existsSync(t)) {
            rmSync(t, { force: true });
            savedBytes += 0;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  // .pnpm/node_modules 是 pnpm 的「隐藏仓库」：每个包都有一条软链指向自己的 .pnpm 条目。
  // 孤儿扫描删掉 .pnpm 条目后，这里会留下一批指向空处的悬空软链 ——
  // 打包器复制到一半会 stat 失败（实测 ENOENT: .../.pnpm/node_modules/classnames）。
  removeDanglingLinks(join(pnpmDir, 'node_modules'));
}

/** 递归摘除指向不存在目标的软链（只处理一层，够覆盖 node_modules 的布局） */
function removeDanglingLinks(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name.startsWith('@')) {
      if (!existsSync(p)) continue;
      for (const sub of readdirSync(p)) {
        const t = join(p, sub);
        try {
          if (lstatSync(t).isSymbolicLink() && !existsSync(t)) rmSync(t, { force: true });
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    try {
      if (lstatSync(p).isSymbolicLink() && !existsSync(p)) rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- 1. 编译

if (!SKIP_BUILD) {
  log('编译 API 与前端');
  run('pnpm', ['--filter', '@app/api', 'build']);
  run('pnpm', ['--filter', '@app/web', 'build']);
} else {
  log('跳过编译（--skip-build）');
}

// ---------------------------------------------------------------- 2. 清理

log('清空 runtime 目录');
rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(RUNTIME, { recursive: true });

// ---------------------------------------------------------------- 3. API 运行时

log('部署 API 运行时（pnpm deploy --prod）');
run('pnpm', ['--filter', '@app/api', 'deploy', '--prod', join(RUNTIME, 'api')]);

const API_DIR = join(RUNTIME, 'api');
const NM = join(API_DIR, 'node_modules');
const NM_PNPM = join(NM, '.pnpm');

// Prisma 7 起 `prisma generate` 不再由安装流程自动触发，客户端是生成产物
// （落在 node_modules/.pnpm/@prisma+client@.../node_modules/.prisma/client），
// 不在 npm 包内容里 —— deploy 出来的运行时必须自己再生成一次，
// 否则 API 起来就报 "Named export 'PrismaClient' not found"。
log('生成 Prisma Client（Prisma 7 不随安装自动生成）');
run('node', [join(NM, 'prisma/build/index.js'), 'generate'], API_DIR);

// 部署会把整个包目录一起复制过来，这些是「仓库里用、运行时不用」的东西。
// uploads/ 尤其重要：它是业务产物目录（本机有 165MB），进包等于把用户数据塞进安装包。
for (const junk of [
  'src',
  'test',
  'uploads',
  'Dockerfile',
  'comfyui-workflow.json',
  'nest-cli.json',
  'tsconfig.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
]) {
  drop(join(API_DIR, junk), '源码/测试/业务数据，运行时不需要');
}

// ---------------------------------------------------------------- 3.1 Prisma 配置改成纯 JS

/**
 * 桌面端运行时要用自己的 Prisma 配置（纯 JS），不能用仓库里的 prisma.config.ts。
 *
 * 原因不是「TS 看着不高级」，是**签名与公证的硬约束**：
 * Prisma CLI 用 jiti 加载 .ts 配置时，会把转译结果缓存到
 * `node_modules/.cache/jiti/` —— 那目录在**已签名的 app bundle 里面**。
 * 往里写一个文件，codesign 的封印（CodeResources）就对不上了，
 * Apple 公证会直接拒收：
 *   - 主可执行文件「The signature of the binary is invalid」
 *   - 报「file added: .../.cache/jiti/xxx.mjs」
 * .mjs 是纯 JS，jiti 不需要转译，**不写缓存**（实测缓存目录为空）。
 *
 * 另外 .ts 与 .mjs 同时存在时 c12 仍可能优先挑 .ts，所以 .ts 必须删掉。
 */
const RUNTIME_PRISMA_CONFIG = `// 桌面端运行时专用的 Prisma 配置（由 scripts/prepare-runtime.mjs 生成，勿手改）。
//
// 为什么不直接用仓库里的 prisma.config.ts：
//   1. 桌面端不跑 prisma db seed（它跑编译产物 dist/src/seed/cli.js），seed 配置用不上；
//   2. **关键**：Prisma CLI 用 jiti 加载 .ts 配置时会把转译缓存写进
//      node_modules/.cache/jiti/ —— 那是**已签名 app bundle 内部**，
//      写进去就破坏 codesign 封印，Apple 公证直接拒收。
//      .mjs 是纯 JS，jiti 不转译、不写缓存。
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // generate 不连数据库；migrate 由桌面端注入真实连接串
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
`;
drop(join(API_DIR, 'prisma.config.ts'), 'TS 版配置会触发 jiti 缓存写入，改用 .mjs');
writeFileSync(join(API_DIR, 'prisma.config.mjs'), RUNTIME_PRISMA_CONFIG, 'utf8');
log('写入桌面端专用 prisma.config.mjs（纯 JS，不触发 jiti 缓存）');
// 预置空的 jiti 缓存目录：CLI 会去建它，空目录已存在就不会在 bundle 里新增目录。
// 里面残留的文件要清掉 —— 那是 `prisma generate` 阶段用 .ts 配置时留下的，
// 运行时已经改用 .mjs，它不会再被用到（留着只是死重，还会被签进封印）。
mkdirSync(join(NM, '.cache', 'jiti'), { recursive: true });
for (const name of readdirSync(join(NM, '.cache', 'jiti'))) {
  const p = join(NM, '.cache', 'jiti', name);
  rmSync(p, { recursive: true, force: true });
  log(`清掉 jiti 缓存残留：${rel(p)}`);
}

// ---------------------------------------------------------------- 3.2 记录 schema engine 位置

/**
 * 找出当前平台的 Prisma schema engine（migrate 用的那个 Rust 二进制），
 * 把它的**相对路径**记进清单。
 *
 * 为什么必须记：Prisma CLI 启动时会校验引擎的校验和，发现和官方发布的不一致就
 * **把引擎恢复成原始副本**（实测：签了 Developer ID 的引擎跑一次 migrate 就变回 adhoc）。
 * 而包内引擎是 app bundle 的一部分，被改掉就破坏封印 → 公证被拒。
 * 所以桌面端启动时要把引擎**复制到 bundle 之外**再用
 * （见 apps/desktop/src/migrate.ts），复制源就是这里记下的路径。
 */
const ENGINE_NAME = `schema-engine-${process.platform}-${process.arch}`;
/**
 * Windows 上 Prisma 引擎带 `.exe` 后缀（schema-engine-win32-x64.exe），
 * Unix 上没有。两种名字都要试，否则在 Windows 上必然报「找不到引擎」。
 */
function findSchemaEngine() {
  if (!existsSync(NM_PNPM)) return null;
  const names = process.platform === 'win32' ? [ENGINE_NAME, `${ENGINE_NAME}.exe`] : [ENGINE_NAME];
  for (const entry of readdirSync(NM_PNPM)) {
    if (!entry.startsWith('@prisma+engines@')) continue;
    for (const name of names) {
      const p = join(NM_PNPM, entry, 'node_modules', '@prisma', 'engines', name);
      if (existsSync(p)) return { path: p, name, version: entry.slice('@prisma+engines@'.length) };
    }
  }
  return null;
}
const engine = findSchemaEngine();
if (!engine) {
  throw new Error(`运行时里找不到 ${ENGINE_NAME}（@prisma/engines 目录异常）`);
}
const schemaEngine = engine.path;
const engineRelative = schemaEngine.slice(API_DIR.length + 1);
log(`schema engine：${engineRelative}（@prisma/engines ${engine.version}）`);

// ---------------------------------------------------------------- 4. PostgreSQL

if (!PG_PACKAGE) {
  throw new Error(`当前平台 ${process.platform}-${process.arch} 没有对应的 @embedded-postgres 包`);
}
const pgPkgDir = join(DESKTOP_DIR, 'node_modules', '@embedded-postgres', `${process.platform}-${process.arch}`);
if (!existsSync(pgPkgDir)) {
  throw new Error(`缺少内嵌 PostgreSQL 包：${pgPkgDir}（先跑 pnpm install）`);
}
const pgNative = join(pgPkgDir, 'native');
log(`复制内嵌 PostgreSQL（${PG_PACKAGE}）`);
const PG_DIR = join(RUNTIME, 'pg');
mkdirSync(PG_DIR, { recursive: true });
// verbatimSymlinks: true —— 包里的 lib 目录用相对软链做版本别名
// （libcrypto.dylib -> libcrypto.3.dylib）。
// Node 的 fs.cp 默认 verbatimSymlinks=false，会把软链**改写成指向源的绝对路径**，
// 打包后这些路径在用户机器上不存在，等于留下一堆坏链。
// 保持相对软链原样，既不重复拷贝内容，运行时也照样解析得到。
cpSync(pgNative, PG_DIR, { recursive: true, verbatimSymlinks: true });

// ---------------------------------------------------------------- 5. 前端产物

log('复制前端产物');
const WEB_DIR = join(RUNTIME, 'web');
mkdirSync(WEB_DIR, { recursive: true });
cpSync(join(REPO_ROOT, 'apps/web/dist'), join(WEB_DIR, 'dist'), { recursive: true });

// ---------------------------------------------------------------- 6. 体积裁剪

if (!NO_TRIM) {
  log('裁剪运行时体积');

  // 6.1 全局：sourcemap 与 TS 声明在运行时没有消费者。
  //     这两项在依赖树里零散分布，逐个包裁剪容易漏，统一递归清一遍。
  stripFiles(NM, (n) => n.endsWith('.map'), 'sourcemap');
  stripFiles(NM, (n) => n.endsWith('.d.ts') || n.endsWith('.d.mts'), 'TS 类型声明');

  // 6.2 Prisma Client 运行时：每个方言都带两份 base64 版 query compiler
  //     （fast + small，各 .js/.mjs），5 个方言约 65MB。桌面端只用 postgresql。
  dropMatching(
    join(NM, '@prisma/client/runtime'),
    (name) => /^query_compiler_(fast|small)_bg\./.test(name) && DIALECT_RE.test(name),
    '只保留 postgresql 方言的 query compiler',
  );

  // 6.3 pdfjs-dist：api 只用 legacy/build/pdf.mjs 抽文本，
  //     但 cmaps（中日韩字形编码）与标准字体在真实 PDF 上会被用到，保留。
  if (existsSync(NM_PNPM)) {
    for (const entry of readdirSync(NM_PNPM)) {
      if (!entry.startsWith('pdfjs-dist@')) continue;
      const pdfjs = join(NM_PNPM, entry, 'node_modules/pdfjs-dist');
      drop(join(pdfjs, 'build'), 'api 只用 legacy 版，非 legacy 版是重复副本');
      drop(join(pdfjs, 'web'), '浏览器渲染版，桌面端不渲染');
      drop(join(pdfjs, 'types'), 'TS 类型声明');
      drop(join(pdfjs, 'legacy/web'), '浏览器渲染版，桌面端不渲染');
      dropMatching(join(pdfjs, 'legacy/build'), (n) => n.endsWith('.min.mjs'), '压缩版副本，运行时用不到');
      dropMatching(join(pdfjs, 'legacy/build'), (n) => n.startsWith('pdf.sandbox'), 'sandbox 变体与 legacy 版重复');
    }
  }

  // 6.4 Swagger UI 静态资源：生产环境不挂 Swagger（main.ts 里 !IS_PROD 才 setup），
  //     11MB 纯静态资源，没必要进包。
  if (existsSync(NM_PNPM)) {
    for (const entry of readdirSync(NM_PNPM)) {
      if (!entry.startsWith('swagger-ui-dist@')) continue;
      drop(join(NM_PNPM, entry, 'node_modules/swagger-ui-dist'), '生产环境不暴露 Swagger 文档');
    }
  }

  // 6.5 Prisma CLI 会饿汉加载 Prisma Studio 的后端与 @prisma/dev 的状态模块，
  //     这两个包**不能整包删**（删了 CLI 启动就报 MODULE_NOT_FOUND）。
  //     但它们内部绝大部分内容跟「跑一次 migrate」无关，按 CLI 实际引用的子路径裁：
  //       @prisma/studio-core/data/{bff,mysql2,node-sqlite,postgresjs}
  //       @prisma/dev/internal/state
  //     可裁掉的：Studio 的 Web UI（29MB）、构建元数据（5MB）、用不到的 pglite 连接器
  //     （连带 19MB 的 pglite 引擎）、@prisma/dev 的 dev server 运行时资产（18MB），
  //     以及只服务于 UI 的 react / elkjs / d3 / visx / radix 一整套（约 30MB）。
  //     已实测：裁完 `prisma migrate deploy` 与 `prisma generate` 均正常退出（exit 0）。
  const studioCore = findInPnpm(NM_PNPM, '@prisma+studio-core@', '@prisma/studio-core');
  if (studioCore) {
    drop(join(studioCore, 'dist/ui'), 'Prisma Studio 的 Web UI，桌面端不跑 studio');
    dropMatching(join(studioCore, 'dist'), (n) => n.startsWith('metafile-'), '构建元数据，运行时不用');
    for (const unused of ['pglite', 'mysql-core', 'postgres-core', 'sqlite-core', 'sqljs']) {
      drop(join(studioCore, 'dist/data', unused), 'CLI 只用 bff/mysql2/node-sqlite/postgresjs 四个连接器');
    }
    // studio-core 的依赖清单里只有 UI 用的东西（react / elkjs / d3 / visx / radix）
    // 与用不到的 pglite 引擎（21MB），data/* 是自包含 bundle，用不到它们 ——
    // 摘掉这些链接后由孤儿扫描回收
    const scModules = join(studioCore, '..', '..');
    for (const dep of ['react', 'react-dom', 'elkjs', 'd3-array', 'd3-shape', '@radix-ui', '@visx', '@types', '@electric-sql']) {
      const p = join(scModules, dep);
      if (!existsSync(p)) continue;
      rmSync(p, { recursive: true, force: true });
      log(`  摘除 ${rel(p)} —— 只服务于 Studio UI 的依赖`);
    }
  }
  const devPkg = findInPnpm(NM_PNPM, '@prisma+dev@', '@prisma/dev');
  if (devPkg) {
    drop(join(devPkg, 'dist/runtime-assets'), 'prisma dev 的运行时资产，桌面端不用 dev server');
  }
  // @napi-rs/canvas 是 pdfjs 的传递依赖（不在顶层），按 .pnpm 条目名清。
  // api 只用 pdfjs 抽文本、不渲染，pdfjs 内部对 canvas 是 try/catch 的软依赖
  // （模块初始化时 require 失败只会打一条 warn）。
  if (existsSync(NM_PNPM)) {
    for (const entry of readdirSync(NM_PNPM)) {
      if (entry.startsWith('@napi-rs+canvas')) {
        drop(join(NM_PNPM, entry), 'pdfjs 的画布实现：桌面端只抽文本不渲染');
      }
    }
  }
  // 这里**不要**裁 @prisma/engines 的原生 schema-engine-<platform>：
  // Prisma CLI 发现它缺失时会**自动去下载**（实测设了不可达代理仍能下载成功，说明它不走代理）。
  // 裁掉它等于把「首次启动必须联网下载 24MB」写进产品 —— 桌面端必须能完全离线跑，
  // 所以这个 24MB 必须留在包里。
  // 代价：运行时必须**在目标平台上准备**（引擎是按平台编译的），
  // 跨平台产物要在对应平台的机器上跑 prepare:runtime。

  // 6.6 Prisma CLI：同样按方言裁剪，另外去掉用不到的 studio 前端
  const prismaBuild = join(NM, 'prisma/build');
  dropMatching(
    prismaBuild,
    (name) => /^query_compiler_(fast|small)_bg\./.test(name) && DIALECT_RE.test(name),
    '只保留 postgresql 方言的 query compiler',
  );
  drop(join(prismaBuild, 'studio.js'), '桌面端不需要 prisma studio');
  drop(join(prismaBuild, 'studio.css'), '桌面端不需要 prisma studio');
  drop(join(prismaBuild, 'completion.js'), 'shell 补全脚本');
  drop(join(prismaBuild, 'xdg-open'), 'Linux 专用');

  // 6.6.1 删掉 pglite 引擎的**实体目录**（20MB）
  //     上面 6.5 已经摘掉了 studio-core 对 @electric-sql 的引用，
  //     但 pnpm 的实体目录 `node_modules/.pnpm/@electric-sql+pglite@0.4.3/`
  //     不会因为链接被摘掉而自动消失 —— 孤儿扫描只认顶层软链，认不出 .pnpm 条目。
  //     实测该包已无人引用（dist 里也没有任何 pglite 引用），
  //     桌面端用的是**真实 PostgreSQL 进程**，pglite 是另一套 WASM 实现，用不上。
  //     删掉的是 pglite.wasm(8.3MB) + pglite.data(5MB) + pgcrypto.tar.gz(1.1MB)。
  if (existsSync(NM_PNPM)) {
    for (const entry of readdirSync(NM_PNPM)) {
      if (entry.startsWith('@electric-sql+pglite@')) {
        drop(join(NM_PNPM, entry), 'pglite 引擎实体目录：桌面端用真实 PostgreSQL，且已无人引用');
      }
    }
  }

  // 6.7 扫描清除孤儿传递依赖：上面移掉的顶层包，其独占依赖会变成孤儿目录
  sweepOrphans(NM);
}

// ---------------------------------------------------------------- 7. 体积报告

const pgSize = dirSize(PG_DIR);
const apiSize = dirSize(API_DIR);
const webSize = dirSize(WEB_DIR);
const total = pgSize + apiSize + webSize;

const report = [
  '# 桌面端运行时资源（prepare-runtime 产出）',
  '',
  '| 目录 | 内容 | 体积 |',
  '| --- | --- | --- |',
  `| runtime/pg | 内嵌 PostgreSQL（${PG_PACKAGE}） | ${fmtSize(pgSize)} |`,
  '| runtime/api | API 编译产物 + 生产依赖 | ' + fmtSize(apiSize) + ' |',
  '| runtime/web | 前端产物 | ' + fmtSize(webSize) + ' |',
  `| **合计** | | **${fmtSize(total)}** |`,
  '',
  NO_TRIM ? '本次未做体积裁剪。' : `本次裁剪共省下 ${fmtSize(savedBytes)}。`,
  '',
].join('\n');
writeFileSync(join(RUNTIME, 'SIZE.md'), report, 'utf8');

// 运行时清单：桌面端主进程靠它找到 schema engine（要把引擎复制到 bundle 之外再用）
writeFileSync(
  join(RUNTIME, 'manifest.json'),
  `${JSON.stringify({
    platform: `${process.platform}-${process.arch}`,
    schemaEngine: engineRelative,
    // 用**实际文件名**（Windows 上带 .exe）：桌面端复制到 bundle 外时按它命名
    schemaEngineName: engine.name,
    // 引擎版本进清单：桌面端用它给「bundle 外的引擎副本」命名，
    // 升级到新的 Prisma 版本时会自动换新文件名，不会误用旧引擎。
    schemaEngineVersion: engine.version,
  }, null, 2)}\n`,
  'utf8',
);
log(`运行时清单已写入 ${join(RUNTIME, 'manifest.json')}`);

log('');
log(report);
log(`资源清单已写入 ${join(RUNTIME, 'SIZE.md')}`);
