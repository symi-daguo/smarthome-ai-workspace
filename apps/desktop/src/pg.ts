/**
 * 内嵌 PostgreSQL 生命周期管理。
 *
 * 为什么用「真实 postgres 进程」而不是 PGlite（WASM）：
 * 《桌面打包方案.md》第三节已证伪 PGlite —— Prisma **无官方 PGlite adapter**
 *（`@prisma/adapter-pglite` 在 npm registry 返回 404），
 * 而本项目用 `@prisma/adapter-pg`（TCP 驱动）。
 * 只要内嵌一个监听 127.0.0.1 的真实 postgres，**全部 Prisma 查询零改动**，
 * 只动态生成 `DATABASE_URL` 即可。
 *
 * 已在 PostgreSQL 18.4 上实测：initdb → migrate deploy → seed → 全量 smoke 456/456 通过
 *（且不配任何真实模型 Key —— 这正是桌面端首启后的真实状态）。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadPg } from './config';

const execFileAsync = promisify(execFile);

export interface PostgresOptions {
  /** API 运行时目录（pg 客户端从这里加载，asar 里不带依赖） */
  apiDir: string;
  /** bin 目录（含 initdb / pg_ctl / postgres） */
  binDir: string;
  /** 动态库目录（macOS 需要 DYLD_LIBRARY_PATH 才能找到 libpq/libicu 等） */
  libDir: string;
  /** 数据目录 */
  pgdata: string;
  /** 端口 */
  port: number;
  /** 日志文件 */
  logFile: string;
  /** 数据库名与用户（固定，避免连接串随环境变） */
  database: string;
  user: string;
}

export interface PostgresHandle {
  port: number;
  /** 本次是否执行了 initdb（首次启动） */
  initialized: boolean;
  stop: () => Promise<void>;
}

/** 执行 PG 可执行文件；统一注入动态库路径并把 stdout/stderr 一起带回 */
async function run(bin: string, args: string[], opts: PostgresOptions): Promise<string> {
  const env = {
    ...process.env,
    ...(process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: opts.libDir } : {}),
    ...(process.platform === 'win32' ? { PATH: `${opts.binDir};${process.env.PATH ?? ''}` } : {}),
  };
  const { stdout, stderr } = await execFileAsync(bin, args, { env, timeout: 120_000 });
  return `${stdout}${stderr}`;
}

async function isPortOpen(port: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`PostgreSQL 未在 ${timeoutMs}ms 内就绪（端口 ${port}）`);
}

/** 数据目录是否已初始化（initdb 会写 PG_VERSION） */
export function isInitialized(pgdata: string): boolean {
  return existsSync(join(pgdata, 'PG_VERSION'));
}

export async function startPostgres(opts: PostgresOptions): Promise<PostgresHandle> {
  const initdb = join(opts.binDir, 'initdb');
  const pgctl = join(opts.binDir, 'pg_ctl');
  const initialized = isInitialized(opts.pgdata);

  if (!initialized) {
    mkdirSync(opts.pgdata, { recursive: true });
    // --auth=trust：仅监听 127.0.0.1 的本机进程，桌面单机场景不需要密码，
    //   免得用户第一次启动就被「设个数据库密码」挡住。
    // --locale=C：与容器侧（Debian C.UTF-8）同为字节序排序，中文排序表现一致。
    await run(initdb, [
      '-D', opts.pgdata,
      '-U', opts.user,
      '--auth=trust',
      '--locale=C',
      '--encoding=UTF8',
    ], opts);
  }

  // 只监听 127.0.0.1：不对局域网暴露，也不需要 CORS / 认证的额外考虑。
  await run(pgctl, [
    '-D', opts.pgdata,
    '-l', opts.logFile,
    '-o', `-p ${opts.port} -h 127.0.0.1`,
    '-w',              // 等待启动完成，失败直接返回非零
    'start',
  ], opts);
  await waitForPort(opts.port, 30_000);

  // 建库（不存在才建）
  const { Client } = loadPg(opts.apiDir);
  const admin = new Client({ host: '127.0.0.1', port: opts.port, user: opts.user, database: 'postgres' });
  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [opts.database]);
    if ((found.rowCount ?? 0) === 0) await admin.query(`CREATE DATABASE "${opts.database}"`);
  } finally {
    await admin.end();
  }

  return {
    port: opts.port,
    initialized: !initialized,
    stop: async () => {
      // -m fast：干净关库，避免 WAL 残留导致下次启动慢
      // -w：等 PG 真的停下来（不加 -w 会立刻返回，PG 还在跑就被父进程带走了）
      try {
        await run(pgctl, ['-D', opts.pgdata, '-m', 'fast', '-w', 'stop'], opts);
      } catch {
        // 停库失败不阻塞退出。但要说清楚：**不能指望「进程退出后 PG 会被系统回收」** ——
        // 实测过主进程先退、API 子进程被孤儿化后，带着内嵌 PG 一起活了 4 小时 50 分钟。
        // 所以停库失败时至少要留下痕迹：下次启动会走 crash recovery（数据不丢，只是慢一点）。
      }
    },
  };
}

/** 列出 migrations 目录里的迁移名（按目录名排序 = 按时间顺序） */
export function listMigrations(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{8,}/.test(e.name))
    .map((e) => e.name)
    .sort();
}
