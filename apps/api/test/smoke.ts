import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { TokenService } from '../src/billing/token.service.js';
import { PrismaService } from '../src/prisma/prisma.module.js';

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

  const myDup = await request(base, '/api/products/mine', { ...auth0, method: 'POST', body: JSON.stringify({ name: '冒烟自定义产品', category: 'switch' }) });
  check('我的库重名被拒（应用层查重）', myDup.status === 400);

  const badCat = await request(base, '/api/products/mine', { ...auth0, method: 'POST', body: JSON.stringify({ name: '非法品类产品', category: 'not-a-cat' }) });
  check('非法品类被校验拒绝', badCat.status === 400);

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
  const authA = { headers: { Authorization: `Bearer ${regA.body.token}` } };

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
  check(
    '全库备份导出（tables 完整）',
    backupRes.status === 200 && Boolean(backupJson?.exportedAt) && Array.isArray(backupJson?.tables?.user) && (backupJson?.tables?.user?.length ?? 0) >= 2,
  );

  const storageRes = await request<{ usedBytes: number; quotaBytes: number; assets: number }>(base, '/api/admin/storage', authA);
  check('存储占用统计可查', storageRes.status === 200 && storageRes.body.quotaBytes > 0);

  const cleanupRes = await request<{ deleted: number; freedBytes: number }>(base, '/api/admin/storage/cleanup?beforeDays=3650', { ...authA, method: 'POST' });
  check('产物清理端点可用（0 天阈值不误删）', [200, 201].includes(cleanupRes.status) && typeof cleanupRes.body?.deleted === 'number');

  // ---------- 接单工作台：CRUD + 状态机（不触发真实 LLM intake） ----------
  const orderCreate = await request<{ id: string; status: string }>(base, '/api/orders', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ customer: '冒烟客户', community: '测试小区', area: '120', layout: '三室两厅', budget: '3万', ecosystem: '米家', needs: '灯光、窗帘' }),
  });
  check('创建接待线索（status=new）', orderCreate.status === 201 && orderCreate.body.status === 'new');
  const orderId = orderCreate.body.id;

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
  const viewerOrders = await request(base, '/api/orders', { headers: { Authorization: `Bearer ${regA.body.token}` } });
  check('viewer 访问接单被拒（403）', viewerOrders.status === 403);

  // tenant_admin 默认可访问接单（order:manage）
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: (await prisma.role.findUniqueOrThrow({ where: { key: 'tenant_admin' } })).id } });
  const taOrders = await request(base, '/api/orders', { headers: { Authorization: `Bearer ${regA.body.token}` } });
  check('tenant_admin 可访问接单（200）', taOrders.status === 200);

  // viewer 角色不可访问备份/存储（RBAC 隔离）
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: viewerRole.id } });
  const backupForbidden = await request(base, '/api/admin/backup', { headers: { Authorization: `Bearer ${regA.body.token}` } });
  check('viewer 访问备份被拒（403）', backupForbidden.status === 403);
  await prisma.membership.update({ where: { id: memberA.id }, data: { roleId: originalRoleId } });

  await app.close();
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`smoke result: ${checks.length - failed}/${checks.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
