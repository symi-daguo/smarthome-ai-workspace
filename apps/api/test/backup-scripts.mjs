/**
 * 备份/恢复脚本的行为级检查（用假 docker 跑真实脚本，不碰真容器、不碰真数据）。
 *
 * **为什么单独写**：这两个脚本是「数据能不能回来」的最后一道保险，而它们的失败方式
 * 极其隐蔽 —— 脚本不报错、退出码是 0，只是**某一步根本没做**。
 *
 * 实测踩到过的真 bug（本次修复）：
 *   restore-full.sh 先 `docker compose stop api`（恢复期间必须停，防写入混合状态），
 *   紧接着又 `docker exec "$API_CID" tar ...` 去恢复产物卷 ——
 *   容器已经停了，exec 必然失败，于是**产物卷从来没被恢复过**，
 *   而脚本只 warn 一句、退出码仍是 0。预演模式测不出来（预演根本不执行这一步）。
 *   后果：数据库恢复了、文件没恢复 → MediaAsset 的行全在、文件全不在 → 方案残缺。
 *
 * 所以这里断言的不是「脚本长什么样」，而是「脚本按什么顺序、调用了什么 docker 命令」：
 *   - 产卷操作必须用一次性容器挂同一个卷（docker run -v vol:/repo/uploads），
 *     绝不能是 docker exec 进 api 容器；
 *   - 停 api 必须发生在卷操作之前；
 *   - 预演模式不得触发任何写操作；
 *   - 全量备份的 tar 必须排除 uploads/backups（否则每份备份白背一份库快照）；
 *   - 备份目录落在 uploads 卷内时必须拒绝执行。
 *
 * 运行：
 *   node apps/api/test/backup-scripts.mjs
 *
 * 退出码：0 全过 / 1 有断言失败。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

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

const tmp = mkdtempSync(join(tmpdir(), 'backup-scripts-'));
const binDir = join(tmp, 'bin');
mkdirSync(binDir, { recursive: true });

// 假 docker 放进 PATH 最前面，真 docker 永远不会被调到
const fakeDocker = join(binDir, 'docker');
writeFileSync(fakeDocker, `#!/usr/bin/env bash\nexec "${process.execPath}" "${join(here, 'fake-docker.mjs')}" "$@"\n`);
chmodSync(fakeDocker, 0o755);

/** 跑一次脚本，把 docker 调用记进 log，返回 { code, log } */
function runScript(script, args, env = {}) {
  const log = join(tmp, `docker-${Math.random().toString(36).slice(2)}.log`);
  const res = { code: 0, log: [], raw: '' };
  try {
    res.raw = execFileSync('bash', [join(repoRoot, 'scripts', script), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FAKE_DOCKER_LOG: log,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    res.code = e.status ?? 1;
    res.raw = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  try {
    res.log = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    res.log = [];
  }
  return res;
}

/** 找出所有涉及 uploads 卷操作的 docker 调用 */
const volumeCalls = (log) => log.filter((a) => a.some((s) => typeof s === 'string' && s.includes('/repo/uploads')));

// ---------------------------------------------------------------- 1. 造一份假备份
const srcDir = join(tmp, 'snapshot');
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(srcDir, 'db.dump'), 'fake-db-dump');
writeFileSync(join(srcDir, 'uploads.tar.gz'), 'fake-uploads-tar');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
writeFileSync(
  join(srcDir, 'manifest.json'),
  JSON.stringify({
    pieces: {
      db: { file: 'db.dump', sha256: sha(join(srcDir, 'db.dump')) },
      uploads: { file: 'uploads.tar.gz', sha256: sha(join(srcDir, 'uploads.tar.gz')) },
    },
  }),
);

// ---------------------------------------------------------------- 2. 预演模式不得有写操作
{
  const r = runScript('restore-full.sh', [srcDir]);
  const stop = r.log.find((a) => a[0] === 'compose' && a[1] === 'stop');
  const restore = r.log.find((a) => a[0] === 'exec' && a.some((s) => typeof s === 'string' && s.includes('pg_restore')));
  const run = r.log.find((a) => a[0] === 'run');
  check('预演模式：没有停 api', !stop, JSON.stringify(stop ?? []));
  check('预演模式：没有执行 pg_restore', !restore, JSON.stringify(restore ?? []));
  check('预演模式：没有起临时容器', !run, JSON.stringify(run ?? []));
  check('预演模式：退出码 0', r.code === 0, `实际 ${r.code}`);
}

// ---------------------------------------------------------------- 3. 真恢复：卷操作必须走临时容器
{
  const r = runScript('restore-full.sh', [srcDir, '--yes']);
  const stopIdx = r.log.findIndex((a) => a[0] === 'compose' && a[1] === 'stop');
  const restoreIdx = r.log.findIndex((a) => a[0] === 'exec' && a.some((s) => typeof s === 'string' && s.includes('pg_restore')));

  check('真恢复：退出码 0', r.code === 0, `实际 ${r.code}\n${r.raw}`);
  check('真恢复：确实停了 api', stopIdx >= 0, JSON.stringify(r.log));
  check('真恢复：确实执行了 pg_restore', restoreIdx >= 0, JSON.stringify(r.log));

  // 核心断言：产物卷操作不许是 docker exec 进 api 容器
  const badExec = volumeCalls(r.log).filter((a) => a[0] === 'exec');
  check(
    '产物卷操作没有用 docker exec（api 容器此时是停的，exec 必然失败）',
    badExec.length === 0,
    `发现 ${badExec.length} 处：${JSON.stringify(badExec)}`,
  );

  // 必须用一次性容器挂同一个卷
  const tmpRun = volumeCalls(r.log).filter((a) => a[0] === 'run');
  check(
    '产物卷操作用一次性容器挂载同一个卷（docker run -v <卷>:/repo/uploads）',
    tmpRun.length >= 2,
    `只找到 ${tmpRun.length} 处：${JSON.stringify(tmpRun)}`,
  );
  check(
    '临时容器确实挂的是 /repo/uploads',
    tmpRun.some((a) => a.some((s) => typeof s === 'string' && s.endsWith(':/repo/uploads'))),
    JSON.stringify(tmpRun),
  );
  check(
    '临时容器确实带了解包用的 tar',
    tmpRun.some((a) => a.some((s) => s === 'tar')),
    JSON.stringify(tmpRun),
  );
  check(
    '临时容器确实带了清空卷用的 find',
    tmpRun.some((a) => a.some((s) => typeof s === 'string' && s.includes('find /repo/uploads'))),
    JSON.stringify(tmpRun),
  );

  // 顺序：停 api 必须在卷操作之前
  const firstVolumeOp = r.log.findIndex((a) => a[0] === 'run' && a.some((s) => typeof s === 'string' && s.includes('/repo/uploads')));
  check(
    '顺序正确：先停 api，再做产物卷操作',
    stopIdx >= 0 && firstVolumeOp > stopIdx,
    `stop=${stopIdx} volumeOp=${firstVolumeOp}`,
  );

  // 恢复完要把 api 起回来
  check('恢复完重新启动 api', r.log.some((a) => a[0] === 'compose' && a[1] === 'start'), JSON.stringify(r.log));
}

// ---------------------------------------------------------------- 4. 全量备份：tar 必须排除 backups/
{
  const dest = join(tmp, 'hostbackups');
  mkdirSync(dest, { recursive: true });
  const r = runScript('backup-full.sh', [], { BACKUP_DIR: dest, BACKUP_KEEP: '3' });
  const tarCall = r.log.find((a) => a[0] === 'exec' && a.some((s) => s === 'tar'));
  check('全量备份：退出码 0', r.code === 0, `实际 ${r.code}\n${r.raw}`);
  check('全量备份：确实对 uploads 卷打了 tar', Boolean(tarCall), JSON.stringify(r.log));
  check(
    '产物卷归档排除了 backups/（内容与 pg_dump 重复，不排除每份备份白背一份库快照）',
    Boolean(tarCall) && tarCall.some((s) => typeof s === 'string' && s.includes('--exclude=./backups')),
    JSON.stringify(tarCall ?? []),
  );
  const manifest = findManifest(dest);
  check(
    '全量备份：写了 manifest.json（含 sha256）',
    manifest !== null && manifest.includes('"sha256"'),
    `未找到 manifest.json：${manifest ?? 'null'}`,
  );
}

// ---------------------------------------------------------------- 5. 备份目录落在 uploads 卷内必须拒绝
{
  const inside = join(tmp, 'inside-vol');
  mkdirSync(join(inside, 'full'), { recursive: true });
  const r = runScript('backup-full.sh', [], {
    BACKUP_DIR: join(inside, 'full'),
    FAKE_UPLOAD_SOURCE: inside,
  });
  check(
    '备份目录落在 uploads 卷内时拒绝执行（否则备份会把自己又打进去）',
    r.code !== 0 && /不能放在 uploads 卷内/.test(r.raw),
    `退出码 ${r.code}\n${r.raw}`,
  );
}

// ---------------------------------------------------------------- 6. 恢复前必须验 sha256
{
  // 篡改 db.dump，校验必须拦下
  writeFileSync(join(srcDir, 'db.dump'), 'tampered');
  const r = runScript('restore-full.sh', [srcDir, '--yes']);
  check(
    '备份被篡改时拒绝恢复（sha256 校验拦下）',
    r.code !== 0 && /校验和不符/.test(r.raw),
    `退出码 ${r.code}\n${r.raw}`,
  );
  const restore = r.log.find((a) => a[0] === 'exec' && a.some((s) => typeof s === 'string' && s.includes('pg_restore')));
  check('校验不过时没有真的执行 pg_restore', !restore, JSON.stringify(restore ?? []));
}

/** 备份目录里按时间戳命名，找到其中一份 manifest.json */
function findManifest(dir) {
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, 'manifest.json');
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
  } catch {
    // 目录不存在
  }
  return null;
}

rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
