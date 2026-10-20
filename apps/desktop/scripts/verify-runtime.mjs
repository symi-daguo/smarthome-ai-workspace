#!/usr/bin/env node
/**
 * 桌面端运行时验收脚本。
 *
 * 目的：证明 apps/desktop/runtime/ 里那套「裁剪过的」产物真的能独立跑起来 ——
 * 只装它自己带的 PG 二进制、只用它自己的 node_modules，不借用工作区的任何东西。
 * 裁剪（去方言 wasm、去 sourcemap、去 Prisma Studio、去 canvas）最容易踩的坑就是
 * 「装的时候没事，真跑起来少个文件」，所以这一步是必须的。
 *
 * 跑完会做 6 件事：
 *   1. 用 runtime/pg 起一个独立 PostgreSQL（临时数据目录 + 临时端口）
 *   2. 用 runtime/api 自带的 Prisma CLI 跑迁移（pgvector 缺失时走 resolve 绕过）
 *   3. 用 runtime/api 自带的种子 CLI 灌初始数据
 *   4. 起 runtime/api 的编译产物，检查 /api/health
 *   5. 用默认管理员账号登录，拿到 token
 *   6. 关掉 API 与数据库，清理临时目录
 *
 * 用法：node scripts/verify-runtime.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, '..');
const RUNTIME = join(DESKTOP_DIR, 'runtime');
const PG_DIR = join(RUNTIME, 'pg');
const API_DIR = join(RUNTIME, 'api');

const PG_PORT = 55439;
const API_PORT = 3089;
const DATABASE_URL = `postgresql://smarthome:smarthome@127.0.0.1:${PG_PORT}/smarthome`;
const ADMIN_PHONE = '13800000000';
const ADMIN_PASSWORD = 'Admin@123456';

const work = mkdtempSync(join(tmpdir(), 'symi-verify-'));
const pgdata = join(work, 'pgdata');
const pgLog = join(work, 'postgres.log');
const apiLog = join(work, 'api.log');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function pgEnv() {
  return {
    ...process.env,
    PATH: `${join(PG_DIR, 'bin')}:${process.env.PATH ?? ''}`,
    DYLD_LIBRARY_PATH: join(PG_DIR, 'lib'),
  };
}

function tryRun(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}` };
  }
}

let apiProc = null;

async function shutdown() {
  if (apiProc) {
    try {
      apiProc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  tryRun(join(PG_DIR, 'bin/pg_ctl'), ['-D', pgdata, '-m', 'fast', '-w', 'stop'], { env: pgEnv() });
  rmSync(work, { recursive: true, force: true });
}

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(1));
});

try {
  // ---- 0. 运行时目录必须存在 ----
  if (!existsSync(join(API_DIR, 'dist/src/main.js'))) {
    throw new Error('runtime/api 缺少编译产物，请先执行 node scripts/prepare-runtime.mjs');
  }
  check('运行时目录齐全（pg / api / web）', existsSync(PG_DIR) && existsSync(API_DIR) && existsSync(join(RUNTIME, 'web/dist')));

  // ---- 1. 起库 ----
  console.log('· 启动内嵌 PostgreSQL');
  const init = tryRun(join(PG_DIR, 'bin/initdb'), ['-D', pgdata, '-U', 'smarthome', '--auth=trust', '--locale=C', '--encoding=UTF8'], {
    env: pgEnv(),
  });
  if (!init.ok) throw new Error(`initdb 失败：${init.out}`);
  const start = tryRun(join(PG_DIR, 'bin/pg_ctl'), ['-D', pgdata, '-l', pgLog, '-o', `-p ${PG_PORT} -h 127.0.0.1`, '-w', 'start'], {
    env: pgEnv(),
  });
  if (!start.ok) throw new Error(`pg_ctl start 失败：${start.out}`);
  check('内嵌 PostgreSQL 启动成功', true);

  // 建库（用 runtime/api 自带的 pg 客户端，顺带验证 pg 包在裁剪后仍可用）
  const createdb = tryRun(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import pg from 'pg'; const c=new pg.Client({host:'127.0.0.1',port:${PG_PORT},user:'smarthome',database:'postgres'}); await c.connect(); const r=await c.query('SELECT 1 FROM pg_database WHERE datname=$1',['smarthome']); if(r.rowCount===0) await c.query('CREATE DATABASE smarthome'); await c.end();`,
    ],
    { cwd: API_DIR },
  );
  if (!createdb.ok) throw new Error(`建库失败：${createdb.out}`);
  check('建库成功（runtime 自带的 pg 客户端可用）', true);

  // ---- 2. 迁移 ----
  console.log('· 跑迁移');
  const prismaCli = join(API_DIR, 'node_modules/prisma/build/index.js');
  let deploy = tryRun(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL },
  });
  if (!deploy.ok) {
    const isVector = deploy.out.includes('extension "vector" is not available') || deploy.out.includes('extension vector is not available');
    if (!isVector) throw new Error(`migrate deploy 失败：${deploy.out.slice(-1500)}`);
    console.log('  · 检测到 pgvector 缺失，走 resolve 绕过');
    const resolveRun = tryRun(process.execPath, [prismaCli, 'migrate', 'resolve', '--applied', '20260924160000_enable_pgvector'], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL },
    });
    if (!resolveRun.ok) throw new Error(`migrate resolve 失败：${resolveRun.out.slice(-1500)}`);
    deploy = tryRun(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL },
    });
    if (!deploy.ok) throw new Error(`migrate deploy（绕过 pgvector 后）失败：${deploy.out.slice(-1500)}`);
  }
  check('迁移全部应用成功（runtime 自带的 Prisma CLI 可用）', true);

  // ---- 3. 种子 ----
  console.log('· 跑种子');
  const seed = tryRun(process.execPath, [join(API_DIR, 'dist/src/seed/cli.js')], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL, SEED_ADMIN_PHONE: ADMIN_PHONE, SEED_ADMIN_PASSWORD: ADMIN_PASSWORD },
  });
  if (!seed.ok) throw new Error(`种子失败：${seed.out.slice(-1500)}`);
  check('种子执行成功（默认管理员已预置）', seed.out.includes('seed done'), seed.out.slice(-200));

  // ---- 4. API ----
  console.log('· 启动 API');
  apiProc = spawn(
    process.execPath,
    [join(API_DIR, 'dist/src/main.js')],
    {
      cwd: API_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DESKTOP_MODE: '1',
        PORT: String(API_PORT),
        DATABASE_URL,
        JWT_SECRET: 'verify-runtime-secret-0123456789',
        SEED_ADMIN_PHONE: ADMIN_PHONE,
        SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let apiOut = '';
  apiProc.stdout?.on('data', (b) => { apiOut += b.toString(); });
  apiProc.stderr?.on('data', (b) => { apiOut += b.toString(); });

  let health = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/health`);
      if (r.ok) { health = await r.json(); break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('API 健康检查通过', health?.status === 'ok', apiOut.slice(-500));
  if (!health) throw new Error(`API 未就绪：${apiOut.slice(-1000)}`);

  // ---- 5. 默认管理员登录 ----
  const login = await fetch(`http://127.0.0.1:${API_PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD }),
  }).then((r) => r.json().catch(() => ({})));
  check('默认管理员账号密码可直接登录', typeof login.token === 'string' && login.token.length > 20);
  check('登录返回的管理员手机号正确', login.user?.phone === ADMIN_PHONE, JSON.stringify(login.user ?? {}).slice(0, 200));

  // ---- 6. 裁剪后的关键依赖仍在 ----
  check('Prisma 方言裁剪后仍保留 postgresql 编译器', existsSync(join(API_DIR, 'node_modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.js')));
  check('Prisma CLI 方言裁剪后仍保留 postgresql 编译器', existsSync(join(API_DIR, 'node_modules/prisma/build/query_compiler_fast_bg.postgresql.wasm')));
  check('生成的 Prisma 客户端在运行时内', readdirSync(join(API_DIR, 'node_modules/.pnpm')).some((n) => n.startsWith('@prisma+client@')));
} catch (e) {
  failures += 1;
  console.log(`FAIL 验收中断：${e.message}`);
} finally {
  await shutdown();
}

console.log('');
console.log(failures === 0 ? '运行时验收：全部通过' : `运行时验收：${failures} 项未通过`);
process.exit(failures === 0 ? 0 : 1);
