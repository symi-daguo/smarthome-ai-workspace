/**
 * 存储治理自证脚本（可运行、能证伪）。
 *
 * 覆盖本轮三处治理改动：
 *   1) 引用集合补全 —— 造「会被误删的 id」，断言它们全部被保护；
 *   2) 上传配额闸门 —— 造超配额场景，断言被拦且信息带具体数字；
 *   3) 文件流 Range —— 断言后缀区间 bytes=-N 等语义正确。
 *
 * 为什么单独写脚本而不是塞进 smoke.ts：smoke.ts 要起真实服务与数据库，
 * 而这三处都是**纯逻辑**，能在秒级内反复证伪（「改坏 → 立刻红」）。
 *
 * 运行（依赖编译产物，跑之前先 build）：
 *   pnpm --filter @app/api build && node apps/api/test/storage-governance.mjs
 *
 * 退出码：0 全过 / 1 有断言失败。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'src');

let service;
let controller;
try {
  // 用 pathToFileURL 而不是裸绝对路径：Windows 下裸路径不是合法的 ESM 说明符
  service = await import(pathToFileURL(join(dist, 'media', 'media.service.js')).href);
  controller = await import(pathToFileURL(join(dist, 'media', 'media.controller.js')).href);
} catch (e) {
  console.error('✗ 读不到编译产物：先跑 `pnpm --filter @app/api build`');
  console.error(String(e?.message ?? e));
  process.exit(1);
}

const {
  checkUploadQuota,
  collectReferencedAssetIds,
  extractAssetIdFromPath,
  uploadQuotaBytes,
} = service;
const { parseByteRange } = controller;

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

// ---------------------------------------------------------------- 1. 引用集合
console.log('--- 1. 引用集合补全（清理工具不能删掉仍在用的图）---');

// 每一个 id 都只出现在**一种**引用形态里：漏掉任何一种都会导致误删
const ID = {
  planFloorplan: '11111111-1111-4111-8111-111111111111',
  planExtra: '22222222-2222-4222-8222-222222222222',
  planRender: '33333333-3333-4333-8333-333333333333',
  planRenderedFloorplan: '44444444-4444-4444-8444-444444444444',
  planVideo: '55555555-5555-4555-8555-555555555555',
  layout: '66666666-6666-4666-8666-666666666666',
  product: '77777777-7777-4777-8777-777777777777',
  sceneSource: '88888888-8888-4888-8888-888888888888',
  sceneVideo: '99999999-9999-4999-8999-999999999999',
  avatar: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const ORPHAN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const referenced = collectReferencedAssetIds({
  plans: [{
    floorplanAssetId: ID.planFloorplan,
    extraFloorplanAssetIds: [ID.planExtra],
    renderAssetIds: [ID.planRender],
    renderedFloorplanAssetId: ID.planRenderedFloorplan,
    videoAssetIds: [ID.planVideo],
  }],
  layouts: [{ mediaAssetId: ID.layout }],
  products: [{ imageUrl: `/api/media/assets/${ID.product}/file` }],
  lightingScenes: [{ sourceAssetId: ID.sceneSource, videoAssetId: ID.sceneVideo }],
  users: [{ avatarUrl: `/api/media/assets/${ID.avatar}/file` }],
});

for (const [field, id] of Object.entries(ID)) {
  check(`引用集合保护 ${field}`, referenced.has(id), `id=${id} 未被保护（清理时会把它删掉）`);
}
check('没人引用的 id 不在引用集合里（否则永远删不掉）', !referenced.has(ORPHAN));

// **证伪能力**：把旧口径（只收 floorplanAssetId / mediaAssetId / 产品图）摆出来对比。
// 旧口径会漏掉渲染图、视频、头像……如果有人把实现改回旧口径，这条会立刻变红。
const legacy = new Set([
  ID.planFloorplan,
  ID.layout,
  ID.product,
]);
check(
  '旧口径确实漏掉了 renderAssetIds（说明本检查有区分力）',
  !legacy.has(ID.planRender) && referenced.has(ID.planRender),
);
check(
  '旧口径确实漏掉了用户头像（说明本检查有区分力）',
  !legacy.has(ID.avatar) && referenced.has(ID.avatar),
);

// 数组字段必须按「包含」判断：标量比较会整片漏掉
check(
  '数组字段按包含判断（renderAssetIds 里的 id 被保护）',
  collectReferencedAssetIds({
    plans: [{
      floorplanAssetId: null,
      extraFloorplanAssetIds: [],
      renderAssetIds: [ID.planRender],
      renderedFloorplanAssetId: null,
      videoAssetIds: [],
    }],
    layouts: [],
    products: [],
    lightingScenes: [],
    users: [],
  }).has(ID.planRender),
);

// 路径形态取 id：完整 URL 与裸路径都要认
check(
  '路径形态取 id（完整 URL）',
  extractAssetIdFromPath(`https://example.com/api/media/assets/${ID.product}/file`) === ID.product,
);
check(
  '路径形态取 id（裸路径）',
  extractAssetIdFromPath(`/api/media/assets/${ID.avatar}/file`) === ID.avatar,
);
check('空路径不误判', extractAssetIdFromPath('') === null && extractAssetIdFromPath(null) === null);

// 接线检查：纯函数对了不等于调用点接上了
const serviceSrc = readFileSync(join(here, '..', 'src', 'media', 'media.service.ts'), 'utf8');
const uploadCalls = (serviceSrc.match(/await this\.assertUploadWithinQuota\(/g) ?? []).length;
check('上传闸门接在两个上传路径上（uploadImage + uploadVideo）', uploadCalls === 2, `实际 ${uploadCalls} 处`);
const backupSrc = readFileSync(join(here, '..', 'src', 'admin', 'backup.controller.ts'), 'utf8');
check('清理端点走统一引用集合', backupSrc.includes('this.media.referencedAssetIds()'));

// ---------------------------------------------------------------- 2. 配额闸门
console.log('--- 2. 上传配额闸门（超配额必须被拦）---');

const MB = 1024 * 1024;
const quota = 100 * MB;

check('未超配额放行', checkUploadQuota(0, quota, quota).ok === true);
check('刚好用满（再加 0 字节）放行', checkUploadQuota(quota, 0, quota).ok === true);
check('超出 1 字节被拦', checkUploadQuota(quota, 1, quota).ok === false);
check('已用量本身就超配额时被拦', checkUploadQuota(quota + 1, 0, quota).ok === false);

const over = checkUploadQuota(90 * MB, 20 * MB, quota);
check('超配额场景被拦', over.ok === false);
check(
  '拒绝信息带具体数字（已用 / 配额）',
  over.ok === false && /已用/.test(over.message) && over.message.includes('90.0 MB') && over.message.includes('100.0 MB'),
  over.ok ? over.message : over.message,
);
check(
  '拒绝信息给出下一步动作（先清理）',
  over.ok === false && over.message.includes('清理'),
);

// 配额换算：env 值 → 字节；非法值一律回落默认（报告与拦截必须同源）
check('配额换算 4096MB', uploadQuotaBytes('4096') === 4096 * MB);
check('配额换算回落默认（undefined）', uploadQuotaBytes(undefined) === 4096 * MB);
check('配额换算回落默认（非法值）', uploadQuotaBytes('abc') === 4096 * MB);
check('配额换算回落默认（0 不等于「无限制」）', uploadQuotaBytes('0') === 4096 * MB);

// ---------------------------------------------------------------- 3. Range 解析
console.log('--- 3. 文件流 Range（后缀区间要正确）---');

check('bytes=0-99', JSON.stringify(parseByteRange('bytes=0-99', 1000)) === '{"start":0,"end":99}');
check('bytes=100-（到末尾）', JSON.stringify(parseByteRange('bytes=100-', 1000)) === '{"start":100,"end":999}');
check('bytes=-500（后缀：最后 500 字节）', JSON.stringify(parseByteRange('bytes=-500', 1000)) === '{"start":500,"end":999}');
check('bytes=-5000（后缀超过文件长度 → 全文）', JSON.stringify(parseByteRange('bytes=-5000', 1000)) === '{"start":0,"end":999}');
check('bytes=999-（最后一个字节）', JSON.stringify(parseByteRange('bytes=999-', 1000)) === '{"start":999,"end":999}');
check('越界区间返回 null（回 416）', parseByteRange('bytes=1000-', 1000) === null);
check('非法 Range 头返回 null', parseByteRange('items=0-1', 1000) === null);
check('空区间返回 null', parseByteRange('bytes=-', 1000) === null);

// ---------------------------------------------------------------- 汇总
console.log('');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
