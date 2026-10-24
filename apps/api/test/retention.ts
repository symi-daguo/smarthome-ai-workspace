import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.module.js';
import {
  AgentService,
  AUTO_SNAPSHOT_KEEP,
  AUDIT_LOG_RETENTION_DAYS,
  selectExpiredAutoSnapshotIds,
  auditRetentionCutoff,
  isAuditLogExpired,
} from '../src/agent/agent.service.js';
import { IdempotencyService, IDEMPOTENCY_RETENTION_DAYS, IDEMPOTENCY_PURGE_EVERY } from '../src/common/idempotency.service.js';

/**
 * 保留期与写放大回归检查（1.0.7）
 *
 * 查的是四件长期运行才会爆 / 才会磨盘的事：
 *   ① ChangeSnapshot 无上限 —— 自动快照是整租户 JSON，越攒越胖（实测占备份 76.6%）
 *   ② AuditLog 无保留期 —— 只增不减的流水（实测 39746 行占 19.3%）
 *   ③ apiKey.lastUsedAt 每请求 UPDATE 同一行 —— Agent 每调一次就擦一次盘
 *   ④ idempotencyRecord 只增不减 —— purgeOlderThan 是零调用的死代码
 *
 * 写法分两半：
 *   纯函数部分（不需要库）：窗口边界、MANUAL 保护、保留期判定
 *   真库部分（需要 PostgreSQL）：真的造数据、真的跑生产代码的清理、真的查结果
 *
 * 真库部分必须能**证伪**：造 25 份 AUTO + 3 份 MANUAL，清理后必须只剩 20 份且 MANUAL 一份不少；
 * 造一条 91 天前的审计，必须被清掉；造一条昨天的，必须留着；
 * 造一条**别的租户**的 91 天前审计，必须**原封不动**（租户隔离）。
 *
 * 跑法（必须先 build，跑的是 dist 里的编译产物）：
 *   cd apps/api && node dist/test/retention.js
 */

const checks: [string, boolean][] = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` —— ${detail}`}`);
}

const DAY = 86_400_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 策略值在这里**写死**（不引用生产代码里的常量）。
 *
 * 原因：断言如果跟着生产常量走，改了常量它就跟着变 —— 永远绿，等于没检查。
 * 把「窗口 20 份」「保留 90 天」当成本检查认定的**政策**钉死在这里：
 * 谁改了生产常量而没改这里，检查立刻变红（要改政策就一起改，痕迹留在 diff 里）。
 */
const POLICY_SNAPSHOT_KEEP = 20;
const POLICY_AUDIT_RETENTION_DAYS = 90;

/** 造一批快照行（纯函数用）：id 递增即越旧 */
function snapshotRows(prefix: string, count: number, trigger: 'AUTO' | 'MANUAL', newestAt: number): {
  id: string; trigger: string; createdAt: string;
}[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(2, '0')}`,
    trigger,
    createdAt: new Date(newestAt - i * 60_000).toISOString(),
  }));
}

