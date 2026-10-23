/**
 * 数据库迁移与种子编排（桌面端首启 / 升级时自动跑）。
 *
 * 关键点：内嵌的原生 PostgreSQL **不带 pgvector 扩展**，而项目的历史迁移里
 * 有一条 `CREATE EXTENSION IF NOT EXISTS vector`（20260924160000，为将来的
 * 向量检索预备）。当前 schema.prisma 里**没有任何 vector 列**（知识库用本地
 * bigram），所以这条扩展对功能没有任何影响。
 *
 * 处理方式（零侵入，不改历史迁移、不影响容器端）：
 *   1. 先照常 `migrate deploy`；
 *   2. 若失败原因正是「extension "vector" is not available」，
 *      用官方 `migrate resolve --applied` 把那一条标记为已应用
 *      （此时它之前的迁移都已应用，resolve 的前提条件满足）；
 *   3. 再 `migrate deploy` 继续后面的迁移。
 *
 * 用官方 CLI 而不是自己实现迁移引擎：checksum 算法、失败回滚、
 * `_prisma_migrations` 维护都是 Prisma 的语义，自己写一份必然走偏。
 */
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { loadPg } from './config';
const execFileAsync = promisify(execFile);

/**
 * 跑 Node 脚本的环境变量。
 *
 * 关键点：在 Electron 里 `process.execPath` 是 **Electron 可执行文件**而不是 node，
 * 直接 `execFile(process.execPath, ['xxx.js'])` 会让 Electron 把脚本当成应用去打开。
 * 必须带上 ELECTRON_RUN_AS_NODE=1，Electron 才会退化成纯 Node 运行时。
 * （在纯 Node 下这个变量无副作用。）
 */
const NODE_ENV = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
};

export const PGVECTOR_MIGRATION = '20260924160000_enable_pgvector';

/** 运行时清单（prepare-runtime 产出） */
export interface RuntimeManifest {
  platform: string;
  /** schema engine 相对 api 目录的路径 */
  schemaEngine: string;
  schemaEngineName: string;
  /** @prisma/engines 的版本，用于给 bundle 外的引擎副本命名 */
  schemaEngineVersion: string;
}

export interface MigrateOptions {
  /** Prisma CLI 入口（node_modules/prisma/build/index.js） */
  prismaCli: string;
  /** api 运行时目录（其下有 prisma/schema.prisma 与 prisma/migrations） */
  apiDir: string;
  databaseUrl: string;
  log: (msg: string) => void;
  /** 运行时清单路径（runtime/manifest.json） */
  manifestFile: string;
  /** 可写目录（userData），用来放「包外的引擎副本」 */
  workDir: string;
}

/**
 * 把 Prisma schema engine 复制到 **bundle 之外**，并让 CLI 用这份副本。
 *
 * ## 为什么必须复制出去
 *
 * Prisma CLI 启动时会校验引擎二进制的校验和，发现和官方发布的不一致，
 * 就**把引擎恢复成原始副本**（实测：签了 Developer ID 的引擎，跑一次 migrate 就变回 adhoc）。
 *
 * 而包内引擎是 app bundle 的一部分：
 * - 引擎被恢复 → 它不再是 Developer ID 签名 → Apple 公证直接拒：
 *   「The binary is not signed with a valid Developer ID certificate」
 *   「The signature does not include a secure timestamp」
 *   「The executable does not have the hardened runtime enabled」
 * - 引擎内容变了 → codesign 的封印对不上 → 主可执行文件被判为
 *   「The signature of the binary is invalid」
 *
 * ## 为什么复制而不是直接指过去
 *
 * 直接把 `PRISMA_SCHEMA_ENGINE_BINARY` 指向包内那份，CLI 照样会把它恢复掉
 * （恢复源就是包内 @prisma/engines 的那份）。复制到 bundle 之外后，
 * CLI 改的是 userData 里的副本，包内那份保持签名不变 —— 实测确认。
 */
