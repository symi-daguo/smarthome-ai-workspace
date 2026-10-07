import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { TokenService } from '../src/billing/token.service.js';

const checks: [string, boolean][] = [];

function check(name: string, ok: boolean): void {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

const randomPhone = (): string => `13${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`;

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

  const dup = await request(base, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ phone: phoneA, password: 'Test@12345', displayName: '重复' }),
  });
  check('重复手机号注册被拒绝', dup.status === 409);

  const me = await request<{ memberships: { tenantId: string }[] }>(base, '/api/auth/me', {
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

  await app.close();
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`smoke result: ${checks.length - failed}/${checks.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