async function main(): Promise<void> {
  // ---------- 一、纯函数（不需要库） ----------
  const newest = Date.parse('2026-10-24T00:00:00.000Z');
  const autoRows = snapshotRows('auto', 30, 'AUTO', newest);
  const manualRows = snapshotRows('manual', 3, 'MANUAL', newest);

  check(
    `策略：AUTO 快照窗口 = ${POLICY_SNAPSHOT_KEEP} 份`,
    Number(AUTO_SNAPSHOT_KEEP) === POLICY_SNAPSHOT_KEEP,
    `生产常量 ${AUTO_SNAPSHOT_KEEP}`,
  );
  check(
    `策略：审计保留期 = ${POLICY_AUDIT_RETENTION_DAYS} 天`,
    Number(AUDIT_LOG_RETENTION_DAYS) === POLICY_AUDIT_RETENTION_DAYS,
    `生产常量 ${AUDIT_LOG_RETENTION_DAYS}`,
  );

  const expired = selectExpiredAutoSnapshotIds([...autoRows, ...manualRows], POLICY_SNAPSHOT_KEEP);
  check(
    `AUTO 快照窗口：30 份 AUTO 只保留 ${POLICY_SNAPSHOT_KEEP} 份（删掉最旧的 ${30 - POLICY_SNAPSHOT_KEEP} 份）`,
    expired.length === 30 - POLICY_SNAPSHOT_KEEP,
    `实得 ${expired.length} 份：${expired.join(',')}`,
  );
  check(
    'AUTO 快照窗口：删掉的正好是最旧的那些（auto-20 ~ auto-29）',
    expired.join(',') === autoRows.slice(POLICY_SNAPSHOT_KEEP).map((r) => r.id).join(','),
    `实得 ${expired.join(',')}`,
  );
  check(
    'AUTO 快照窗口：MANUAL 永不被自动删',
    !expired.some((id) => id.startsWith('manual-')),
    `实得 ${expired.join(',')}`,
  );
  check(
    `AUTO 快照窗口：正好 ${POLICY_SNAPSHOT_KEEP} 份时不动手`,
    selectExpiredAutoSnapshotIds(autoRows.slice(0, POLICY_SNAPSHOT_KEEP), POLICY_SNAPSHOT_KEEP).length === 0,
  );
  check(
    'AUTO 快照窗口：输入乱序也按创建时间倒序判（不依赖调用方的排序）',
    selectExpiredAutoSnapshotIds([...autoRows].reverse(), POLICY_SNAPSHOT_KEEP).join(',') === expired.join(','),
  );
  check('AUTO 快照窗口：空输入不炸', selectExpiredAutoSnapshotIds([], POLICY_SNAPSHOT_KEEP).length === 0);

  const now = Date.parse('2026-10-24T00:00:00.000Z');
  check(
    '审计保留期：91 天前的记录算过期（超过 90 天）',
    isAuditLogExpired(new Date(now - 91 * DAY), now),
  );
  check(
    '审计保留期：89 天前的记录不算过期',
    !isAuditLogExpired(new Date(now - 89 * DAY), now),
  );
  check('审计保留期：刚写的记录不算过期', !isAuditLogExpired(new Date(now), now));
  check(
    '审计保留期：截止点 = 当前时间 - 90 天',
    auditRetentionCutoff(now).getTime() === now - 90 * DAY,
  );

  // ---------- 二、真库（需要 PostgreSQL） ----------
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  const prisma = app.get(PrismaService);
  const agent = app.get(AgentService);

  const stamp = Date.now();
  const slugA = `retention-a-${stamp}`;
  const slugB = `retention-b-${stamp}`;
  const label = (n: string): string => `retention-test-${stamp}-${n}`;
  let testUserId: string | null = null;

  try {
    const tenantA = await prisma.tenant.create({ data: { slug: slugA, name: `保留期测试A-${stamp}` } });
    const tenantB = await prisma.tenant.create({ data: { slug: slugB, name: `保留期测试B-${stamp}` } });

    // 25 份 AUTO + 3 份 MANUAL（租户 A）；3 份 AUTO（租户 B，用来验租户隔离）
    for (let i = 0; i < 25; i += 1) {
      await prisma.changeSnapshot.create({
        data: {
          tenantId: tenantA.id,
          label: label(`auto-${i}`),
          trigger: 'AUTO',
          data: { marker: 'retention-test' },
          counts: {},
          sizeBytes: 1,
          createdAt: new Date(newest - i * 60_000),
        },
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await prisma.changeSnapshot.create({
        data: {
          tenantId: tenantA.id,
          label: label(`manual-${i}`),
          trigger: 'MANUAL',
          data: { marker: 'retention-test' },
          counts: {},
          sizeBytes: 1,
          createdAt: new Date(newest - i * 60_000),
        },
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await prisma.changeSnapshot.create({
        data: {
          tenantId: tenantB.id,
          label: label(`b-auto-${i}`),
          trigger: 'AUTO',
          data: { marker: 'retention-test' },
          counts: {},
          sizeBytes: 1,
          createdAt: new Date(newest - i * 60_000),
        },
      });
    }

    // 先直接调一次清理，量一下耗时（验收要求：确认清理用的查询不会拖住事务）
    const purgeStart = Date.now();
    const purgedCount = await agent.purgeExpiredAutoSnapshots(tenantA.id);
    const purgeMs = Date.now() - purgeStart;
    console.log(`  （清理 ${purgedCount} 份过期快照耗时 ${purgeMs}ms）`);
    check(
      `AUTO 快照窗口：25 份 AUTO 清到 ${POLICY_SNAPSHOT_KEEP} 份`,
      (await prisma.changeSnapshot.count({ where: { tenantId: tenantA.id, trigger: 'AUTO' } })) === POLICY_SNAPSHOT_KEEP,
    );

    // 走**生产路径**：createSnapshot 内部建完就会清窗口（不是直接调清理函数）
    const created = await agent.createSnapshot(tenantA.id, randomUUID(), label('by-create'), 'AUTO');
    check('AUTO 快照窗口：createSnapshot 成功', typeof created.id === 'string' && created.id.length > 0);

    const autoLeft = await prisma.changeSnapshot.count({ where: { tenantId: tenantA.id, trigger: 'AUTO' } });
    const manualLeft = await prisma.changeSnapshot.count({ where: { tenantId: tenantA.id, trigger: 'MANUAL' } });
    const bLeft = await prisma.changeSnapshot.count({ where: { tenantId: tenantB.id, trigger: 'AUTO' } });
    check(
      `AUTO 快照窗口：创建后只剩 ${POLICY_SNAPSHOT_KEEP} 份`,
      autoLeft === POLICY_SNAPSHOT_KEEP,
      `实得 ${autoLeft} 份`,
    );
    check('AUTO 快照窗口：MANUAL 一份没少', manualLeft === 3, `实得 ${manualLeft} 份`);
    check('AUTO 快照窗口：别的租户一份没少（租户隔离）', bLeft === 3, `实得 ${bLeft} 份`);

    // 审计：过期 / 近期 / 别的租户 / 系统级（无租户）
    const old = new Date(now - 91 * DAY);
    const recent = new Date(now - DAY);
    await prisma.auditLog.create({ data: { tenantId: tenantA.id, action: label('audit-old'), createdAt: old } });
    await prisma.auditLog.create({ data: { tenantId: tenantA.id, action: label('audit-recent'), createdAt: recent } });
    await prisma.auditLog.create({ data: { tenantId: tenantB.id, action: label('audit-b-old'), createdAt: old } });
    await prisma.auditLog.create({ data: { tenantId: null, action: label('audit-sys-old'), createdAt: old } });
    await prisma.auditLog.create({ data: { tenantId: null, action: label('audit-sys-recent'), createdAt: recent } });

    const auditPurgeStart = Date.now();
    await agent.purgeExpiredAuditLogs(tenantA.id);
    console.log(`  （清理过期审计耗时 ${Date.now() - auditPurgeStart}ms）`);

    const aOld = await prisma.auditLog.count({ where: { tenantId: tenantA.id, action: label('audit-old') } });
    const aRecent = await prisma.auditLog.count({ where: { tenantId: tenantA.id, action: label('audit-recent') } });
    const bOld = await prisma.auditLog.count({ where: { tenantId: tenantB.id, action: label('audit-b-old') } });
    const sysOld = await prisma.auditLog.count({ where: { tenantId: null, action: label('audit-sys-old') } });
    const sysRecent = await prisma.auditLog.count({ where: { tenantId: null, action: label('audit-sys-recent') } });
    check('审计保留期：超过 90 天的被清掉', aOld === 0, `实得 ${aOld} 条`);
    check('审计保留期：近期的留着', aRecent === 1, `实得 ${aRecent} 条`);
    check('审计保留期：别的租户的过期审计不动（租户隔离）', bOld === 1, `实得 ${bOld} 条`);
    check('审计保留期：系统级（无租户）过期审计也清掉', sysOld === 0, `实得 ${sysOld} 条`);
    check('审计保留期：系统级近期审计留着', sysRecent === 1, `实得 ${sysRecent} 条`);

    // ---------- 三、API Key lastUsedAt 的写去重 ----------
    // 这是「长期运行不持续擦写硬盘」的一条主线：原来每个带 Key 的请求都 UPDATE 同一行。
    const user = await prisma.user.create({
      data: {
        phone: `svc_retention_${stamp}`,
        passwordHash: 'svc:retention-test',
        displayName: `保留期测试账号-${stamp}`,
        isServiceAccount: true,
      },
    });
    const apiKey = await prisma.apiKey.create({
      data: {
        tenantId: tenantA.id,
        userId: user.id,
        name: label('key'),
        prefix: 'ak_retention',
      },
    });

    check('API Key：首次校验通过', (await agent.verifyApiKey(apiKey.id)) === true);
    await sleep(300);
    const firstUse = (await prisma.apiKey.findUnique({ where: { id: apiKey.id } }))?.lastUsedAt ?? null;
    check('API Key：首次校验会记 lastUsedAt', firstUse !== null);

    await agent.verifyApiKey(apiKey.id);
    await sleep(300);
    const secondUse = (await prisma.apiKey.findUnique({ where: { id: apiKey.id } }))?.lastUsedAt ?? null;
    check(
      'API Key：5 分钟窗口内的再次调用不再写 lastUsedAt（去重生效）',
      firstUse !== null && secondUse !== null && secondUse.getTime() === firstUse.getTime(),
      `首次 ${firstUse?.toISOString()} → 二次 ${secondUse?.toISOString()}`,
    );

    // 吊销后立刻拒绝（这次改动不能影响鉴权结论）
    await prisma.apiKey.update({ where: { id: apiKey.id }, data: { revokedAt: new Date() } });
    check('API Key：吊销后校验失败', (await agent.verifyApiKey(apiKey.id)) === false);

    testUserId = user.id;

    // ---------- 四、幂等记录的保留期（原来 purgeOlderThan 零调用，表只增不减） ----------
    const idem = new IdempotencyService(prisma);
    const idemOld = new Date(now - (IDEMPOTENCY_RETENTION_DAYS + 1) * DAY);
    await prisma.idempotencyRecord.create({
      data: { tenantId: tenantA.id, key: label('idem-old'), kind: 'retention-test', createdAt: idemOld },
    });
    await prisma.idempotencyRecord.create({
      data: { tenantId: tenantA.id, key: label('idem-recent'), kind: 'retention-test', createdAt: recent },
    });
    await prisma.idempotencyRecord.create({
      data: { tenantId: tenantB.id, key: label('idem-b-old'), kind: 'retention-test', createdAt: idemOld },
    });

    // 走生产路径：连续抢占满阈值 → claim() 自己会触发清理（死代码接线验证）
    for (let i = 0; i < IDEMPOTENCY_PURGE_EVERY; i += 1) {
      await idem.claim(tenantA.id, label(`idem-claim-${i}`), 'retention-test');
    }
    await sleep(500);

    const idemOldLeft = await prisma.idempotencyRecord.count({ where: { tenantId: tenantA.id, key: label('idem-old') } });
    const idemRecentLeft = await prisma.idempotencyRecord.count({ where: { tenantId: tenantA.id, key: label('idem-recent') } });
    const idemBOldLeft = await prisma.idempotencyRecord.count({ where: { tenantId: tenantB.id, key: label('idem-b-old') } });
    check(
      `幂等记录保留期：抢占满 ${IDEMPOTENCY_PURGE_EVERY} 次后过期的被清掉（purgeOlderThan 不再是死代码）`,
      idemOldLeft === 0,
      `实得 ${idemOldLeft} 条`,
    );
    check('幂等记录保留期：近期的留着', idemRecentLeft === 1, `实得 ${idemRecentLeft} 条`);
    check('幂等记录保留期：别的租户的过期记录不动（租户隔离）', idemBOldLeft === 1, `实得 ${idemBOldLeft} 条`);
  } finally {
    // 清干净：AuditLog / IdempotencyRecord 都没有 tenant 外键（删租户不会连带删），必须自己删
    await prisma.auditLog.deleteMany({ where: { action: { startsWith: `retention-test-${stamp}-` } } });
    await prisma.idempotencyRecord.deleteMany({ where: { key: { startsWith: `retention-test-${stamp}-` } } });
    if (testUserId) await prisma.user.deleteMany({ where: { id: testUserId } });
    await prisma.tenant.deleteMany({ where: { slug: { in: [slugA, slugB] } } });
    await app.close();
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n共 ${checks.length} 条断言，通过 ${checks.length - failed.length} 条，失败 ${failed.length} 条`);
  if (failed.length > 0) {
    failed.forEach(([name]) => console.error(`FAIL ${name}`));
    process.exitCode = 1;
  }
}

void main().catch((e: unknown) => {
  console.error('保留期检查运行期异常（不是断言失败，是脚本本身崩了）：', e);
  process.exitCode = 1;
});
