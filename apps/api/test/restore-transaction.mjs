/**
 * restore replace 模式的实跑检查（连真库）。
 *
 * **为什么单独写**：smoke.ts 只覆盖 merge 模式，而 replace 是本轮改动里风险最高的一处
 * （清空 + 回填放进事务 + 逐行 SAVEPOINT 隔离）。它必须证明三件事：
 *   1) replace 真的先清空再回填（不是静默跳过清空）；
 *   2) 一行坏数据（**服务端**唯一键冲突）只废掉这一行，其余行照样恢复；
 *   3) 失败被逐表上报（响应里能看到 failed 明细），而不是被空 catch 吞掉。
 *
 * 为什么第 2 条必须用「重复主键」而不是「字段缺失」：
 * 字段缺失是 Prisma **客户端**校验就拦下的，压根没发 SQL，事务没被毒化；
 * 重复主键才会真的把 PostgreSQL 事务打进 aborted 状态 —— 那才是 SAVEPOINT 要解决的问题。
 *
 * 用哪张表：LightingScene（冒烟后为空，且无外键依赖）。
 * 跑之前先断言该表为空 —— 不为空就直接退出，绝不碰真实数据。
 *
 * 运行：
 *   node apps/api/test/restore-transaction.mjs
 *
 * 退出码：0 全过 / 1 有断言失败。脚本结束前会把测试行删干净。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 连接串从仓库根 .env 读（Prisma 客户端不会自己加载 .env）
try {
  // apps/api/test/ -> apps/api/ -> apps/ -> 仓库根
  const envTxt = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
  for (const line of envTxt.split('\n')) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  // 没有 .env 就走环境变量
}

const dist = join(here, '..', 'dist', 'src');
const { PrismaService } = await import(pathToFileURL(join(dist, 'prisma', 'prisma.module.js')).href);
const { BackupController } = await import(pathToFileURL(join(dist, 'admin', 'backup.controller.js')).href);

let failed = 0;
let passed = 0;
function check(name, ok, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.error(`✗ ${name}${extra ? ' —— ' + extra : ''}`);
  }
}

const prisma = new PrismaService();
await prisma.$connect();

// config / media 这两个依赖在 restore 里用不到，传最小桩即可
const controller = new BackupController(prisma, { get: (_k, d) => d }, {});

const TABLE = 'lightingScene';
const ID_A = 'aaaaaaaa-0000-4000-8000-00000000a001';
const ID_B = 'aaaaaaaa-0000-4000-8000-00000000b002';
const ID_SENTINEL = 'aaaaaaaa-0000-4000-8000-00000000c003';

const row = (id, title) => ({
  id,
  tenantId: 'restore-check-tenant',
  userId: 'restore-check-user',
  title,
  ratio: '16:9',
  fixtures: [],
  timeline: { durationMs: 1000, tracks: [] },
  status: 'draft',
});

try {
  const before = await prisma.lightingScene.count();
  check(`前置条件：${TABLE} 表为空（不碰真实数据）`, before === 0, `实际 ${before} 行`);

  if (before !== 0) {
    console.error('✗ 表非空，放弃测试（避免破坏真实数据）');
    process.exit(1);
  }

  // 放一条「旧数据」：replace 必须先清空它
  await prisma.lightingScene.create({ data: row(ID_SENTINEL, 'replace 前的旧数据') });

  // 三行输入：两行正常 + 一行与第二行主键重复（服务端唯一键冲突）
  // 直接调用控制器方法：第一个参数是 Nest 注入的 user，第二个才是 body
  const res = await controller.restore(null, {
    tables: {
      [TABLE]: [row(ID_A, '正常行 A'), row(ID_B, '正常行 B'), row(ID_B, '重复主键行')],
    },
    mode: 'replace',
    confirmToken: 'RESTORE',
  });

  check('replace 返回逐表写入条数（2 行成功）', res.restored[TABLE] === 2, `实际 ${res.restored[TABLE]}`);
  check(
    '失败被逐表上报（不是空 catch 吞掉）',
    Array.isArray(res.failed) && res.failed.length === 1
      && res.failed[0].table === TABLE && res.failed[0].failed === 1 && Boolean(res.failed[0].reason),
    JSON.stringify(res.failed),
  );

  const rows = await prisma.lightingScene.findMany({ select: { id: true, title: true } });
  const ids = rows.map((r) => r.id).sort();
  check(
    '一行坏数据没有毁掉整次恢复（事务未被毒化，其余行在库里）',
    ids.length === 2 && ids.includes(ID_A) && ids.includes(ID_B),
    `库里实际：${JSON.stringify(ids)}`,
  );
  check(
    'replace 真的先清空再回填（旧数据已不在）',
    !ids.includes(ID_SENTINEL),
    `旧数据仍在：${JSON.stringify(ids)}`,
  );
} catch (e) {
  failed += 1;
  console.error(`✗ 跑挂了：${e?.stack ?? e}`);
} finally {
  // 清理：把测试行删干净，表回到空
  try {
    await prisma.lightingScene.deleteMany({
      where: { id: { in: [ID_A, ID_B, ID_SENTINEL] } },
    });
    const left = await prisma.lightingScene.count();
    console.log(`清理后 ${TABLE} 行数：${left}`);
  } catch (e) {
    console.error(`清理失败（需人工处理）：${e?.message ?? e}`);
  }
  await prisma.$disconnect();
}

console.log('');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
