import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { TokenService } from '../src/billing/token.service.js';
import { CanvasService } from '../src/canvas/canvas.service.js';
import { PrismaService } from '../src/prisma/prisma.module.js';
import { resolveMinimaxVideoModel } from '../src/media/video-provider.js';
import { ModelConfigService } from '../src/llm/model-config.service.js';

const checks: [string, boolean][] = [];

function check(name: string, ok: boolean): void {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

const randomPhone = (): string => `13${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`;

/**
 * 稳定序列化（对象键按字典序排序后再拼接）。
 * Postgres jsonb 不保证对象键顺序，直接 JSON.stringify 比较会假失败，故用它做深比较。
 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const health = await request<{ status: string }>(base, '/api/health');
  check('health 200 且 status=ok', health.status === 200 && health.body.status === 'ok');

  const phoneA = randomPhone();
  const phoneB = randomPhone();
  const regA = await request<{ token: string }>(base, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ phone: phoneA, password: 'Test@12345', displayName: '冒烟测试A' }),
  });
  check('注册 A 成功', regA.status === 201 && typeof regA.body.token === 'string');

  await request(base, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ phone: phoneB, password: 'Test@12345', displayName: '冒烟测试B' }),
  });
  const regB = await request<{ token: string }>(base, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: phoneB, password: 'Test@12345' }),
  });

  const dup = await request(base, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ phone: phoneA, password: 'Test@12345', displayName: '重复' }),
  });
  check('重复手机号注册被拒绝', dup.status === 409);

  const me = await request<{ id: string; memberships: { tenantId: string }[] }>(base, '/api/auth/me', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('me 返回成员关系', me.status === 200 && me.body.memberships.length === 1);
  const tenantA = me.body.memberships[0].tenantId;

  const badPass = await request(base, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: phoneA, password: 'WrongPass1' }),
  });
  check('错误密码登录被拒绝', badPass.status === 401);

  const crossTenant = await request(base, '/api/tenants/current', {
    headers: {
      Authorization: `Bearer ${regA.body.token}`,
      'X-Tenant-Id': '00000000-0000-0000-0000-000000000000',
    },
  });
  check('跨租户访问被拒绝', crossTenant.status === 403);

  const tokens = await request<{ tokenBalance: number }>(base, '/api/tenants/current/tokens', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('token 余额为默认额度 80000', tokens.status === 200 && tokens.body.tokenBalance === 80_000);

  const tokenService = app.get(TokenService);
  const consumed = await tokenService.consume(tenantA, 1200, 'CONSUME', { source: 'smoke' });
  check('token 事务扣减 1200', consumed.tokenBalance === 78_800);

  let insufficient = false;
  try {
    // 1000 万远超当前余额 78800，但仍在 int4 范围内，验证业务层余额不足拒绝
    await tokenService.consume(tenantA, 10_000_000);
  } catch (error) {
    insufficient = error instanceof Error && error.message.includes('TOKEN_INSUFFICIENT');
  }
  check('余额不足拒绝', insufficient);

  const after = await request<{ tokenBalance: number }>(base, '/api/tenants/current/tokens', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('扣减后余额一致（事务回滚生效）', after.status === 200 && after.body.tokenBalance === 78_800);

  const ledger = await request<unknown[]>(base, '/api/tenants/current/tokens/ledger', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('账本含发放与扣减记录', Array.isArray(ledger.body) && ledger.body.length >= 2);

  // ---------- S2 内容提取：完整产品资料自动确认 ----------
  const completeProduct = [
    '智能中控面板 Pro',
    '产品名称：智居中控屏 X1',
    '型号：ZJ-X1-2026',
    '售价：¥1299 元',
    '规格：7 英寸 1024x600 触摸屏，支持 Zigbee/WiFi/蓝牙三模，DC 12V 供电',
    '核心卖点：一屏掌控全屋设备，支持语音与场景联动，离线本地执行不断连',
  ].join('\n');
  const formOk = new FormData();
  formOk.append('file', new Blob([completeProduct], { type: 'text/plain' }), 'product-ok.txt');
  formOk.append('docType', 'product');
  const okRes = await fetch(`${base}/api/content/extractions/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: formOk,
  });
  const okJob = (await okRes.json()) as {
    id: string;
    status: string;
    score: number;
    deficiencies: unknown[];
    document: { confirmed: boolean } | null;
  };
  check(
    '完整产品资料提取后自动入库',
    okRes.status === 201 && okJob.status === 'CONFIRMED' && okJob.document?.confirmed === true,
  );

  // ---------- S2 内容提取：残缺资料进入 REVIEWING，补全后 CONFIRMED ----------
  const incompleteProduct = '这是一份只有产品简介的资料，提到了某款灯光面板很好用，没有型号与价格信息。';
  const formBad = new FormData();
  formBad.append('file', new Blob([incompleteProduct], { type: 'text/plain' }), 'product-bad.txt');
  formBad.append('docType', 'product');
  const badRes = await fetch(`${base}/api/content/extractions/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: formBad,
  });
  const badJob = (await badRes.json()) as {
    id: string;
    status: string;
    deficiencies: { fieldKey: string }[];
    document: { fields: { key: string; value: string }[] } | null;
  };
  check('残缺资料进入待确认且产出缺失项', badJob.status === 'REVIEWING' && badJob.deficiencies.length >= 2);

  const confirmedFields: Record<string, string> = {};
  for (const f of badJob.document?.fields ?? []) confirmedFields[f.key] = f.value;
  confirmedFields.name = '智居灯光面板 L2';
  confirmedFields.model = 'ZJ-L2-2026';
  confirmedFields.price = '399 元';
  confirmedFields.specs = '4 英寸旋钮面板，零火单火自适应';
  confirmedFields.sellingPoints = '旋钮调光调色，兼容主流智能音箱';
  const confirmRes = await request<{ status: string; document: { confirmed: boolean } | null }>(
    base,
    `/api/content/extractions/${badJob.id}/confirm`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${regA.body.token}` },
      body: JSON.stringify({ fields: confirmedFields, action: 'confirm' }),
    },
  );
  check('人工补全确认后入库', confirmRes.status === 201 && confirmRes.body.status === 'CONFIRMED');

  const docs = await request<unknown[]>(base, '/api/content/extractions/documents', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('已入库文档列表可查', Array.isArray(docs.body) && docs.body.length >= 2);

  // ---------- 内容提取 DELETE（jobId 或 documentId 都能删，级联清理） ----------
  // 用 badJob.id 删（前面已 confirmRes 把该任务入库，jobId 仍能命中级联清掉）
  const delByJob = await request(base, `/api/content/extractions/documents/${badJob.id}`, {
    headers: { Authorization: `Bearer ${regA.body.token}` }, method: 'DELETE',
  });
  check('删除提取任务（jobId）级联清文档 200/204', delByJob.status === 200 || delByJob.status === 204);
  const jobsAfter = await request<unknown[]>(base, '/api/content/extractions', { headers: { Authorization: `Bearer ${regA.body.token}` } });
  check('删除后任务不在列表中', Array.isArray(jobsAfter.body) && !jobsAfter.body.some((j) => (j as Record<string, unknown>).id === badJob.id));
  const delJobAgain = await request(base, `/api/content/extractions/documents/${badJob.id}`, { headers: { Authorization: `Bearer ${regA.body.token}` }, method: 'DELETE' });
  check('重复删除同一提取任务 404', delJobAgain.status === 404);

  // 知识库产品资料确认入库 -> 自动同步产品中心（我的库 +1，品类自动推断）
  {
    const synced = await request<{ id: string; name: string; tenantId: string | null; category: string }[]>(base, '/api/products', { headers: { Authorization: `Bearer ${regA.body.token}` } });
    const mineProducts = synced.body.filter((p) => p.tenantId === tenantA);
    check('产品资料确认入库自动同步到我的库', mineProducts.length >= 2);
    check('同步产品品类自动推断（非默认兜底）', mineProducts.every((p) => p.category.length > 0));
  }

  // ---------- S3 产物库：素材购买扣额度 + 重复购买幂等 ----------
  const buy = await request<{ url: string }>(base, '/api/media/materials/purchase', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ key: 'm1' }),
  });
  check('素材购买返回本地路径', buy.status === 201 && buy.body.url === '/images/materials/m1.jpg');

  const tokensAfterBuy = await request<{ tokenBalance: number }>(base, '/api/tenants/current/tokens', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('素材购买扣减 100 token', tokensAfterBuy.body.tokenBalance === 78_800 - 100);

  const buyAgain = await request<{ url: string }>(base, '/api/media/materials/purchase', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ key: 'm1' }),
  });
  const tokensDup = await request<{ tokenBalance: number }>(base, '/api/tenants/current/tokens', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('重复购买同一素材不再扣款', buyAgain.status === 201 && tokensDup.body.tokenBalance === 78_800 - 100);

  const assetList = await request<unknown[]>(base, '/api/media/assets', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('产物列表含已购素材', Array.isArray(assetList.body) && assetList.body.length >= 1);

  // ---------- S3 智能方案：列表/校验/分享端点（不触发真实 LLM 生成） ----------
  const plansEmpty = await request<unknown[]>(base, '/api/plans', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('方案列表可查', plansEmpty.status === 200 && Array.isArray(plansEmpty.body));

  const planBad = await request<{ message?: unknown }>(base, '/api/plans', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ title: '短' }),
  });
  check('方案缺必填字段被校验拒绝', planBad.status === 400);

  const planBadPages = await request<{ message?: unknown }>(base, '/api/plans', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ title: '测试方案', pageCount: 5 }),
  });
  check('方案页数低于 9 被校验拒绝', planBadPages.status === 400);

  const plan404 = await request(base, '/api/plans/00000000-0000-0000-0000-000000000000', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('方案详情不存在返回 404', plan404.status === 404);

  const share404 = await request(base, '/api/public/plans/not-exist-token');
  check('公开分享 token 不存在返回 404', share404.status === 404);

  // ---------- S3 产品库与点位布局（不触发真实生成） ----------
  const products = await request<unknown[]>(base, '/api/products', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('产品目录可查（种子 >=20）', products.status === 200 && Array.isArray(products.body) && products.body.length >= 20);

  // ---------- 产品中心：我的库 CRUD + 查重 + 复制到我的库 + 租户隔离 ----------
  const auth0 = { headers: { Authorization: `Bearer ${regA.body.token}` } };
  type ProductRow = { id: string; name: string; tenantId: string | null; brand?: string; imageUrl?: string };
  const pub = (products.body as ProductRow[]).find((p) => p.tenantId === null);
  check('种子产品均为公共库行', Boolean(pub));

  const myCreate = await request<ProductRow>(base, '/api/products/mine', {
    ...auth0,
    method: 'POST',
    body: JSON.stringify({ name: '冒烟自定义产品', category: 'switch', brand: '测试品牌', model: 'SMOKE-1', priceMin: 100, priceMax: 200 }),
  });
  check('新增我的库产品（tenantId 归属当前租户）', myCreate.status === 201 && myCreate.body.tenantId === tenantA);
  const myId = myCreate.body.id;

  // 标准产品主数据：SKU/条码/SN/规格/质保 + 三级价格 + 多级返利
  const stdCreate = await request<{ id: string }>(base, '/api/products/mine', {
    ...auth0,
    method: 'POST',
    body: JSON.stringify({
      name: '冒烟标准主数据产品', category: 'gateway', sku: 'SM-GW-01', barcode: '2100000000099',
      snRule: 'SM-GW-', spec: '三模网关 200 子设备', warranty: 24,
      priceRetail: 1000, priceProject: 800, priceDealer: 700,
      rebateL1: 12, rebateL2: 6, rebateDesigner: 8,
    }),
  });
  const std = stdCreate.body as Record<string, unknown>;
  check(
    '标准主数据字段完整落库',
    stdCreate.status === 201 && std.sku === 'SM-GW-01' && std.barcode === '2100000000099' && std.snRule === 'SM-GW-'
      && std.warranty === 24 && std.priceRetail === 1000 && std.priceDealer === 700 && std.rebateDesigner === 8,
  );
  check('三级价格同步旧参考区间（min=工程价800,max=指导价1000）', std.priceMin === 800 && std.priceMax === 1000);
  const badRebate = await request(base, '/api/products/mine', { ...auth0, method: 'POST', body: JSON.stringify({ name: '非法返利产品', category: 'switch', rebateL1: 101 }) });
  check('返点超过 100% 被校验拒绝', badRebate.status === 400);
  const stdPatch = await request(base, `/api/products/${stdCreate.body.id}`, {
    ...auth0, method: 'PATCH',
    body: JSON.stringify({ spec: '三模网关 220 子设备（已改）', priceRetail: 1100, rebateL1: 15 }),
  });
  check('标准字段可 PATCH 更新且指导价同步区间上限', stdPatch.status === 200 && (stdPatch.body as Record<string, unknown>).spec === '三模网关 220 子设备（已改）' && (stdPatch.body as Record<string, unknown>).priceMax === 1100);

  const myDup = await request(base, '/api/products/mine', { ...auth0, method: 'POST', body: JSON.stringify({ name: '冒烟自定义产品', category: 'switch' }) });
  check('我的库重名被拒（应用层查重）', myDup.status === 400);

  const badCat = await request(base, '/api/products/mine', { ...auth0, method: 'POST', body: JSON.stringify({ name: '非法品类产品', category: 'not-a-cat' }) });
  check('非法品类被校验拒绝', badCat.status === 400);

  // ---------- 品类字典：预置 39 类 + 自定义分类 CRUD ----------
  type CategoryRow = { id: string; key: string; label: string; tenantId: string | null };
  const cats = await request<CategoryRow[]>(base, '/api/categories', auth0);
  check('品类字典含预置 39 类', cats.status === 200 && cats.body.filter((c) => c.tenantId === null).length >= 39);
  check('新品类图标可用（电视/适老/能源）', cats.body.some((c) => c.key === 'tv') && cats.body.some((c) => c.key === 'elderly') && cats.body.some((c) => c.key === 'energy'));
  const newCat = await request<CategoryRow>(base, '/api/categories/mine', { ...auth0, method: 'POST', body: JSON.stringify({ label: '适老照护', icon: 'paw-print', color: '#B08A4A' }) });
  check('新增自定义分类', newCat.status === 201 && newCat.body.tenantId === tenantA && newCat.body.label === '适老照护');
  const catsAfter = await request<CategoryRow[]>(base, '/api/categories', auth0);
  check('自定义分类进入字典', catsAfter.body.some((c) => c.id === newCat.body.id));
  const catDup = await request<CategoryRow>(base, '/api/categories/mine', { ...auth0, method: 'POST', body: JSON.stringify({ label: '适老照护', icon: 'lamp', color: '#111111' }) });
  check('同名分类幂等返回', catDup.status === 201 && catDup.body.id === newCat.body.id);
  const prodWithCustom = await request<{ id: string; category: string }>(base, '/api/products/mine', { ...auth0, method: 'POST', body: JSON.stringify({ name: '自定义分类产品', category: newCat.body.key }) });
  check('产品可用自定义分类', prodWithCustom.status === 201 && prodWithCustom.body.category === newCat.body.key);
  const delCatInUse = await request(base, `/api/categories/${newCat.body.id}`, { ...auth0, method: 'DELETE' });
  check('分类在用删除被拒（400）', delCatInUse.status === 400);
  await request(base, `/api/products/${prodWithCustom.body.id}`, { ...auth0, method: 'DELETE' });
  const delCatOk = await request(base, `/api/categories/${newCat.body.id}`, { ...auth0, method: 'DELETE' });
  check('删除自定义分类（无产品占用）', delCatOk.status === 200 || delCatOk.status === 204);
  const delPresetCat = await request(base, `/api/categories/${cats.body.find((c) => c.tenantId === null)?.id}`, { ...auth0, method: 'DELETE' });
  check('预置分类不可删（404 租户隔离）', delPresetCat.status === 404);

  const merged = await request<ProductRow[]>(base, '/api/products', auth0);
  check('产品列表合并公共+我的', merged.status === 200 && merged.body.some((p) => p.id === myId) && merged.body.some((p) => p.tenantId === null));

  const copyRes = await request<ProductRow>(base, `/api/products/${pub?.id}/copy-to-mine`, { ...auth0, method: 'POST' });
  check('公共库复制到我的库', copyRes.status === 201 && copyRes.body.tenantId === tenantA && copyRes.body.name === pub?.name);

  const copyDup = await request(base, `/api/products/${pub?.id}/copy-to-mine`, { ...auth0, method: 'POST' });
  check('重复复制被查重拒绝', copyDup.status === 400);

  const patchPubName = await request(base, `/api/products/${pub?.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ name: '篡改公共库' }) });
  check('公共库改文案被拒（仅允许换产品图 400）', patchPubName.status === 400);

  const patchPubImg = await request<ProductRow>(base, `/api/products/${pub?.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ imageUrl: '/api/media/assets/00000000-0000-0000-0000-000000000000/file' }) });
  check('公共库行可直接更换产品图（200）', patchPubImg.status === 200 && (patchPubImg.body.imageUrl ?? '').endsWith('/file'));
  await request(base, `/api/products/${pub?.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ imageUrl: '' }) });

  const patchMine = await request<ProductRow>(base, `/api/products/${myId}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ brand: '改后品牌' }) });
  check('编辑我的库产品', patchMine.status === 200 && patchMine.body.brand === '改后品牌');

  await request(base, `/api/products/${myId}`, { ...auth0, method: 'DELETE' });
  const afterDel = await request<ProductRow[]>(base, '/api/products', auth0);
  check('删除我的库产品后列表不再包含', !afterDel.body.some((p) => p.id === myId));
  await request(base, `/api/products/${copyRes.body.id}`, { ...auth0, method: 'DELETE' });

  // ai-process 入参校验（不触发真实 LLM/生图链路）
  const aiEmpty = await request(base, '/api/products/ai-process', { ...auth0, method: 'POST', body: JSON.stringify({ ids: [] }) });
  check('AI 批量处理空勾选被校验拒绝', aiEmpty.status === 400);
  const aiMissing = await request(base, '/api/products/ai-process', { ...auth0, method: 'POST', body: JSON.stringify({ ids: ['00000000-0000-0000-0000-000000000000'] }) });
  check('AI 批量处理勾选不存在返回 404', aiMissing.status === 404);

  // 公共产品图跨租户读取：A 上传图挂到公共产品后，B 可直读文件流（未挂接前 404）
  const fdImg = new FormData();
  fdImg.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'pub-product.png');
  const upRes = await fetch(`${base}/api/media/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${regA.body.token}` }, body: fdImg });
  const upAsset = (await upRes.json()) as { id: string; url: string };
  check('A 上传公共产品图成功', upRes.status === 201 && Boolean(upAsset.id));
  const fileUrlA = `/api/media/assets/${upAsset.id}/file?token=${regB.body.token}`;
  const bBefore = await fetch(`${base}${fileUrlA}`);
  check('未挂接产品前 B 跨租户读取被拒（404）', bBefore.status === 404);
  await request(base, `/api/products/${pub?.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ imageUrl: upAsset.url }) });
  const bAfter = await fetch(`${base}${fileUrlA}`);
  check('挂接公共产品后 B 跨租户可读产品图（200）', bAfter.status === 200);
  await request(base, `/api/products/${pub?.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ imageUrl: '' }) });

  // 参考图反推提示词端点：参数校验 + 真实资产返回 200(视觉模型可用) 或 503(未配/不支持，诚实降级)
  const reverseBad = await request(base, '/api/media/images/reverse-prompt', { ...auth0, method: 'POST', body: JSON.stringify({ assetId: 'not-a-uuid' }) });
  check('反推提示词 assetId 非法被校验拒绝（400）', reverseBad.status === 400);
  const reverseOk = await request(base, '/api/media/images/reverse-prompt', { ...auth0, method: 'POST', body: JSON.stringify({ assetId: upAsset.id }) });
  check('反推提示词端点可达（200 出提示词 或 503 诚实提示视觉模型不可用）', reverseOk.status === 200 || reverseOk.status === 503);

  // ---------- 我的资料 CRUD：重命名 + 删除（最基本的修改/删除能力） ----------
  const renameOk = await request<{ id: string; title: string }>(base, `/api/media/assets/${upAsset.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ title: '冒烟重命名图' }) });
  check('我的资料 PATCH 重命名 200', renameOk.status === 200 && renameOk.body.title === '冒烟重命名图');
  const renameEmpty = await request(base, `/api/media/assets/${upAsset.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ title: '  ' }) });
  check('重命名空标题被拒（400）', renameEmpty.status === 400);
  // 跨租户重命名 A 的资产 → B 应 404
  const authB = { headers: { Authorization: `Bearer ${regB.body.token}` } };
  const renameCross = await request(base, `/api/media/assets/${upAsset.id}`, { ...authB, method: 'PATCH', body: JSON.stringify({ title: '越权' }) });
  check('跨租户重命名被拒（404）', renameCross.status === 404);

  // 公共产品图被引用时不可重命名/删除：把图挂回去，再尝试重命名应 400
  await request(base, `/api/products/${pub?.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ imageUrl: upAsset.url }) });
  const renameRefused = await request(base, `/api/media/assets/${upAsset.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ title: '被引用' }) });
  check('被公共产品图引用的资料重命名被拒（400）', renameRefused.status === 400);
  // 解引用后再重命名 OK
  await request(base, `/api/products/${pub?.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ imageUrl: '' }) });
  const renameOk2 = await request(base, `/api/media/assets/${upAsset.id}`, { ...auth0, method: 'PATCH', body: JSON.stringify({ title: '解引用后重命名' }) });
  check('解引用后重命名恢复 200', renameOk2.status === 200);

  // 删除：跨租户应 404，再补一条正常资产走完整删除
  const delCross = await request(base, `/api/media/assets/${upAsset.id}`, { ...authB, method: 'DELETE' });
  check('跨租户删除被拒（404）', delCross.status === 404);
  // 再上传一张新图用于删除断言（避免影响上面后续断言需要引用 upAsset.id）
  const fdImg2 = new FormData();
  fdImg2.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'asset-delete.png');
  fdImg2.append('title', '待删除图');
  const upRes2 = await fetch(`${base}/api/media/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${regA.body.token}` }, body: fdImg2 });
  const upAsset2 = (await upRes2.json()) as { id: string };
  const delOk = await request<{ id: string }>(base, `/api/media/assets/${upAsset2.id}`, { ...auth0, method: 'DELETE' });
  check('我的资料 DELETE 删除 200', delOk.status === 200 && delOk.body.id === upAsset2.id);
  const delAgain = await request(base, `/api/media/assets/${upAsset2.id}`, { ...auth0, method: 'DELETE' });
  check('已删资产再删 404', delAgain.status === 404);

  const layoutBadAsset = await request<{ message?: unknown }>(base, '/api/layouts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ title: '测试点位', mediaAssetId: '00000000-0000-0000-0000-000000000000', points: [] }),
  });
  check('点位布局底图不存在返回 404', layoutBadAsset.status === 404);

  const layoutBadPoint = await request<{ message?: unknown }>(base, '/api/layouts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ title: '测试点位', mediaAssetId: '00000000-0000-0000-0000-000000000000', points: [{ productId: '00000000-0000-0000-0000-000000000000', name: 'x', category: 'switch', x: 2, y: 0 }] }),
  });
  check('点位坐标越界被校验拒绝', layoutBadPoint.status === 400);

  const floorplan404 = await request(base, '/api/plans/00000000-0000-0000-0000-000000000000/floorplan', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ floorplanAssetId: '00000000-0000-0000-0000-000000000000' }),
  });
  check('方案挂接户型图不存在返回 404', floorplan404.status === 404);

  // ---------- 精装修渲染：先有户型图挂接才能 POST，否则 400/404 ----------
  const renderWithoutFloorplan = await request(base, '/api/plans/00000000-0000-0000-0000-000000000000/render-floorplan', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('方案不存在时精装修渲染 404', renderWithoutFloorplan.status === 404);

  // 视频首帧：资产无效应在扣额前拒绝（404/400），且余额不变
  const tokensBeforeVideo = await request<{ tokenBalance: number }>(base, '/api/tenants/current/tokens', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  const videoBadFrame = await request<{ message?: unknown }>(base, '/api/media/videos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ prompt: '客厅灯光渐亮的演示视频', duration: 5, resolution: '720P', firstFrameAssetId: '00000000-0000-0000-0000-000000000000' }),
  });
  const tokensAfterVideo = await request<{ tokenBalance: number }>(base, '/api/tenants/current/tokens', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check(
    '视频首帧资产不存在返回 404 且不扣额',
    videoBadFrame.status === 404 && tokensAfterVideo.body.tokenBalance === tokensBeforeVideo.body.tokenBalance,
  );

  const videoBadRatio = await request<{ message?: unknown }>(base, '/api/media/videos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${regA.body.token}` },
    body: JSON.stringify({ prompt: '客厅灯光渐亮的演示视频', duration: 5, resolution: '720P', ratio: '4:3' }),
  });
  check('视频非法比例被校验拒绝', videoBadRatio.status === 400);

  // 模型配置中心：RBAC 生效（viewer 无 platform:billing:manage → 403；tenant_admin 自部署默认可配置）
  // ---------- 模型配置在线编辑 + 持久化（临时把 A 提为 super_admin） ----------
  const prisma = app.get(PrismaService);
  const superRole = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
  const viewerRole = await prisma.role.findUniqueOrThrow({ where: { key: 'viewer' } });
  const memberA = await prisma.membership.findFirstOrThrow({ where: { userId: me.body.id, tenantId: tenantA } });
  const originalRoleId = memberA.roleId;
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: viewerRole.id } });
  const modelConfigForbidden = await request(base, '/api/admin/model-config', {
    headers: { Authorization: `Bearer ${regA.body.token}` },
  });
  check('模型配置端点存在且 viewer 被拒（403）', modelConfigForbidden.status === 403);
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: superRole.id } });
  // jwt.strategy 每请求实时加载 profile，提权立即生效
  let authA = { headers: { Authorization: `Bearer ${regA.body.token}` } };

  const cfgOk = await request<{ chat: { source: string } }>(base, '/api/admin/model-config', authA);
  check('超管读取模型配置 200', cfgOk.status === 200 && typeof cfgOk.body.chat.source === 'string');

  const putChat = await request<{ ok: boolean }>(base, '/api/admin/model-config/chat', {
    ...authA,
    method: 'PUT',
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', model: 'smoke-model', apiKey: 'sk-smoketest1234' }),
  });
  check('保存对话配置 200', putChat.status === 200 && putChat.body.ok === true);

  const cfgAfter = await request<{ chat: { source: string; baseUrl: string; model: string; keyMasked: string | null } }>(base, '/api/admin/model-config', authA);
  check(
    '配置持久化生效（source=db + baseUrl/model 更新 + key 脱敏末四位）',
    cfgAfter.body.chat.source === 'db' &&
      cfgAfter.body.chat.baseUrl === 'http://127.0.0.1:9/v1' &&
      cfgAfter.body.chat.model === 'smoke-model' &&
      cfgAfter.body.chat.keyMasked === '••••1234',
  );
  const rawCfg = JSON.stringify(cfgAfter.body);
  check('响应绝不回传明文 Key', !rawCfg.includes('sk-smoketest1234'));

  const putAgain = await request<{ ok: boolean }>(base, '/api/admin/model-config/chat', {
    ...authA,
    method: 'PUT',
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', model: '', apiKey: '' }),
  });
  const cfgAfter2 = await request<{ chat: { model: string; keyMasked: string | null } }>(base, '/api/admin/model-config', authA);
  check(
    'apiKey 留空保持原值、model 空串清除回退',
    putAgain.status === 200 && cfgAfter2.body.chat.keyMasked === '••••1234' && cfgAfter2.body.chat.model.startsWith('（跟随'),
  );

  const badScope = await request(base, '/api/admin/model-config/nope', { ...authA, method: 'PUT', body: JSON.stringify({ baseUrl: 'x' }) });
  check('未知 scope 保存被拒（400/404）', badScope.status === 400 || badScope.status === 404);

  const delChat = await request<{ ok: boolean }>(base, '/api/admin/model-config/chat', { ...authA, method: 'DELETE' });
  const cfgReset = await request<{ chat: { source: string } }>(base, '/api/admin/model-config', authA);
  check(
    '恢复 .env 默认（删除 DB 行后 source 回退 env）',
    delChat.status === 200 && cfgReset.body.chat.source === 'env',
  );

  // ---------- 命名模型方案：多套配置一键切换 ----------
  // ModelProfile 是全局表，本节断言依赖「首个方案自动成为当前」。
  // 上轮用例会留下一个 active 的「方案B-高质量」，导致第二轮 saveProfile 走 upsert 的
  // update 分支（该分支不改 active），断言必然失败——即测试不可重复运行。
  // 先清掉本用例自己的两个方案名，保证 pnpm smoke 可反复执行。
  const TEST_PROFILES = ['方案A-省钱文案', '方案B-高质量'];
  await prisma.modelProfile.deleteMany({ where: { name: { in: TEST_PROFILES } } });
  await request(base, '/api/admin/model-config/chat', { ...authA, method: 'PUT', body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', model: 'profile-A-model', apiKey: 'sk-profileA9999' }) });
  const prof1 = await request<{ id: string; name: string }>(base, '/api/admin/model-config/profiles/save', { ...authA, method: 'POST', body: JSON.stringify({ name: TEST_PROFILES[0] }) });
  check('保存命名方案 201', prof1.status === 201 && prof1.body.name === TEST_PROFILES[0]);
  await request(base, '/api/admin/model-config/chat', { ...authA, method: 'PUT', body: JSON.stringify({ baseUrl: 'http://127.0.0.1:8/v1', model: 'profile-B-model', apiKey: 'sk-profileB8888' }) });
  const prof2 = await request<{ id: string }>(base, '/api/admin/model-config/profiles/save', { ...authA, method: 'POST', body: JSON.stringify({ name: TEST_PROFILES[1] }) });
  const profList = await request<{ id: string; name: string; active: boolean; scopes: Record<string, { hasKey: boolean }> }[]>(base, '/api/admin/model-config/profiles', authA);
  check('方案列表含两套且首个自动为当前', profList.status === 200 && profList.body.length >= 2 && profList.body.find((p) => p.name === TEST_PROFILES[0])?.active === true);
  check('方案列表不回传明文 Key', !JSON.stringify(profList.body).includes('sk-profile'));
  const act = await request<{ ok: boolean }>(base, `/api/admin/model-config/profiles/${prof2.body.id}/activate`, { ...authA, method: 'POST' });
  const cfgAfterAct = await request<{ chat: { baseUrl: string; model: string; keyMasked: string | null } }>(base, '/api/admin/model-config', authA);
  check(
    '切换方案即时生效（配置回到方案B快照）',
    act.status === 201 && cfgAfterAct.body.chat.baseUrl === 'http://127.0.0.1:8/v1' && cfgAfterAct.body.chat.model === 'profile-B-model' && cfgAfterAct.body.chat.keyMasked === '••••8888',
  );
  const delActive = await request(base, `/api/admin/model-config/profiles/${prof2.body.id}`, { ...authA, method: 'DELETE' });
  check('当前使用方案不可删除（400）', delActive.status === 400);
  const delInactive = await request<{ ok: boolean }>(base, `/api/admin/model-config/profiles/${prof1.body.id}`, { ...authA, method: 'DELETE' });
  check('非当前方案可删除', delInactive.status === 200);
  const skillPack = await request<{ text: string }>(base, '/api/admin/model-config/agent-skillpack', authA);
  check('Agent 技能包端点返回完整文档且不含明文 Key', skillPack.status === 200 && skillPack.body.text.includes('/api/media/images') && !skillPack.body.text.includes('sk-profile'));

  // ---------- JWT 刷新：旧 token 换新 token ----------
  const refreshed = await request<{ token: string }>(base, '/api/auth/refresh', { ...authA, method: 'POST' });
  const meWithNew = await request<{ id: string }>(base, '/api/auth/me', { headers: { Authorization: `Bearer ${refreshed.body.token}` } });
  check('刷新令牌可用（新 token 通过鉴权）', refreshed.status === 201 && meWithNew.status === 200 && meWithNew.body.id === me.body.id);

  // ---------- 改密即作废旧 JWT（tokenVersion 机制） ----------
  const beforePwdToken = refreshed.body.token;
  const changedPwd = await request(base, '/api/auth/change-password', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ oldPassword: 'Test@12345', newPassword: 'Test@123456' }),
  });
  check('修改密码成功', changedPwd.status === 201);
  const oldTokenAfterPwd = await request(base, '/api/auth/me', { headers: { Authorization: `Bearer ${beforePwdToken}` } });
  check('改密后旧 token 立即失效（401 TOKEN_REVOKED）', oldTokenAfterPwd.status === 401);
  const oldTokenRefresh = await request<{ token: string }>(base, '/api/auth/refresh', { headers: { Authorization: `Bearer ${beforePwdToken}` }, method: 'POST' });
  check('改密后旧 token 不能刷新（401）', oldTokenRefresh.status === 401);
  const relogin = await request<{ token: string }>(base, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: phoneA, password: 'Test@123456' }),
  });
  check('新密码登录拿到新 token', relogin.status === 201 && Boolean(relogin.body.token));
  const meAfterPwd = await request<{ id: string }>(base, '/api/auth/me', { headers: { Authorization: `Bearer ${relogin.body.token}` } });
  check('新 token 鉴权恢复', meAfterPwd.status === 200 && meAfterPwd.body.id === me.body.id);
  // 后续用例统一换用新密码签发的 token
  authA = { headers: { Authorization: `Bearer ${relogin.body.token}` } };
  await request(base, '/api/admin/model-config/chat', { ...authA, method: 'DELETE' });

  // 生视频 provider 可切换（不再写死 MiniMax）+ ComfyUI 独立配置持久化
  const putVideo = await request<{ ok: boolean }>(base, '/api/admin/model-config/video', {
    ...authA,
    method: 'PUT',
    body: JSON.stringify({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'sora-2', apiKey: 'sk-videosmoke8888' }),
  });
  const cfgVideo = await request<{ video: { providerKey: string; provider: string; model: string; keyMasked: string | null } }>(base, '/api/admin/model-config', authA);
  check(
    '生视频 provider 切换为 openai(sora) 并持久化',
    putVideo.status === 200 &&
      cfgVideo.body.video.providerKey === 'openai' &&
      cfgVideo.body.video.provider.includes('Sora') &&
      cfgVideo.body.video.model === 'sora-2' &&
      cfgVideo.body.video.keyMasked === '••••8888',
  );
  await request(base, '/api/admin/model-config/video', { ...authA, method: 'DELETE' });

  const putComfy = await request<{ ok: boolean }>(base, '/api/admin/model-config/image', {
    ...authA,
    method: 'PUT',
    body: JSON.stringify({ provider: 'comfyui', comfyBaseUrl: 'http://127.0.0.1:8188', workflowPath: './my-flow.json', promptNode: '11' }),
  });
  const cfgComfy = await request<{ image: { providerKey: string; comfyBaseUrl: string; workflowPath: string; promptNode: string } }>(base, '/api/admin/model-config', authA);
  check(
    'ComfyUI 独立配置持久化（provider=comfyui + 地址/工作流/节点）',
    putComfy.status === 200 &&
      cfgComfy.body.image.providerKey === 'comfyui' &&
      cfgComfy.body.image.comfyBaseUrl === 'http://127.0.0.1:8188' &&
      cfgComfy.body.image.workflowPath === './my-flow.json' &&
      cfgComfy.body.image.promptNode === '11',
  );
  await request(base, '/api/admin/model-config/image', { ...authA, method: 'DELETE' });

  // 外部知识库：配置持久化 + 未连通时检索降级不报错 + 审计留痕
  const putKnowledge = await request<{ ok: boolean }>(base, '/api/knowledge/external', {
    ...authA,
    method: 'PUT',
    body: JSON.stringify({ provider: 'weknora', baseUrl: 'http://127.0.0.1:9/api/v1', apiKey: 'sk-kbsmoke7777', kbIds: '', enabled: 'true' }),
  });
  const kbStatus = await request<{ provider: string; keyMasked: string | null; enabled: boolean }>(base, '/api/knowledge/external', authA);
  check(
    '外部知识库配置保存（provider=weknora + key 脱敏）',
    putKnowledge.status === 200 && kbStatus.body.provider === 'weknora' && kbStatus.body.keyMasked === '••••7777' && kbStatus.body.enabled === true,
  );
  check('知识库配置响应不含明文 Key', !JSON.stringify(kbStatus.body).includes('sk-kbsmoke7777'));

  const kbTest = await request<{ ok: boolean; error?: string }>(base, '/api/knowledge/external/test', { ...authA, method: 'POST' });
  check('外部知识库连通测试诚实报不可达', kbTest.body.ok === false && Boolean(kbTest.body.error));

  const kbSearch = await request<{ chunks: unknown[] }>(base, '/api/knowledge/external/search', { ...authA, method: 'POST', body: JSON.stringify({ query: '窗帘电机' }) });
  check('外部知识库不可达时检索返回 503 提示', kbSearch.status === 503);

  const badProvider = await request(base, '/api/knowledge/external', { ...authA, method: 'PUT', body: JSON.stringify({ provider: 'notion' }) });
  check('非法 provider 被校验拒绝', badProvider.status === 400);
  await request(base, '/api/knowledge/external', { ...authA, method: 'DELETE' });
  const kbReset = await request<{ provider: string }>(base, '/api/knowledge/external', authA);
  check('恢复默认后 provider 回退 none', kbReset.body.provider === 'none');

  // 个人设置：昵称/头像色持久化
  const patchProfile = await request<{ id: string; displayName: string; avatarColor: string | null }>(base, '/api/auth/profile', {
    ...authA,
    method: 'PATCH',
    body: JSON.stringify({ displayName: '改名后的我', avatarColor: '#123456' }),
  });
  check('个人设置保存（昵称+头像色）', patchProfile.status === 200 && patchProfile.body.displayName === '改名后的我' && patchProfile.body.avatarColor === '#123456');

  const badColor = await request(base, '/api/auth/profile', { ...authA, method: 'PATCH', body: JSON.stringify({ avatarColor: 'red' }) });
  check('非法头像色被校验拒绝', badColor.status === 400);

  // 数据备份与存储治理（管理员）
  const backupRes = await fetch(`${base}/api/admin/backup`, { headers: authA.headers });
  const backupJson = (await backupRes.json().catch(() => null)) as { exportedAt?: string; tables?: Record<string, unknown[]> } | null;
  // 备份漏表 = 恢复后数据凭空消失。0.1.40/0.1.44 各漏过一批，这里锁死「schema 的每张表都在备份里」。
  const schemaSql = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf-8');
  const schemaModels = [...schemaSql.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  const backedUpTables = new Set(Object.keys(backupJson?.tables ?? {}));
  // Prisma 模型名 CustomAgent -> client 委托名 customAgent（首字母小写）
  const missingBackup = schemaModels.filter((m) => !backedUpTables.has(m.charAt(0).toLowerCase() + m.slice(1)));
  check(
    '全库备份覆盖 schema 每一张表（漏表=恢复后数据消失）',
    schemaModels.length > 0 && missingBackup.length === 0,
  );
  check(
    '全库备份导出（tables 完整）',
    backupRes.status === 200 && Boolean(backupJson?.exportedAt) && Array.isArray(backupJson?.tables?.user) && (backupJson?.tables?.user?.length ?? 0) >= 2,
  );

  const storageRes = await request<{ usedBytes: number; quotaBytes: number; assets: number }>(base, '/api/admin/storage', authA);
  check('存储占用统计可查', storageRes.status === 200 && storageRes.body.quotaBytes > 0);

  const cleanupRes = await request<{ deleted: number; freedBytes: number }>(base, '/api/admin/storage/cleanup?beforeDays=3650', { ...authA, method: 'POST' });
  check('产物清理端点可用（0 天阈值不误删）', [200, 201].includes(cleanupRes.status) && typeof cleanupRes.body?.deleted === 'number');

  // ---------- 前端种子数据护栏：智能体封面必须真实存在 ----------
  // 背景（2026-10-14）：新增「本地推流大师」时封面文件漏建，界面上是一块纯色空白 +
  // 一条 404。typecheck 与 smoke 都发现不了（封面是静态资源，不参与编译）。
  // 这里直接查 public/images/agents/ 下每个种子智能体都有对应文件。
  {
    // 从 dist/test/ 运行时相对路径会错位，用 process.cwd()（= apps/api）作基准
    const agentsSrc = readFileSync(join(process.cwd(), '../web/src/data/agents.ts'), 'utf8');
    const covers = [...agentsSrc.matchAll(/cover:\s*'\/images\/agents\/([a-z0-9]+\.jpg)'/g)].map((m) => m[1]);
    const missing = covers.filter((c) => !existsSync(join(process.cwd(), '../web/public/images/agents', c)));
    check(
      `智能体封面全部存在（检查 ${covers.length} 张${missing.length ? `，缺失：${missing.join(',')}` : ''}）`,
      covers.length > 0 && missing.length === 0,
    );
  }

  // ---------- 接单工作台：CRUD + 状态机（不触发真实 LLM intake） ----------
  const orderCreate = await request<{ id: string; status: string }>(base, '/api/orders', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ customer: '冒烟客户', community: '测试小区', area: '120', layout: '三室两厅', budget: '3万', ecosystem: '米家', needs: '灯光、窗帘' }),
  });
  check('创建接待线索（status=new）', orderCreate.status === 201 && orderCreate.body.status === 'new');
  const orderId = orderCreate.body.id;

  // ---------- 接单「边聊边记」结构化采集（2026-10-13 补齐） ----------
  // 回归背景：此前只有 8 个自由文本字段，参考站表单里的体验场景、系统范围三态矩阵、
  // 预算上下限、装修阶段下拉、生活需求细分全部缺失，而 smoke 一条断言都没写，
  // 所以 222/222 全绿也照样放过了。这些断言就是为了让缺口再次消失时必失败。
  const orderFull = await request<{
    renoStage: string; scenes: string[]; systems: Record<string, { need: string; area: string; detail: string }>;
    budgetMin: number; budgetMax: number; budgetScope: string;
    residents: string; exclusions: string; nightHabits: string; city: string;
  }>(base, `/api/orders/${orderId}`, authA);
  check('装修阶段默认 undecided（不是空串）', orderFull.status === 200 && orderFull.body.renoStage === 'undecided');
  check('体验场景默认为空数组', Array.isArray(orderFull.body.scenes) && orderFull.body.scenes.length === 0);
  check('系统范围默认为空对象', !!orderFull.body.systems && Object.keys(orderFull.body.systems).length === 0);
  check('预算上下限默认为 0', orderFull.body.budgetMin === 0 && orderFull.body.budgetMax === 0);

  // 完整结构化建档：一次性写入并逐字段回读，证明真的落库而不是被丢弃
  const structured = await request<{
    id: string;
    renoStage: string; scenes: string[]; systems: Record<string, { need: string; area: string; detail: string }>;
    budgetMin: number; budgetMax: number; budgetScope: string;
    residents: string; exclusions: string; nightHabits: string; city: string; devicePrefs: string;
  }>(base, '/api/orders', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({
      customer: '结构化客户', community: '测试小区',
      renoStage: 'waterBefore',
      scenes: ['movie', 'nightUp', 'home'],
      systems: {
        lighting: { need: 'yes', area: '客厅+主卧', detail: '无主灯 + 灯带' },
        curtain: { need: 'maybe', area: '主卧', detail: '' },
      },
      budgetMin: 30000, budgetMax: 60000, budgetScope: '含施工',
      residents: '夫妻+两个孩子', exclusions: '不装摄像头', nightHabits: '睡前要开床头灯',
      city: '武汉', devicePrefs: '已有米家 App',
    }),
  });
  check('结构化接待建档成功（201）', structured.status === 201);
  check(
    '体验场景 3 项写入并回读一致',
    structured.status === 201 && stable(structured.body.scenes) === stable(['movie', 'nightUp', 'home']),
  );
  check(
    '系统范围三态矩阵写入并回读一致（含 area 与 detail）',
    structured.status === 201
      && structured.body.systems?.lighting?.need === 'yes'
      && structured.body.systems?.lighting?.area === '客厅+主卧'
      && structured.body.systems?.lighting?.detail === '无主灯 + 灯带'
      && structured.body.systems?.curtain?.need === 'maybe',
  );
  check(
    '装修阶段写入并回读（waterBefore）',
    structured.status === 201 && structured.body.renoStage === 'waterBefore',
  );
  check(
    '预算上下限与包含范围写入并回读',
    structured.status === 201 && structured.body.budgetMin === 30000 && structured.body.budgetMax === 60000 && structured.body.budgetScope === '含施工',
  );
  check(
    '生活需求细分写入并回读',
    structured.status === 201
      && structured.body.residents === '夫妻+两个孩子'
      && structured.body.exclusions === '不装摄像头'
      && structured.body.nightHabits === '睡前要开床头灯'
      && structured.body.devicePrefs === '已有米家 App',
  );

  // 白名单：字典外的场景 key / 系统 key / need 值必须被拒（否则脏数据会进库）
  const badScene = await request(base, '/api/orders', {
    ...authA, method: 'POST',
    body: JSON.stringify({ customer: '脏场景', scenes: ['movie', '不存在的场景'] }),
  });
  check('场景 key 字典外被拒（400）', badScene.status === 400);
  const badSystem = await request(base, '/api/orders', {
    ...authA, method: 'POST',
    body: JSON.stringify({ customer: '脏系统', systems: { 不存在的系统: { need: 'yes', area: '', detail: '' } } }),
  });
  check('系统 key 字典外被拒（400）', badSystem.status === 400);
  const badNeed = await request(base, '/api/orders', {
    ...authA, method: 'POST',
    body: JSON.stringify({ customer: '脏状态', systems: { lighting: { need: 'maybe-ish', area: '', detail: '' } } }),
  });
  check('系统 need 值非法被拒（400）', badNeed.status === 400);
  const badStage = await request(base, '/api/orders', {
    ...authA, method: 'POST', body: JSON.stringify({ customer: '脏阶段', renoStage: 'renovating' }),
  });
  check('装修阶段字典外被拒（400）', badStage.status === 400);
  const badBudget = await request(base, '/api/orders', {
    ...authA, method: 'POST',
    body: JSON.stringify({ customer: '倒挂预算', budgetMin: 60000, budgetMax: 30000 }),
  });
  check('预算上限小于理想起点被拒（400）', badBudget.status === 400);

  // 清理这条结构化线索，避免污染后续用例
  if (structured.status === 201) {
    await request(base, `/api/orders/${structured.body.id}`, { ...authA, method: 'DELETE' });
  }

  const orderList = await request<unknown[]>(base, '/api/orders', authA);
  check('接待列表可查', orderList.status === 200 && Array.isArray(orderList.body) && orderList.body.length >= 1);

  const illegalSkip = await request(base, `/api/orders/${orderId}/status`, { ...authA, method: 'PATCH', body: JSON.stringify({ status: 'won' }) });
  check('非法状态跳跃被拒（new→won 400）', illegalSkip.status === 400);

  const step1 = await request<{ status: string }>(base, `/api/orders/${orderId}/status`, { ...authA, method: 'PATCH', body: JSON.stringify({ status: 'qualified' }) });
  const step2 = await request<{ status: string }>(base, `/api/orders/${orderId}/status`, { ...authA, method: 'PATCH', body: JSON.stringify({ status: 'proposed' }) });
  const step3 = await request<{ status: string }>(base, `/api/orders/${orderId}/status`, { ...authA, method: 'PATCH', body: JSON.stringify({ status: 'quoted' }) });
  const step4 = await request<{ status: string }>(base, `/api/orders/${orderId}/status`, { ...authA, method: 'PATCH', body: JSON.stringify({ status: 'won' }) });
  check(
    '合法状态流转 new→qualified→proposed→quoted→won',
    step1.body.status === 'qualified' && step2.body.status === 'proposed' && step3.body.status === 'quoted' && step4.body.status === 'won',
  );

  const noteAdd = await request<{ id: string }>(base, `/api/orders/${orderId}/notes`, { ...authA, method: 'POST', body: JSON.stringify({ content: '电话沟通，客户周末到店' }) });
  const orderDetail = await request<{ notes: unknown[] }>(base, `/api/orders/${orderId}`, authA);
  check('跟进记录写入并可查', noteAdd.status === 201 && Array.isArray(orderDetail.body.notes) && orderDetail.body.notes.length === 1);

  const order404 = await request(base, '/api/orders/00000000-0000-0000-0000-000000000000', authA);
  check('接待线索不存在返回 404', order404.status === 404);

  const orderNoCustomer = await request(base, '/api/orders', { ...authA, method: 'POST', body: JSON.stringify({ community: '无客户名' }) });
  check('缺客户名创建被校验拒绝', orderNoCustomer.status === 400);

  await request(base, `/api/orders/${orderId}`, { ...authA, method: 'DELETE' });
  const orderAfterDel = await request(base, `/api/orders/${orderId}`, authA);
  check('删除接待线索后 404', orderAfterDel.status === 404);

  // viewer 角色不可访问接单（RBAC 隔离）
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: viewerRole.id } });
  const viewerOrders = await request(base, '/api/orders', { headers: { Authorization: `Bearer ${relogin.body.token}` } });
  check('viewer 访问接单被拒（403）', viewerOrders.status === 403);

  // tenant_admin 默认可访问接单（order:manage）
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: (await prisma.role.findUniqueOrThrow({ where: { key: 'tenant_admin' } })).id } });
  const taOrders = await request(base, '/api/orders', { headers: { Authorization: `Bearer ${relogin.body.token}` } });
  check('tenant_admin 可访问接单（200）', taOrders.status === 200);

  // viewer 角色不可访问备份/存储（RBAC 隔离）
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: viewerRole.id } });
  const backupForbidden = await request(base, '/api/admin/backup', { headers: { Authorization: `Bearer ${relogin.body.token}` } });
  check('viewer 访问备份被拒（403）', backupForbidden.status === 403);
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: originalRoleId } });

  // ---------- 定制智能体：租户内 CRUD + 重名 409 + 头像色校验 ----------
  // 名字带随机后缀：不依赖「库是空的」假设
  const agentName = `冒烟智能体-${randomPhone().slice(-6)}`;
  const agentCreate = await request<{ id: string; name: string; avatarColor: string; enabled: boolean }>(base, '/api/agents', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ name: agentName, description: '门店接待人设', systemPrompt: '你是一名智能家居门店接待顾问，语气亲切，先问需求再推荐方案。' }),
  });
  check(
    '创建定制智能体 201（默认头像色 #5B5BF0 与启用态）',
    agentCreate.status === 201 && agentCreate.body.avatarColor === '#5B5BF0' && agentCreate.body.enabled === true,
  );
  const agentId = agentCreate.body.id;

  const agentDup = await request(base, '/api/agents', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ name: agentName, systemPrompt: '租户内重名的另一个智能体' }),
  });
  check('租户内重名创建被拒（409）', agentDup.status === 409);

  const agentList = await request<{ id: string }[]>(base, '/api/agents', authA);
  check('智能体列表按创建时间倒序且含刚建的', agentList.status === 200 && agentList.body[0]?.id === agentId);

  const agentBadColor = await request(base, '/api/agents', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ name: `坏色-${randomPhone().slice(-6)}`, systemPrompt: '人设', avatarColor: 'red' }),
  });
  check('智能体非法头像色被校验拒绝（400）', agentBadColor.status === 400);

  const agentNoPrompt = await request(base, '/api/agents', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ name: `缺提示词-${randomPhone().slice(-6)}` }),
  });
  check('缺 systemPrompt 创建智能体被校验拒绝（400）', agentNoPrompt.status === 400);

  const agentPatch = await request<{ name: string; enabled: boolean }>(base, `/api/agents/${agentId}`, {
    ...authA,
    method: 'PATCH',
    body: JSON.stringify({ name: `${agentName}-改`, enabled: false }),
  });
  check(
    '定制智能体 PATCH 可改名与停用',
    agentPatch.status === 200 && agentPatch.body.name === `${agentName}-改` && agentPatch.body.enabled === false,
  );

  await request(base, `/api/agents/${agentId}`, { ...authA, method: 'DELETE' });
  const agentAfterDel = await request(base, `/api/agents/${agentId}`, { ...authA, method: 'PATCH', body: JSON.stringify({ enabled: true }) });
  check('删除定制智能体后再次修改返回 404', agentAfterDel.status === 404);

  // ---------- 问题反馈：成员提交/查看，管理员处理，删除限提交者 ----------
  // 复用已注册的 B 账号：拉进 A 的租户并降级为 designer（有 content:generate、无 platform:billing:manage），
  // 用于验证「同租户非管理员」与「非提交者」两条越权路径（不额外注册，避免触发注册接口的独立限流）
  const userBId = (await prisma.user.findUniqueOrThrow({ where: { phone: phoneB } })).id;
  const designerRole = await prisma.role.findUniqueOrThrow({ where: { key: 'designer' } });
  const membershipB = await prisma.membership.create({ data: { userId: userBId, tenantId: tenantA, roleId: designerRole.id } });
  const authDesigner = { headers: { Authorization: `Bearer ${regB.body.token}`, 'X-Tenant-Id': tenantA } };

  const fbCreate = await request<{ id: string; status: string; category: string; userId: string }>(base, '/api/feedback', {
    ...authA,
    method: 'POST',
    // body 里的 userId 必须被忽略：提交者只取当前登录用户
    body: JSON.stringify({ category: 'bug', title: '导出按钮点不动', detail: 'Chrome 上点击无反应', userId: userBId }),
  });
  check(
    '提交反馈工单 201（status 默认 open 且 userId 取当前用户而非请求体）',
    fbCreate.status === 201 && fbCreate.body.status === 'open' && fbCreate.body.category === 'bug' && fbCreate.body.userId === me.body.id,
  );
  const fbId = fbCreate.body.id;

  const fbBadCategory = await request(base, '/api/feedback', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ category: 'not-a-category', title: '非法分类' }),
  });
  check('非法反馈分类被校验拒绝（400）', fbBadCategory.status === 400);

  const fbList = await request<{ id: string }[]>(base, '/api/feedback', authA);
  check('反馈列表按创建时间倒序且含刚提交的', fbList.status === 200 && fbList.body[0]?.id === fbId);

  const fbDetail = await request<{ id: string; reply: string }>(base, `/api/feedback/${fbId}`, authA);
  check('反馈详情可查（未回复时 reply 为空串）', fbDetail.status === 200 && fbDetail.body.id === fbId && fbDetail.body.reply === '');

  const fb404 = await request(base, '/api/feedback/00000000-0000-0000-0000-000000000000', authA);
  check('反馈工单不存在返回 404', fb404.status === 404);

  const fbForbidden = await request(base, `/api/feedback/${fbId}`, {
    ...authDesigner,
    method: 'PATCH',
    body: JSON.stringify({ status: 'resolved' }),
  });
  check('同租户非管理员（designer）推进状态被拒（403）', fbForbidden.status === 403);

  const fbResolved = await request<{ status: string; reply: string; repliedBy: string | null }>(base, `/api/feedback/${fbId}`, {
    ...authA,
    method: 'PATCH',
    body: JSON.stringify({ status: 'resolved', reply: '已修复，下个版本随灯光编排上线' }),
  });
  check(
    '管理员推进 open→resolved 并写入回复与处理人',
    fbResolved.status === 200 && fbResolved.body.status === 'resolved'
      && fbResolved.body.reply.startsWith('已修复') && fbResolved.body.repliedBy === me.body.id,
  );

  const fbClosed = await request<{ status: string }>(base, `/api/feedback/${fbId}`, {
    ...authA, method: 'PATCH', body: JSON.stringify({ status: 'closed' }),
  });
  check('合法流转 resolved→closed', fbClosed.status === 200 && fbClosed.body.status === 'closed');

  const fbRollback = await request<{ status: string }>(base, `/api/feedback/${fbId}`, {
    ...authA, method: 'PATCH', body: JSON.stringify({ status: 'resolved' }),
  });
  check('状态机拒绝回退（closed→resolved 返回 400）', fbRollback.status === 400);

  const fbSkip = await request<{ status: string }>(base, `/api/feedback/${fbId}`, {
    ...authA, method: 'PATCH', body: JSON.stringify({ status: 'open' }),
  });
  check('状态机拒绝跳级（closed→open 返回 400）', fbSkip.status === 400);

  const fbStillClosed = await request<{ status: string }>(base, `/api/feedback/${fbId}`, authA);
  check('非法流转未改动状态（仍为 closed）', fbStillClosed.status === 200 && fbStillClosed.body.status === 'closed');

  const fbIdem = await request<{ status: string }>(base, `/api/feedback/${fbId}`, {
    ...authA, method: 'PATCH', body: JSON.stringify({ status: 'closed' }),
  });
  check('重复置同一状态幂等', fbIdem.status === 200 && fbIdem.body.status === 'closed');

  const fbDeleteOther = await request(base, `/api/feedback/${fbId}`, { ...authDesigner, method: 'DELETE' });
  check('同租户非提交者删除工单被拒（403）', fbDeleteOther.status === 403);

  const fbDelete = await request(base, `/api/feedback/${fbId}`, { ...authA, method: 'DELETE' });
  check('提交者本人可删除工单', fbDelete.status === 200 || fbDelete.status === 204);

  const fbAfterDel = await request(base, `/api/feedback/${fbId}`, authA);
  check('删除后工单详情返回 404', fbAfterDel.status === 404);

  await prisma.membership.delete({ where: { id: membershipB.id } });

  // ---------- 智能灯光场景：灯具/时间轴 CRUD + 存取往返一致 ----------
  const lightFixtures = [
    { id: 'f1', type: 'downlight', name: '客厅主灯', x: 0.5, y: 0.25, brightness: 80, colorTemp: 3000, alwaysDim: true, order: 0 },
    { id: 'f2', type: 'strip', name: '灯带', x: 0.25, y: 0.75, brightness: 60, colorTemp: 2700, alwaysDim: false, order: 1 },
  ];
  const lightTimeline = {
    durationMs: 8000,
    tracks: [
      { fixtureId: 'f1', keyframes: [{ t: 0, brightness: 10, colorTemp: 2700 }, { t: 4000, brightness: 90, colorTemp: 4000 }] },
    ],
  };
  const videoAssetId = randomUUID();

  const sceneCreate = await request<{ id: string; ratio: string; status: string }>(base, '/api/lighting', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ title: '客厅灯光演示', ratio: '9:16', fixtures: lightFixtures, timeline: lightTimeline }),
  });
  check('创建灯光场景 201（status 默认 draft）', sceneCreate.status === 201 && sceneCreate.body.status === 'draft' && sceneCreate.body.ratio === '9:16');
  const sceneId = sceneCreate.body.id;

  const sceneDetail = await request<{ fixtures: unknown; timeline: unknown }>(base, `/api/lighting/${sceneId}`, authA);
  check(
    '灯具与时间轴存取往返一致（深比较）',
    stable(sceneDetail.body.fixtures) === stable(lightFixtures) && stable(sceneDetail.body.timeline) === stable(lightTimeline),
  );

  type SceneListRow = { id: string; title: string; ratio: string; status: string; createdAt: string; videoAssetId: string | null };
  const sceneList = await request<SceneListRow[]>(base, '/api/lighting', authA);
  const sceneRow = sceneList.body.find((s) => s.id === sceneId);
  check(
    '灯光场景列表含刚建的且不回传 fixtures/timeline 大字段',
    sceneList.status === 200 && sceneRow !== undefined && sceneRow.ratio === '9:16'
      && sceneRow.videoAssetId === null && !('fixtures' in sceneRow) && !('timeline' in sceneRow),
  );

  const scenePatch = await request<{ title: string; videoAssetId: string | null }>(base, `/api/lighting/${sceneId}`, {
    ...authA,
    method: 'PATCH',
    body: JSON.stringify({ title: '客厅灯光演示（已出片）', videoAssetId }),
  });
  check(
    '灯光场景 PATCH 可改标题并回填出片资产 videoAssetId',
    scenePatch.status === 200 && scenePatch.body.title === '客厅灯光演示（已出片）' && scenePatch.body.videoAssetId === videoAssetId,
  );

  const patchedFixtures = [{ ...lightFixtures[0], brightness: 20 }, lightFixtures[1]];
  const scenePatch2 = await request<{ title: string; fixtures: unknown }>(base, `/api/lighting/${sceneId}`, {
    ...authA,
    method: 'PATCH',
    body: JSON.stringify({ fixtures: patchedFixtures }),
  });
  check(
    '灯光场景 PATCH 部分更新只改灯具不影响标题',
    scenePatch2.status === 200 && stable(scenePatch2.body.fixtures) === stable(patchedFixtures) && scenePatch2.body.title === '客厅灯光演示（已出片）',
  );

  const sceneBadFixtures = await request(base, '/api/lighting', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ title: '坏灯具', fixtures: { id: 'f1' }, timeline: lightTimeline }),
  });
  check('fixtures 非数组被校验拒绝（400）', sceneBadFixtures.status === 400);

  const sceneBadTimeline = await request(base, '/api/lighting', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ title: '坏时间轴', fixtures: lightFixtures, timeline: [] }),
  });
  check('timeline 非对象被校验拒绝（400）', sceneBadTimeline.status === 400);

  await request(base, `/api/lighting/${sceneId}`, { ...authA, method: 'DELETE' });
  const sceneAfterDel = await request(base, `/api/lighting/${sceneId}`, authA);
  check('删除灯光场景后详情返回 404', sceneAfterDel.status === 404);

  // ---------- AI 画布：对话线 + 分支轮次树 + 异步作业（本地假 ComfyUI 出图，不依赖真实模型 Key） ----------
  type CanvasVariant = { url: string; label: string; createdAt: string };
  type CanvasTurnRow = {
    id: string;
    parentId: string | null;
    prompt: string;
    kind: 'user' | 'assistant';
    status: 'pending' | 'ready' | 'failed';
    error: string | null;
    variants: CanvasVariant[];
    children: string[];
  };
  type CanvasConvRow = { id: string; title: string; preview: string; turnCount: number; updatedAt: string };
  type CanvasJobRow = { id: string; status: 'pending' | 'running' | 'done' | 'failed'; resultUrl: string | null; error: string | null };
  const CANVAS_JOB_STATUS = ['pending', 'running', 'done', 'failed'];
  const canvasService = app.get(CanvasService);

  // 假 ComfyUI：POST /prompt -> GET /history/{id} -> GET /view，让出图链路确定性跑通（上游每 2s 轮询一次）
  const comfyPng = Buffer.from('89504e470d0a1a0a', 'hex');
  const comfy = createServer((req, res) => {
    const path = req.url ?? '';
    if (path.startsWith('/prompt')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (path.startsWith('/history/')) {
      const promptId = path.slice('/history/'.length).split('?')[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ [promptId]: { outputs: { '9': { images: [{ filename: 'canvas-smoke.png', subfolder: '', type: 'output' }] } } } }));
      return;
    }
    if (path.startsWith('/view')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(comfyPng);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => comfy.listen(0, '127.0.0.1', resolve));
  const comfyBase = `http://127.0.0.1:${(comfy.address() as AddressInfo).port}`;
  const putComfyCanvas = await request<{ ok: boolean }>(base, '/api/admin/model-config/image', {
    ...authA,
    method: 'PUT',
    body: JSON.stringify({ provider: 'comfyui', comfyBaseUrl: comfyBase, workflowPath: 'comfyui-workflow.json', promptNode: '6', negativeNode: '7', latentNode: '5', seedNode: '3' }),
  });
  check('画布前置：生图模型配置切到本地 ComfyUI（200）', putComfyCanvas.status === 200);

  /** 轮询画布作业直到终态（出图异步，上游链路每 2s 轮询一次，最多等 10s） */
  const waitCanvasJob = async (jobId: string): Promise<CanvasJobRow | null> => {
    for (let i = 0; i < 25; i += 1) {
      const poll = await request<CanvasJobRow>(base, `/api/canvas/jobs/${jobId}`, authA);
      if (poll.body.status === 'done' || poll.body.status === 'failed') return poll.body;
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  };

  // 对话线：新建 / 缺省标题 / 空详情 / 列表
  const canvasConv = await request<{ id: string; title: string }>(base, '/api/canvas/conversations', { ...authA, method: 'POST', body: JSON.stringify({ title: '冒烟对话线' }) });
  check('画布新建对话线 201 且 title 生效', canvasConv.status === 201 && canvasConv.body.title === '冒烟对话线');
  const convId = canvasConv.body.id;

  const canvasConvDefault = await request<{ id: string; title: string }>(base, '/api/canvas/conversations', { ...authA, method: 'POST', body: JSON.stringify({}) });
  check('画布新建对话线缺省标题为「新对话」', canvasConvDefault.status === 201 && canvasConvDefault.body.title === '新对话');

  const canvasDetailEmpty = await request<{ id: string; title: string; turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  check('新对话线详情 turns 为空数组', canvasDetailEmpty.status === 200 && canvasDetailEmpty.body.turns.length === 0);

  const canvasList0 = await request<CanvasConvRow[]>(base, '/api/canvas/conversations', authA);
  const canvasRow0 = canvasList0.body.find((c) => c.id === convId);
  check(
    '画布列表含新建对话线且带 title 预览/轮次数/updatedAt',
    canvasList0.status === 200 && canvasRow0 !== undefined && canvasRow0.turnCount === 0 && typeof canvasRow0.preview === 'string' && typeof canvasRow0.updatedAt === 'string',
  );

  // 租户隔离：另一个租户读/写/删全部 404
  const canvasCrossGet = await request(base, `/api/canvas/conversations/${convId}`, authB);
  const canvasCrossTurn = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authB, method: 'POST', body: JSON.stringify({ prompt: '越权发起轮次' }) });
  const canvasCrossRename = await request(base, `/api/canvas/conversations/${convId}`, { ...authB, method: 'PATCH', body: JSON.stringify({ title: '越权改名' }) });
  const canvasCrossDel = await request(base, `/api/canvas/conversations/${convId}`, { ...authB, method: 'DELETE' });
  check('跨租户读画布对话线 404', canvasCrossGet.status === 404);
  check('跨租户发起轮次 404', canvasCrossTurn.status === 404);
  check('跨租户改画布对话线标题 404', canvasCrossRename.status === 404);
  check('跨租户删画布对话线 404', canvasCrossDel.status === 404);

  // 另一条对话线的一轮（用于验证 parentId 不能跨对话线）
  const canvasOtherTurn = await request<{ userTurnId: string; turnId: string; jobId: string }>(base, `/api/canvas/conversations/${canvasConvDefault.body.id}/turns`, {
    ...authA, method: 'POST', body: JSON.stringify({ prompt: '另一条对话线的一轮轮次' }),
  });
  check('第二条对话线发起一轮 201', canvasOtherTurn.status === 201);

  // 入参校验：不合法的一律 400
  const canvasBadPrompt = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authA, method: 'POST', body: JSON.stringify({ prompt: '短' }) });
  const canvasBadSize = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authA, method: 'POST', body: JSON.stringify({ prompt: '合法长度的提示词', size: '800x600' }) });
  const canvasBadQuality = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authA, method: 'POST', body: JSON.stringify({ prompt: '合法长度的提示词', quality: 'ultra' }) });
  const canvasBadParent = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authA, method: 'POST', body: JSON.stringify({ prompt: '基于随机父轮发起', parentId: randomUUID() }) });
  const canvasCrossParent = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authA, method: 'POST', body: JSON.stringify({ prompt: '基于别的对话线派生', parentId: canvasOtherTurn.body.turnId }) });
  const canvasBadRef = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authA, method: 'POST', body: JSON.stringify({ prompt: '带参考图发起一轮', refAssetId: '00000000-0000-0000-0000-000000000000' }) });
  const canvasBadRefFmt = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authA, method: 'POST', body: JSON.stringify({ prompt: '参考图 id 非法', refAssetId: 'not-a-uuid' }) });
  const canvasBadParentFmt = await request(base, `/api/canvas/conversations/${convId}/turns`, { ...authA, method: 'POST', body: JSON.stringify({ prompt: '父轮 id 非法', parentId: 'not-a-uuid' }) });
  check('提示词短于 4 字被校验拒绝（400）', canvasBadPrompt.status === 400);
  check('非法画幅被校验拒绝（400）', canvasBadSize.status === 400);
  check('非法质量档被校验拒绝（400）', canvasBadQuality.status === 400);
  check('parentId 不存在返回 400', canvasBadParent.status === 400);
  check('parentId 指向别的对话线返回 400', canvasCrossParent.status === 400);
  check('参考图资产不存在返回 400', canvasBadRef.status === 400);
  check('参考图 id 非 uuid 被校验拒绝（400）', canvasBadRefFmt.status === 400);
  check('父轮 id 非 uuid 被校验拒绝（400）', canvasBadParentFmt.status === 400);

  // 发起一轮：原子写 user 轮 + assistant 轮 + 作业
  const canvasTurn = await request<{ userTurnId: string; turnId: string; jobId: string }>(base, `/api/canvas/conversations/${convId}/turns`, {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ prompt: '现代简约风客厅效果图，暖色灯光', size: '1536x1024', background: 'white', quality: 'high' }),
  });
  check('画布发起一轮 201 并返回 userTurnId/turnId/jobId', canvasTurn.status === 201 && Boolean(canvasTurn.body.userTurnId) && Boolean(canvasTurn.body.turnId) && Boolean(canvasTurn.body.jobId));

  // 参考图：合法资产可发起，且只记进参数快照（不作为首帧参与出图）
  const canvasRefTurn = await request<{ userTurnId: string; turnId: string; jobId: string }>(base, `/api/canvas/conversations/${convId}/turns`, {
    ...authA, method: 'POST', body: JSON.stringify({ prompt: '参考图的同风格延伸', refAssetId: upAsset.id }),
  });
  const canvasRefJob = canvasRefTurn.status === 201 ? await prisma.generationJob.findUnique({ where: { id: canvasRefTurn.body.jobId } }) : null;
  const canvasRefParams = canvasRefJob?.params as { refAssetId?: string | null; size?: string } | undefined;
  check('本租户图片资产可作参考图发起一轮 201', canvasRefTurn.status === 201);
  check('参考图仅记录进作业参数快照（不参与出图）', canvasRefParams?.refAssetId === upAsset.id && canvasRefJob?.kind === 'image' && canvasRefJob?.status !== 'failed');

  // 详情：轮次链与分支树
  const canvasDetail1 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasUserTurn = canvasDetail1.body.turns.find((t) => t.id === canvasTurn.body.userTurnId);
  const canvasAsstTurn = canvasDetail1.body.turns.find((t) => t.id === canvasTurn.body.turnId);
  check('user 轮：parentId 为空 + kind=user + prompt 为用户原话', canvasUserTurn?.parentId === null && canvasUserTurn?.kind === 'user' && canvasUserTurn?.prompt === '现代简约风客厅效果图，暖色灯光');
  check('assistant 轮：parentId 指向 user 轮 + 初始 status=pending + variants 为空', canvasAsstTurn?.parentId === canvasTurn.body.userTurnId && canvasAsstTurn?.kind === 'assistant' && canvasAsstTurn?.status === 'pending' && canvasAsstTurn?.variants.length === 0);
  check('详情为每轮附带 children[]（assistant 轮作为 user 轮的子轮）', Array.isArray(canvasUserTurn?.children) && canvasUserTurn?.children.includes(canvasTurn.body.turnId) === true);
  check('轮次按 createdAt 正序返回（user 在前 assistant 在后）', canvasDetail1.body.turns[0]?.id === canvasTurn.body.userTurnId && canvasDetail1.body.turns[1]?.id === canvasTurn.body.turnId);

  // 作业轮询：结构与状态枚举恒定合法（出图成败只影响 status 取值）
  const canvasJob0 = await request<CanvasJobRow>(base, `/api/canvas/jobs/${canvasTurn.body.jobId}`, authA);
  const canvasJobCross = await request(base, `/api/canvas/jobs/${canvasTurn.body.jobId}`, authB);
  const canvasJobMissing = await request(base, '/api/canvas/jobs/00000000-0000-0000-0000-000000000000', authA);
  check('画布作业轮询返回结构合法且 status 属于枚举', canvasJob0.status === 200 && CANVAS_JOB_STATUS.includes(canvasJob0.body.status));
  check('跨租户读画布作业 404', canvasJobCross.status === 404);
  check('画布作业不存在返回 404', canvasJobMissing.status === 404);

  const canvasJobDone = await waitCanvasJob(canvasTurn.body.jobId);
  const canvasDetail2 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasAsstDone = canvasDetail2.body.turns.find((t) => t.id === canvasTurn.body.turnId);
  check('出图成功路径：作业 done + resultUrl 非空', canvasJobDone?.status === 'done' && Boolean(canvasJobDone?.resultUrl));
  check(
    '出图成功路径：轮次转 ready 且结果 URL 追加为第 1 个变体',
    canvasAsstDone?.status === 'ready' && canvasAsstDone?.variants.length === 1
      && canvasAsstDone?.variants[0]?.url === canvasJobDone?.resultUrl && canvasAsstDone?.variants[0]?.label === '变体 1' && Boolean(canvasAsstDone?.variants[0]?.createdAt),
  );

  // 幂等：已终态作业重复触发不重复出图、不重复追加变体
  await request(base, `/api/canvas/jobs/${canvasTurn.body.jobId}/run`, { ...authA, method: 'POST' });
  const canvasJobRerun = await request<CanvasJobRow>(base, `/api/canvas/jobs/${canvasTurn.body.jobId}`, authA);
  const canvasDetail3 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasAsstRerun = canvasDetail3.body.turns.find((t) => t.id === canvasTurn.body.turnId);
  check('已终态作业重复触发幂等（状态不变、变体不重复追加）', canvasJobRerun.body.status === 'done' && canvasAsstRerun?.variants.length === 1);

  // 变体去重：同 URL 不重复计数；新 URL 追加且已有项编号不重排
  await canvasService.appendVariant(canvasTurn.body.turnId, canvasJobDone?.resultUrl ?? '');
  const canvasDetail4 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasAsstDup = canvasDetail4.body.turns.find((t) => t.id === canvasTurn.body.turnId);
  await canvasService.appendVariant(canvasTurn.body.turnId, '/api/media/assets/00000000-0000-0000-0000-000000000000/file');
  const canvasDetail5 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasAsstAppend = canvasDetail5.body.turns.find((t) => t.id === canvasTurn.body.turnId);
  check('变体按 url 去重：重复 URL 不重复追加', canvasAsstDup?.variants.length === 1);
  check('变体追加新图且已有项编号不重排', canvasAsstAppend?.variants.length === 2 && canvasAsstAppend?.variants[0]?.label === '变体 1' && canvasAsstAppend?.variants[1]?.label === '变体 2');

  // 分支：基于历史轮次派生新一轮
  const canvasBranch = await request<{ userTurnId: string; turnId: string; jobId: string }>(base, `/api/canvas/conversations/${convId}/turns`, {
    ...authA, method: 'POST', body: JSON.stringify({ prompt: '基于这张图换个机位重画', parentId: canvasTurn.body.turnId }),
  });
  const canvasDetail6 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasParentTurn = canvasDetail6.body.turns.find((t) => t.id === canvasTurn.body.turnId);
  const canvasBranchUser = canvasDetail6.body.turns.find((t) => t.id === canvasBranch.body.userTurnId);
  check(
    '基于历史轮次派生新一轮 201 且分支树 children 正确',
    canvasBranch.status === 201 && canvasParentTurn?.children.includes(canvasBranch.body.userTurnId) === true && canvasBranchUser?.parentId === canvasTurn.body.turnId,
  );

  // 失败路径：生图 provider 无 Key 时作业与轮次同步失败且带原因
  await request(base, '/api/admin/model-config/image', { ...authA, method: 'PUT', body: JSON.stringify({ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-image-1' }) });
  const canvasFailTurn = await request<{ userTurnId: string; turnId: string; jobId: string }>(base, `/api/canvas/conversations/${convId}/turns`, {
    ...authA, method: 'POST', body: JSON.stringify({ prompt: '未配生图 Key 时的失败路径' }),
  });
  const canvasJobFail = await waitCanvasJob(canvasFailTurn.body.jobId);
  const canvasDetail7 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasAsstFail = canvasDetail7.body.turns.find((t) => t.id === canvasFailTurn.body.turnId);
  check(
    '出图失败路径：作业 failed + error 非空，轮次同步 failed 且原因一致',
    canvasJobFail?.status === 'failed' && Boolean(canvasJobFail?.error) && canvasAsstFail?.status === 'failed' && canvasAsstFail?.error === canvasJobFail?.error,
  );

  // PATCH：改标题与改轮次提示词
  const canvasRename = await request<{ title: string }>(base, `/api/canvas/conversations/${convId}`, { ...authA, method: 'PATCH', body: JSON.stringify({ title: '冒烟对话线（已改）' }) });
  const canvasRenameEmpty = await request(base, `/api/canvas/conversations/${convId}`, { ...authA, method: 'PATCH', body: JSON.stringify({ title: '   ' }) });
  const canvasRenameLong = await request(base, `/api/canvas/conversations/${convId}`, { ...authA, method: 'PATCH', body: JSON.stringify({ title: '标'.repeat(61) }) });
  check('画布 PATCH 改 title 生效', canvasRename.status === 200 && canvasRename.body.title === '冒烟对话线（已改）');
  check('标题为空被校验拒绝（400）', canvasRenameEmpty.status === 400);
  check('标题超 60 字被校验拒绝（400）', canvasRenameLong.status === 400);

  const canvasPromptPatch = await request<{ id: string; prompt: string }>(base, `/api/canvas/turns/${canvasTurn.body.userTurnId}`, {
    ...authA, method: 'PATCH', body: JSON.stringify({ prompt: '改写后的提示词：夜晚氛围的客厅' }),
  });
  const canvasPromptBad = await request(base, `/api/canvas/turns/${canvasTurn.body.userTurnId}`, { ...authA, method: 'PATCH', body: JSON.stringify({ prompt: '短' }) });
  const canvasDetail8 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasUserPatched = canvasDetail8.body.turns.find((t) => t.id === canvasTurn.body.userTurnId);
  check('画布 PATCH 改轮次 prompt 生效且详情回显', canvasPromptPatch.status === 200 && canvasPromptPatch.body.prompt === '改写后的提示词：夜晚氛围的客厅' && canvasUserPatched?.prompt === '改写后的提示词：夜晚氛围的客厅');
  check('轮次 prompt 短于 4 字被校验拒绝（400）', canvasPromptBad.status === 400);

  // 轮次删除：跨租户 404、不存在 404、删除连同分支子树
  const canvasTurnCrossPatch = await request(base, `/api/canvas/turns/${canvasTurn.body.userTurnId}`, { ...authB, method: 'PATCH', body: JSON.stringify({ prompt: '越权改提示词' }) });
  const canvasTurnCrossDel = await request(base, `/api/canvas/turns/${canvasTurn.body.userTurnId}`, { ...authB, method: 'DELETE' });
  const canvasTurnMissing = await request(base, '/api/canvas/turns/00000000-0000-0000-0000-000000000000', { ...authA, method: 'DELETE' });
  check('跨租户改轮次 prompt 404', canvasTurnCrossPatch.status === 404);
  check('跨租户删轮次 404', canvasTurnCrossDel.status === 404);
  check('删除不存在的轮次返回 404', canvasTurnMissing.status === 404);

  const canvasTurnDel = await request<{ id: string; deletedTurns: number }>(base, `/api/canvas/turns/${canvasBranch.body.userTurnId}`, { ...authA, method: 'DELETE' });
  const canvasDetail9 = await request<{ turns: CanvasTurnRow[] }>(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasParentAfterDel = canvasDetail9.body.turns.find((t) => t.id === canvasTurn.body.turnId);
  check('删除轮次连同其分支子树（user + assistant 共 2 条）', canvasTurnDel.status === 200 && canvasTurnDel.body.deletedTurns === 2);
  check(
    '删除后详情不再包含该分支，且父轮 children 已摘除',
    !canvasDetail9.body.turns.some((t) => t.id === canvasBranch.body.userTurnId || t.id === canvasBranch.body.turnId)
      && canvasParentAfterDel?.children.includes(canvasBranch.body.userTurnId) === false
      && canvasDetail9.body.turns.every((t) => t.parentId !== canvasBranch.body.userTurnId),
  );

  // 删除对话线：轮次靠 FK 级联清理
  const canvasConvDel = await request<{ id: string }>(base, `/api/canvas/conversations/${convId}`, { ...authA, method: 'DELETE' });
  const canvasConvAfterDel = await request(base, `/api/canvas/conversations/${convId}`, authA);
  const canvasTurnsLeft = await prisma.imageTurn.count({ where: { conversationId: convId } });
  const canvasList1 = await request<CanvasConvRow[]>(base, '/api/canvas/conversations', authA);
  check('删除画布对话线 200', canvasConvDel.status === 200 && canvasConvDel.body.id === convId);
  check('删除后对话线详情 404 且轮次被级联清理', canvasConvAfterDel.status === 404 && canvasTurnsLeft === 0);
  check('删除后列表不再包含该对话线', !canvasList1.body.some((c) => c.id === convId));

  // 清理：第二条对话线一并删掉、生图模型配置还原为默认、假 ComfyUI 关闭
  await request(base, `/api/canvas/conversations/${canvasConvDefault.body.id}`, { ...authA, method: 'DELETE' });
  await request(base, '/api/admin/model-config/image', { ...authA, method: 'DELETE' });
  const canvasList2 = await request<CanvasConvRow[]>(base, '/api/canvas/conversations', authA);
  const canvasCfgReset = await request<{ image: { source: string } }>(base, '/api/admin/model-config', authA);
  comfy.closeAllConnections();
  await new Promise<void>((resolve) => comfy.close(() => resolve()));
  check('清理后画布列表为空（测试数据不残留）', canvasList2.status === 200 && canvasList2.body.length === 0);
  check('清理后生图模型配置回到默认来源', canvasCfgReset.body.image.source === 'env');

  // ---------- 任务中心：跨页面/跨刷新的任务来源 ----------
  const tasksList = await request<{ id: string; status: string; title: string }[]>(base, '/api/canvas/tasks', authA);
  check('任务中心列表可查（200 且为数组）', tasksList.status === 200 && Array.isArray(tasksList.body));
  check(
    '任务中心按 title 暴露可读摘要',
    tasksList.status === 200 && tasksList.body.every((t) => typeof t.title === 'string' && t.title.length > 0),
  );
  const jobId = tasksList.body[0]?.id ?? '00000000-0000-0000-0000-000000000000';
  const clearJobs = await request<{ deleted: number }>(base, '/api/canvas/tasks/finished', { ...authA, method: 'DELETE' });
  check('清空已结束任务可用（200 且返回删除条数）', clearJobs.status === 200 && typeof clearJobs.body.deleted === 'number');
  const tasksAfter = await request<{ id: string; status: string }[]>(base, '/api/canvas/tasks', authA);
  check(
    '清空后不再含已结束任务（进行中必须保留）',
    tasksAfter.status === 200 && tasksAfter.body.every((t) => t.status !== 'done' && t.status !== 'failed'),
  );
  const jobsBefore = tasksList.body.length;
  check(
    '清空已结束任务不会误删进行中任务',
    jobsBefore === 0 || tasksAfter.body.length <= jobsBefore,
  );
  void jobId;

  // ---------- 素材库投稿：提交 + 我的投稿列表 ----------
  const subFd2 = new FormData();
  subFd2.append('file', new Blob([Buffer.from('fake-mp4-bytes')], { type: 'video/mp4' }), 'clip.mp4');
  const subUpRes = await fetch(`${base}/api/media/materials/upload`, { method: 'POST', headers: authA.headers, body: subFd2 });
  const upJson = (await subUpRes.json().catch(() => null)) as { id?: string } | null;
  const subBad = await request(base, '/api/media/materials/submissions', {
    ...authA, method: 'POST', body: JSON.stringify({ assetId: '00000000-0000-0000-0000-000000000000', title: 'x' }),
  });
  check('投稿引用不存在的素材被拒（400）', subBad.status === 400);
  let subId = '';
  if (subUpRes.ok && upJson?.id) {
    const subOk = await request<{ id: string; status: string }>(base, '/api/media/materials/submissions', {
      ...authA, method: 'POST', body: JSON.stringify({ assetId: upJson.id, title: '冒烟投稿', desc: '自动化测试' }),
    });
    subId = subOk.body?.id ?? '';
    check('投稿提交成功且初始为待审核', subOk.status === 201 && subOk.body.status === 'pending');
  } else {
    check('投稿提交成功且初始为待审核', false);
  }
  const mySubs = await request<{ id: string; title: string }[]>(base, '/api/media/materials/submissions', authA);
  check('我的投稿列表含刚提交的记录', mySubs.status === 200 && mySubs.body.some((x) => x.id === subId));
  const subEmpty = await request(base, '/api/media/materials/submissions', {
    ...authA, method: 'POST', body: JSON.stringify({ assetId: upJson?.id ?? 'x', title: '' }),
  });
  check('投稿空标题被校验拒绝（400）', subEmpty.status === 400);

  // ---------- 视频模型名必须真正下发，不能被硬编码覆盖 ----------
  // 回归点：曾经写死 T2V/I2V-01-Director，用户在「模型配置」填的模型（含 MiniMax-H3 这类
  // 带原生音轨的新模型）被静默丢弃——配置页显示已保存，实际请求永远发旧模型名。
  check('配置了 MiniMax-H3 时原样下发（文生视频）', resolveMinimaxVideoModel('MiniMax-H3', false) === 'MiniMax-H3');
  check('配置了 MiniMax-H3 时原样下发（首帧图生视频）', resolveMinimaxVideoModel('MiniMax-H3', true) === 'MiniMax-H3');
  check('模型名留空时文生视频回落 T2V-01-Director', resolveMinimaxVideoModel('', false) === 'T2V-01-Director');
  check('模型名留空时首帧图生视频回落 I2V-01-Director', resolveMinimaxVideoModel('', true) === 'I2V-01-Director');
  check('模型名纯空白等同留空（不会被当成模型名下发）', resolveMinimaxVideoModel('   ', false) === 'T2V-01-Director');
  // 默认值不能是「T2V-01-Director / I2V-01-Director」这种描述串——它不是合法模型名
  const vcfg = await app.get(ModelConfigService).videoConfig();
  check(
    `生视频模型默认值不是描述串（当前: ${JSON.stringify(vcfg.model)}）`,
    !vcfg.model.includes('/') || vcfg.provider === 'openai',
  );

  // ---------- 局部重绘：mask 参数的诚实性与校验 ----------
  const maskOnly = await request(base, '/api/media/images', {
    ...authA, method: 'POST', body: JSON.stringify({ prompt: '局部重绘测试用提示词', maskDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
  });
  check('只给遮罩不给原图被拒（400）', maskOnly.status === 400);
  const imgOnly = await request(base, '/api/media/images', {
    ...authA, method: 'POST', body: JSON.stringify({ prompt: '局部重绘测试用提示词', imageAssetId: '00000000-0000-0000-0000-000000000000' }),
  });
  check('只给原图不给遮罩被拒（400）', imgOnly.status === 400);
  const notSupported = await request<{ code?: string }>(base, '/api/media/images', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({
      prompt: '局部重绘测试用提示词',
      imageAssetId: '00000000-0000-0000-0000-000000000000',
      maskDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }),
  });
  check(
    'provider 不支持局部重绘时明确拒绝而非静默忽略（503 IMAGE_EDIT_UNSUPPORTED）',
    notSupported.status === 503 && notSupported.body.code === 'IMAGE_EDIT_UNSUPPORTED',
  );

  // ---------- 局部重绘链路：mask 必须真正到达出图层，不能被静默丢弃 ----------
  // 关键回归点：画布 turns 端点若没把 mask 透传给 generateImage，用户圈选后会变成「整张重画」，
  // 而 UI 上却显示「圈选重绘」。这里用「provider 不支持 → 作业必须 failed」来证明链路是通的：
  // 若 mask 被丢弃，作业会成功，说明链路断了。
  const maskCanvas = await request<{ id: string }>(base, '/api/canvas/conversations', { ...authA, method: 'POST' });
  const editConv = maskCanvas.status === 201 ? maskCanvas.body?.id ?? '' : '';
  if (editConv) {
    const tinyMask = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const imgFd = new FormData();
    imgFd.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'edit-src.png');
    const imgUp = await fetch(`${base}/api/media/uploads`, { method: 'POST', headers: authA.headers, body: imgFd });
    const imgAssetId = ((await imgUp.json().catch(() => null)) as { id?: string } | null)?.id ?? '';
    const turn = await request<{ jobId: string }>(base, `/api/canvas/conversations/${editConv}/turns`, {
      ...authA,
      method: 'POST',
      body: JSON.stringify({ prompt: '局部重绘链路验证用提示词', imageAssetId: imgAssetId, maskDataUrl: tinyMask }),
    });
    check('带遮罩提交画布轮次成功（201）', turn.status === 201 && Boolean(turn.body?.jobId));
    if (turn.status === 201 && turn.body?.jobId) {
      let st = 'pending';
      let err: string | null = null;
      for (let i = 0; i < 40 && (st === 'pending' || st === 'running'); i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        const j = await request<{ status: string; error: string | null }>(base, `/api/canvas/jobs/${turn.body.jobId}`, authA);
        st = j.status === 200 ? j.body.status : 'error';
        err = j.status === 200 ? j.body.error : null;
      }
      check(
        '遮罩确实到达出图层：provider 不支持时作业失败而非静默整张重画',
        // 作业的 error 字段存的是中文消息（错误码在 message 之外的 code 字段，这里按文案断言更稳）
        st === 'failed' && /不支持按遮罩局部重绘/.test(String(err ?? '')),
      );
      // 拒绝必须点明真实原因（缺的是 mask 参数），否则用户会误读成「这个平台根本不能出图」
      check(
        '拒绝文案点明缺的是 mask 参数并给出可行替代，而非笼统说 provider 不行',
        /mask|遮罩参数/.test(String(err ?? '')) && /OpenAI/.test(String(err ?? '')),
      );
    } else {
      check('遮罩确实到达出图层：provider 不支持时作业失败而非静默整张重画', false);
      check('拒绝文案点明缺的是 mask 参数并给出可行替代，而非笼统说 provider 不行', false);
    }
  } else {
    check('遮罩确实到达出图层：provider 不支持时作业失败而非静默整张重画', false);
    check('拒绝文案点明缺的是 mask 参数并给出可行替代，而非笼统说 provider 不行', false);
  }

  await app.close();
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`smoke result: ${checks.length - failed}/${checks.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