function prepareEngineCopy(opts: MigrateOptions): string {
  const manifest = JSON.parse(readFileSync(opts.manifestFile, 'utf8')) as RuntimeManifest;
  const src = join(opts.apiDir, manifest.schemaEngine);
  if (!existsSync(src)) {
    throw new Error(`运行时里找不到 schema engine：${src}`);
  }
  const dir = join(opts.workDir, 'prisma-engine');
  // 文件名带引擎版本：升级到新的 Prisma 版本时会自动换新文件名，
  // 不会因为「大小恰好相同」而继续用旧引擎。
  const dst = join(dir, `${manifest.schemaEngineName}-${manifest.schemaEngineVersion}`);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) return dst;
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
  opts.log(`schema engine 已复制到 bundle 之外：${dst}`);
  return dst;
}

async function prisma(
  opts: MigrateOptions,
  args: string[],
  engineBinary: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [opts.prismaCli, ...args], {
      cwd: opts.apiDir,
      env: {
        ...NODE_ENV,
        DATABASE_URL: opts.databaseUrl,
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        // 关键：让 CLI 用 bundle 之外的引擎副本，别去动已签名的包内引擎
        PRISMA_SCHEMA_ENGINE_BINARY: engineBinary,
      },
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}` };
  }
}

export async function runMigrations(opts: MigrateOptions): Promise<void> {
  const engineBinary = prepareEngineCopy(opts);
  const first = await prisma(opts, ['migrate', 'deploy'], engineBinary);
  if (first.ok) {
    opts.log('数据库迁移已是最新');
    return;
  }
  const missingVector = first.output.includes('extension "vector" is not available')
    || first.output.includes('extension vector is not available');
  if (!missingVector) {
    throw new Error(`数据库迁移失败：\n${first.output.slice(-2000)}`);
  }

  opts.log('检测到本机 PostgreSQL 未安装 pgvector 扩展（当前版本未使用向量列，按已应用处理）');
  const resolve = await prisma(opts, ['migrate', 'resolve', '--applied', PGVECTOR_MIGRATION], engineBinary);
  if (!resolve.ok) {
    throw new Error(`标记 pgvector 迁移为已应用失败：\n${resolve.output.slice(-2000)}`);
  }
  const second = await prisma(opts, ['migrate', 'deploy'], engineBinary);
  if (!second.ok) {
    throw new Error(`数据库迁移失败：\n${second.output.slice(-2000)}`);
  }
  opts.log('数据库迁移完成');
}

/**
 * 库里到底有没有管理员。
 *
 * 为什么不能只看配置里的 `migrated` 标记：
 * **标记与数据库的实际状态可能对不上** —— pgdata 被重建、种子中途失败、
 * 异常退出把库搞空，这几种情况下标记都还写着「已完成」。
 * 一旦对不上，种子会被**永远跳过**：用户装完打开应用，库里一个用户都没有，
 * 根本登不进去（实测踩到过：`migrated: true` 而 `"User"` 表为空）。
 *
 * 判据必须落在**数据**上，不能落在标记上。
 */
export async function adminExists(opts: {
  apiDir: string;
  databaseUrl: string;
  phone: string;
}): Promise<boolean> {
  const pg = loadPg(opts.apiDir);
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    const r = await client.query('SELECT 1 FROM "User" WHERE phone = $1 LIMIT 1', [opts.phone]);
    return (r.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

/** 跑种子（编译产物 dist/src/seed/cli.js，与容器端同一份逻辑） */
export async function runSeed(opts: {
  apiDir: string;
  seedCli: string;
  databaseUrl: string;
  adminPhone: string;
  adminPassword: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [opts.seedCli], {
    cwd: opts.apiDir,
    env: {
      ...NODE_ENV,
      DATABASE_URL: opts.databaseUrl,
      SEED_ADMIN_PHONE: opts.adminPhone,
      SEED_ADMIN_PASSWORD: opts.adminPassword,
    },
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = `${stdout}${stderr}`;
  const line = out.split('\n').filter((l) => l.includes('seed done')).pop() ?? '种子完成';
  opts.log(line.trim());
}
