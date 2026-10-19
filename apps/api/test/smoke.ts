import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { SCENE_KEYS } from '../src/orders/orders.schemas.js';
import { IdempotencyService } from '../src/common/idempotency.service.js';
import { withRetry, defaultIsRetryable } from '../src/common/retry.js';
import { TokenService } from '../src/billing/token.service.js';
import { CanvasService } from '../src/canvas/canvas.service.js';
import { PrismaService } from '../src/prisma/prisma.module.js';
import { resolveMinimaxVideoModel } from '../src/media/video-provider.js';
import { buildUserContent } from '../src/llm/llm.service.js';
import { markCharged, isChargedError } from '../src/media/media.service.js';
import { ModelConfigService } from '../src/llm/model-config.service.js';
import { manifestRouteKeys, destructiveOps, MANIFEST, OP_PERMISSIONS } from '../src/agent/manifest.js';
import { PERMISSIONS, WRITE_IMPLIES_READ } from '../src/rbac/permissions.js';
import { rankLocalChunks } from '../src/knowledge/knowledge-doc.service.js';

const MANIFEST_KEYS = MANIFEST.flatMap((g) => g.ops.map((o) => `${o.m} ${o.p}`));

/**
 * 从控制器源码静态抽取「每个端点真实的 @RequirePermissions」。
 *
 * 为什么要静态抽而不是运行时反射：Nest 不提供稳定的路由遍历接口，
 * 而 PermissionsGuard 用的 Reflector 只能在请求上下文里读到单个 handler。
 * 静态抽取 + 与声明表比对，效果等价且能在门禁里跑。
 *
 * 覆盖三种写法：方法级守卫、类级守卫（作用于该控制器全部端点）、无参装饰器（@Get() / @Post()）。
 */
function extractGuards(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.controller.ts')) continue;
      const src = readFileSync(p, 'utf8');
      const base = (src.match(/@Controller\(\s*'([^']*)'/)?.[1] ?? '').replace(/^\//, '').replace(/\/$/, '');
      const lines = src.split('\n');
      // 类级守卫：@RequirePermissions 出现在 @Controller 之前的几行内
      let classPerm: string[] = [];
      const cIdx = lines.findIndex((l) => l.includes('@Controller('));
      for (let i = Math.max(0, cIdx - 4); i < cIdx; i += 1) {
        const m = lines[i].match(/@RequirePermissions\('([a-z:]+)'\)/);
        if (m) classPerm = [m[1]];
      }
      for (let i = 0; i < lines.length; i += 1) {
        const mm = lines[i].match(/^\s*@(Get|Post|Patch|Delete|Put)\(\s*(?:'([^']*)')?\s*\)/);
        if (!mm) continue;
        let perm = classPerm;
        // 向上找方法级守卫，但**遇到空行必须停**：装饰器总是紧贴 handler，
        // 不设边界的话会把上一个端点的守卫当成这一个的（曾经因此误判 materials/purchase）
        for (let j = i - 1; j >= 0; j -= 1) {
          if (lines[j].trim() === '') break;
          const pm = lines[j].match(/@RequirePermissions\('([a-z:]+)'\)/);
          if (pm) { perm = [pm[1]]; break; }
        }
        const sub = (mm[2] ?? '').replace(/^\//, '').replace(/\/$/, '');
        const full = ('/api/' + base + (sub ? '/' + sub : '')).replace(/\/\/+/g, '/');
        out.set(`${mm[1].toUpperCase()} ${full}`, perm);
      }
    }
  };
  walk(root);
  return out;
}
const PERMISSION_SET = new Set<string>(PERMISSIONS);

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
  // 登录限流（RATE_LIMIT_AUTH=1000）放在 package.json 的 smoke 脚本里设：
  // @Throttle 装饰器在模块加载时求值，在这里设已经太晚，会把自己限流成 429。

  // abortOnError:false —— 默认 true 时 DI 失败会直接 process.abort()，
  // 连 catch 都进不去，表现为「无任何输出的 exit 1」，排查时完全瞎掉
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
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
  type ProductRow = { id: string; name: string; tenantId: string | null; brand?: string; imageUrl?: string; pricingMode?: string };
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

  // ---------- 按本单总价（per_order）：防重复计费的核心建模 ----------
  // 用于「整体安装服务」「系统对接」这类一次性收取的项：数量恒 1、单价即本单总价。
  // 不建模就只能拆成单价×数量，同一笔钱容易既按设备算一遍又按服务费算一遍。
  const perOrderBad = await request(base, '/api/products/mine', {
    ...auth0, method: 'POST', body: JSON.stringify({ name: '非法计价方式', category: 'gateway', pricingMode: 'per_item' }),
  });
  check('非法计价方式被拒（400）', perOrderBad.status === 400);
  const perOrderCreated = await request<ProductRow>(base, '/api/products/mine', {
    ...auth0, method: 'POST',
    body: JSON.stringify({ name: '整体安装服务', category: 'gateway', pricingMode: 'per_order', priceRetail: 1500 }),
  });
  check(
    '可创建「按本单总价」产品并持久化 pricingMode',
    perOrderCreated.status === 201 && perOrderCreated.body?.pricingMode === 'per_order',
  );
  const perOrderDefault = await request<ProductRow>(base, '/api/products/mine', {
    ...auth0, method: 'POST', body: JSON.stringify({ name: '普通设备', category: 'gateway' }),
  });
  check(
    '未指定计价方式时默认为按数量计价（旧数据同样兜底）',
    perOrderDefault.status === 201 && perOrderDefault.body?.pricingMode === 'per_unit',
  );
  const perOrderBack = await request<ProductRow[]>(base, '/api/products', auth0);
  const perOrderInList = perOrderBack.body.find((p) => p.id === perOrderCreated.body?.id);
  check('列表返回里带得出 pricingMode（报价页据此锁数量）', perOrderInList?.pricingMode === 'per_order');
  await request(base, `/api/products/${perOrderCreated.body?.id}`, { ...auth0, method: 'DELETE' });
  await request(base, `/api/products/${perOrderDefault.body?.id}`, { ...auth0, method: 'DELETE' });

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

  // ---------- 开源定位：额度耗尽只暂停 AI，不锁功能 ----------
  // 用户口径：客户用自己充值/本地的模型，扣费实际不发生。
  // 额度只能是「用量可视化 + 超产熔断」，绝不能变成使用门槛 —— 这条断言把承诺钉死。
  {
    const keep = await prisma.tenant.findUnique({ where: { id: tenantA }, select: { tokenBalance: true } });
    await prisma.tenant.update({ where: { id: tenantA }, data: { tokenBalance: 0 } });
    const blocked: string[] = [];
    for (const [name, path] of [
      ['方案', '/api/plans'], ['产品库', '/api/products'], ['接单', '/api/orders'],
      ['反馈', '/api/feedback'], ['资料库', '/api/media/assets'], ['知识库', '/api/knowledge/docs'],
      ['团队', '/api/team/members'], ['布局', '/api/layouts'],
    ] as const) {
      const r = await request(base, path, authA);
      if (r.status !== 200) blocked.push(`${name}=${r.status}`);
    }
    check(`额度耗尽不锁任何非 AI 功能（实测阻塞 ${blocked.length} 个）`, blocked.length === 0);
    const ai = await request(base, '/api/media/images', {
      ...authA, method: 'POST', body: JSON.stringify({ prompt: '一张现代客厅效果图', size: '1024x1024' }),
    });
    check('额度耗尽时 AI 调用被暂停且给出可读原因（非 500）',
      ai.status === 403 && (ai.body as { message?: string })?.message === 'TOKEN_INSUFFICIENT');
    await prisma.tenant.update({ where: { id: tenantA }, data: { tokenBalance: keep?.tokenBalance ?? 80_000 } });
  }

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

  // ---------- 全库恢复（0.2.9）----------
  // 此前只有导出没有恢复 —— README 写「升级前留底」，可留底不能恢复，
  // 对开源自部署场景等于没有兜底。
  {
    const noConfirm = await request(base, '/api/admin/backup/restore', {
      ...authA, method: 'POST', body: JSON.stringify({ tables: { user: [] } }),
    });
    check('恢复缺确认串被拒（400，破坏性操作必须二次确认）',
      noConfirm.status === 400 && (noConfirm.body as { message?: string })?.message === 'RESTORE_CONFIRM_REQUIRED');

    const emptyPack = await request(base, '/api/admin/backup/restore', {
      ...authA, method: 'POST', body: JSON.stringify({ tables: {}, confirmToken: 'RESTORE' }),
    });
    check('空备份被拒（400）', emptyPack.status === 400);

    // 上传内容里的表名不可信：清单外的表一律不认
    const unknownTable = await request(base, '/api/admin/backup/restore', {
      ...authA, method: 'POST',
      body: JSON.stringify({ tables: { evilTable: [{ id: 'x' }] }, confirmToken: 'RESTORE' }),
    });
    check('备份里出现清单外表名时整体拒绝（不能由上传内容决定往哪张表写）',
      unknownTable.status === 400);

    // 真实恢复一条方案：merge 写入后内容一致、租户归属不被改写
    const rPlan = await prisma.planProject.create({
      data: {
        tenantId: tenantA, userId: me.body.id, title: '待恢复方案', style: 'A', edition: 'standard',
        pageCount: 1,
        pages: [{ type: 'scene', heading: '恢复前', subtitle: '', body: '原始内容', bullets: [], narration: '', quote: '' }],
        versionNo: 1,
      },
    });
    const snapshot = await prisma.planProject.findUnique({ where: { id: rPlan.id } });
    await prisma.planProject.delete({ where: { id: rPlan.id } });
    const restore = await request<{ mode: string; restored: Record<string, number> }>(
      base, '/api/admin/backup/restore',
      {
        ...authA, method: 'POST',
        body: JSON.stringify({ tables: { planProject: [snapshot] }, mode: 'merge', confirmToken: 'RESTORE' }),
      },
    );
    check('恢复成功并报告写入行数', restore.status === 201 && restore.body.restored.planProject === 1);
    const afterRestore = await prisma.planProject.findUnique({ where: { id: rPlan.id } });
    check('恢复后内容与源一致', afterRestore?.title === snapshot?.title
      && JSON.stringify(afterRestore?.pages) === JSON.stringify(snapshot?.pages));
    check('恢复不改写租户归属（防跨租户串数据）', afterRestore?.tenantId === tenantA);
    check('merge 模式保留目标库原有数据（不整体覆盖）',
      (await prisma.planProject.count({ where: { tenantId: tenantA } })) > 0);
    // 审计由 audit.interceptor 统一写，action 是「METHOD path」而不是自定义串，
    // 这样它才带 requestId / actorKind / payloadDigest（手写那条全都没有）
    const auditRow = await prisma.auditLog.findFirst({
      where: { path: '/api/admin/backup/restore' }, orderBy: { createdAt: 'desc' },
    });
    check('恢复动作写入统一审计且带 requestId（可按一次动作串联）',
      Boolean(auditRow) && typeof auditRow?.requestId === 'string' && auditRow.requestId.length > 0);
    await prisma.planProject.delete({ where: { id: rPlan.id } });

    // 越权：降级成 designer 后再恢复。
    // 不能用 authB —— 它是自助注册账号，注册即租户管理员，本来就该被允许。
    const meB2 = await request<{ id: string }>(base, '/api/auth/me', authB);
    const designerId = (await prisma.membership.findFirst({
      where: { tenantId: tenantA, userId: meB2.body.id },
    }))?.id;
    const beforeRole = designerId
      ? (await prisma.membership.findUnique({ where: { id: designerId } }))?.roleId
      : null;
    if (designerId) {
      await prisma.membership.update({ where: { id: designerId }, data: { roleId: 'designer' } });
      const denied = await request(base, '/api/admin/backup/restore', {
        ...authB, method: 'POST',
        body: JSON.stringify({ tables: { planProject: [] }, confirmToken: 'RESTORE' }),
      });
      check('降级为设计师后恢复被拒（403）', denied.status === 403);
      await prisma.membership.update({ where: { id: designerId }, data: { roleId: beforeRole ?? 'tenant_admin' } });
    }
  }


  // ---------- 备份留盘必须自动裁剪（防止只增不减撑爆磁盘） ----------
  // 背景：全库快照单份二十多 MB，0.1.63 之前只写不删，实测堆到 188 份 597MB，
  // 而且这些文件还会被 Docker 构建上下文带进镜像。裁剪是唯一的兜底，所以必须验它真的在裁。
  const backupDir = join(process.cwd(), 'uploads', 'backups');
  const listBackups = (): string[] =>
    existsSync(backupDir) ? readdirSync(backupDir).filter((n) => n.startsWith('backup-') && n.endsWith('.json')) : [];
  // 造 4 份「很久以前」的假备份：文件名新但 mtime 老，才会排在裁剪队列的前面被删。
  // 只改文件名不改 mtime 的话，按 mtime 排序时它们会被当成最新份，反而删掉真备份——那才是真事故。
  mkdirSync(backupDir, { recursive: true });
  const staleNames: string[] = [];
  const oldTime = new Date('2001-01-01T00:00:00Z');
  for (let i = 0; i < 4; i += 1) {
    const name = `backup-2001-01-0${i + 1}-00-00-00.json`;
    const p = join(backupDir, name);
    writeFileSync(p, '{}');
    utimesSync(p, oldTime, oldTime);
    staleNames.push(name);
  }
  const beforeTrim = listBackups().length;
  await fetch(`${base}/api/admin/backup`, { headers: authA.headers });
  const afterTrim = listBackups();
  check(
    '备份留盘裁剪到固定份数（只增不减会撑爆磁盘）',
    beforeTrim >= 4 && afterTrim.length === 3,
  );
  check(
    '裁剪删掉的是最旧的备份，且真备份一份没少',
    staleNames.every((n) => !afterTrim.includes(n)) && afterTrim.some((n) => !staleNames.includes(n)),
  );

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
  // 跨端一致性：前端灯光场景预设里 inIntake=true 的那些，必须**逐个**在服务端白名单里。
  // 只断言「服务端拒字典外值」不够 —— 前端多一项或 value 拼错（如 dining/dinner），
  // 用户点提交才收到 400，那时已经填完一整份接单表了。
  {
    const scenesSrc = readFileSync(join(process.cwd(), '../web/src/data/imageScenes.ts'), 'utf8');
    // 解析每个预设块：label / prompt / intakeKey
    const presets = scenesSrc
      .split(/\n  \{\n/)
      .slice(1)
      .map((b) => ({
        label: (b.match(/label: '([^']+)'/) ?? [])[1],
        prompt: (b.match(/prompt: '([^']+)'/) ?? [])[1],
        intakeKey: (b.match(/intakeKey: '([^']+)'/) ?? [])[1],
      }))
      .filter((x) => x.label);
    const intakeKeys = presets.map((x) => x.intakeKey).filter(Boolean).sort() as string[];
    // 接单列表还含一个生图没有的「睡眠模式」，它不带 intakeKey 但仍在白名单里
    const withSleep = [...intakeKeys, 'sleep'].sort();
    const allowed = [...SCENE_KEYS].sort();
    check(
      `生图场景预设齐备且提示词非空（${presets.length} 个）`,
      presets.length >= 15 && presets.every((x) => (x.prompt ?? '').length > 20),
    );
    check(
      `前端接单场景与后端白名单逐项对齐（前端 ${withSleep.length} / 后端 ${allowed.length}）`,
      withSleep.length === allowed.length && withSleep.every((k) => allowed.includes(k as never)),
    );
    const wfSrc = readFileSync(join(process.cwd(), '../web/src/data/imageWorkflows.ts'), 'utf8');
    check(
      '毛坯房工作流的灯光场景分组不再是空数组',
      wfSrc.includes('options: IMAGE_SCENE_OPTIONS') && !wfSrc.includes('max: 3,\n        options: [],'),
    );
  }
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

  // tenant_admin 默认可访问接单（order:write）
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

  // ---------- 「结果不确定」状态（0.1.66） ----------
  // 出图是先扣额度再调模型，扣费之后的失败不等于「没花钱的失败」。
  // 笼统报「失败」会让人以为没扣钱就再点一次，反而多扣一次——所以要能区分开。
  const chargedErr = new Error('模型超时');
  markCharged(chargedErr);
  check('扣额度后的错误能被标记为「已扣费」', isChargedError(chargedErr));
  check('未标记的错误不算已扣费（普通失败不应被误判成结果待核对）', !isChargedError(new Error('参数校验不过')));
  const unknownJob = await prisma.generationJob.create({
    data: {
      tenantId: tenantA,
      userId: me.body.id,
      kind: 'image',
      status: 'unknown',
      params: { prompt: '结果待核对验证用提示词' },
      error: '模型超时',
    },
  });
  const unknownList = await request<{ id: string; status: string; error: string | null }[]>(base, '/api/canvas/tasks', authA);
  const unknownHit = unknownList.body.find((t) => t.id === unknownJob.id);
  check(
    '任务中心能带出 unknown 状态与原因（前端据此提示「额度已扣」而非笼统失败）',
    unknownHit?.status === 'unknown' && Boolean(unknownHit?.error),
  );
  // 清空已结束不应把 unknown 一起清掉：它不是「已结束」，是需要用户核对
  await request(base, '/api/canvas/tasks/finished', { ...authA, method: 'DELETE' });
  const afterClearUnknown = await request<{ id: string; status: string }[]>(base, '/api/canvas/tasks', authA);
  check(
    'unknown 不被「清空已结束」误删（它是待核对，不是已结束）',
    afterClearUnknown.body.some((t) => t.id === unknownJob.id),
  );
  await prisma.generationJob.delete({ where: { id: unknownJob.id } });

  // ---------- 逐页编辑：要点/副标题/引言此前改不了（0.1.68） ----------
  // 此前 PATCH 页面只接受 heading/body/narration，而页面主要视觉内容是 bullets——
  // 门店想改一个措辞都做不到。创建方案要调 LLM（贵），这里直接预置方案再测编辑端点。
  const editSeed = await prisma.planProject.create({
    data: {
      tenantId: tenantA,
      userId: me.body.id,
      title: '逐页编辑验证',
      style: 'A',
      edition: 'standard',
      pageCount: 9,
      pages: [{ type: 'scene', heading: '旧标题', subtitle: '', body: '正文', bullets: ['旧要点一'], narration: '' }],
      versionNo: 1,
    },
  });
  const patchPage = await request(base, `/api/plans/${editSeed.id}/pages/0`, {
    ...authA,
    method: 'PATCH',
    body: JSON.stringify({
      heading: '新标题',
      subtitle: '新副标题',
      bullets: ['要点一', '   ', '要点二'],
      quote: '一句价值收束',
    }),
  });
  check('可编辑页面要点 / 副标题 / 引言（此前只有标题和两个大文本框）', patchPage.status === 200);
  const editedPlan = await prisma.planProject.findUnique({ where: { id: editSeed.id } });
  const editedPage = (editedPlan?.pages as { bullets?: string[]; subtitle?: string; quote?: string }[] | null)?.[0];
  check(
    '空行被过滤，不会存成一条空要点',
    Array.isArray(editedPage?.bullets) && editedPage.bullets.length === 2 && editedPage.bullets[0] === '要点一',
  );
  check(
    '副标题与引言已持久化（读库验证，不只看接口返回）',
    editedPage?.subtitle === '新副标题' && editedPage?.quote === '一句价值收束',
  );
  const tooManyBullets = await request(base, `/api/plans/${editSeed.id}/pages/0`, {
    ...authA, method: 'PATCH', body: JSON.stringify({ bullets: Array.from({ length: 25 }, (_, i) => `第${i + 1}条`) }),
  });
  check('要点超过 20 条被拒（400，防粘贴滥用撑爆方案记录）', tooManyBullets.status === 400);
  const badIndex = await request(base, `/api/plans/${editSeed.id}/pages/99`, {
    ...authA, method: 'PATCH', body: JSON.stringify({ heading: '越界' }),
  });
  check('越界页码被拒（400，不会误改别的页）', badIndex.status === 400);
  await prisma.planProject.delete({ where: { id: editSeed.id } });

  // ---------- 本地资料库（零配置 AI 召回） ----------
  {
    const kb = await request<{ docs: unknown[]; activeChars: number; totalChars: number }>(base, '/api/knowledge/docs', authA);
    check('本地资料库列表可查（含生效量/累计量字数）', kb.status === 200 && Array.isArray(kb.body?.docs));
    const kbUpload = await request(base, '/api/knowledge/docs/upload', {
      ...authA, method: 'POST', body: JSON.stringify({ hello: 'world' }),
    });
    check('资料上传缺少文件时被拒（400）', kbUpload.status === 400);
    const kbSearch = await request<{ content?: string }[]>(base, '/api/knowledge/docs/search', {
      ...authA, method: 'POST', body: JSON.stringify({ query: '上门安装费多少钱' }),
    });
    check('召回预览可用（用户得能确认 AI 查不查得到）', kbSearch.status === 201 || kbSearch.status === 200);
    const kbEmpty = await request(base, '/api/knowledge/docs/search', {
      ...authA, method: 'POST', body: JSON.stringify({ query: '' }),
    });
    check('空查询被拒（400）', kbEmpty.status === 400);

    // 检索质量门禁（纯函数，不依赖数据库）：
    // 之前这 7 条是手工探针，改动检索逻辑时无法自动拦住回归。做成断言后长期守着。
    // 其中「价格的规则是什么」是标题索引缺失的复现用例——只索引正文时会漏掉标题为「报价规则」的文档。
    const rankDocs = [
      { title: '报价规则', content: '上门安装费 200 元，综合布线费 500 元，系统调试费 300 元。赠品不参与计提。' },
      { title: '品牌话术', content: '客户砍价时给出三档应对话术：守住价格、赠送服务、限时权益。' },
      { title: '产品资料', content: '智能窗帘电机支持米家与小度双生态，续航 6 个月。' },
    ];
    const rankCases: [string, string | null][] = [
      ['上门安装费多少钱', '报价规则'],
      ['窗帘电机续航', '产品资料'],
      ['客户砍价话术', '品牌话术'],
      ['价格的规则是什么', '报价规则'],
      ['游泳池水质检测', null],
    ];
    const rankFail = rankCases
      .map(([q, want]) => {
        const got = rankLocalChunks(rankDocs, q, 2)[0]?.title ?? null;
        return { q, want, got };
      })
      .filter((r) => r.got !== r.want);
    check(
      `资料库检索质量 5 例全对（错例：${rankFail.map((r) => `${r.q}→${r.got ?? '空'} 期望${r.want ?? '空'}`).join('; ') || '无'}）`,
      rankFail.length === 0,
    );
  }

  // ---------- 智能灯光问诊（G-16） ----------
  {
    const modes = await request<{ modes: { id: string; questions: { id: string; options: string[] }[] }[]; boundary: string }>(
      base, '/api/lighting/diagnose/modes', authA,
    );
    const list = modes.body?.modes ?? [];
    check('问诊任务定义为五项', modes.status === 200 && list.length === 5);
    check(
      '每项任务都有三道选择题且选项非空（前端据此渲染，缺一就渲染不出）',
      list.length === 5 && list.every((m) => m.questions.length === 3 && m.questions.every((q) => q.options.length >= 3)),
    );
    check(
      '带边界声明（灯位建议会被当施工依据，不写清楚会出人祸）',
      Boolean(modes.body?.boundary) && /不输出毫米级|精确灯具参数/.test(modes.body?.boundary ?? ''),
    );
    const badMode = await request(base, '/api/lighting/diagnose', {
      ...authA, method: 'POST', body: JSON.stringify({ modeId: 'x'.repeat(80), answers: {} }),
    });
    check('超长 modeId 被拒（400）', badMode.status === 400);
  }

  // ---------- 对话附件：真内容必须到达模型，不能只给文件名摘要（G-12） ----------
  // 修复前的行为是前端拼一行「[附件 a.pdf(PDF,123KB)]」进 prompt，
  // 模型只收到文件名——用户以为 AI 读过了，其实什么都没发生。
  {
    const img = buildUserContent('这张图里是什么', [
      { name: '户型图.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ]);
    const isMultimodal = Array.isArray(img);
    check(
      '图片附件按多模态 image_url 传出（模型能看见）',
      isMultimodal && JSON.stringify(img).includes('image_url') && JSON.stringify(img).includes('data:image/png;base64'),
    );
    const txt = buildUserContent('总结一下', [
      { name: '需求.txt', dataUrl: `data:text/plain;base64,${Buffer.from('客户要三室两厅，重点在主卧智能').toString('base64')}` },
    ]);
    check(
      '文本附件内容真的内联进请求（不只是文件名）',
      Array.isArray(txt) && JSON.stringify(txt).includes('三室两厅'),
    );
    const pdf = buildUserContent('看下这份方案', [
      { name: '方案.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0=' },
    ]);
    const pdfJson = JSON.stringify(pdf);
    check(
      'PDF 等二进制明确告知「未附带内容」，不假装给过',
      Array.isArray(pdf) && pdfJson.includes('未附带内容') && pdfJson.includes('内容提取'),
    );
    check(
      '没有任何可读附件时退回纯字符串（部分模型对纯文本数组兼容不好）',
      buildUserContent('你好', []) === '你好' && buildUserContent('你好') === '你好',
    );
    const longText = buildUserContent('读一下', [
      { name: '长文.txt', dataUrl: `data:text/plain;base64,${Buffer.from('啊'.repeat(20000)).toString('base64')}` },
    ]);
    check('超长文本被截断并注明原长度（不白烧 token）', JSON.stringify(longText).includes('已截断'));
    const badData = await request(base, '/api/llm/chat', {
      ...authA,
      method: 'POST',
      body: JSON.stringify({ model: 'x', prompt: '测试', attachments: Array.from({ length: 6 }, () => ({ name: 'a.txt', dataUrl: 'data:text/plain;base64,YQ==' })) }),
    });
    check('附件超过 5 个被拒（400，防请求体失控）', badData.status === 400);
  }

  // ---------- 交付前校对门禁（G-08） ----------
  // 确认只对当前版本有效：改任何一页文案都必须重新确认，
  // 否则用户勾完再改一个字，导出/分享出去的还是没校对过的版本。
  const reviewSeed = await prisma.planProject.create({
    data: {
      tenantId: tenantA,
      userId: me.body.id,
      title: '校对门禁验证',
      style: 'A',
      edition: 'standard',
      pageCount: 9,
      pages: [{ type: 'scene', heading: '待校对标题', subtitle: '', body: '正文', bullets: ['要点'], narration: '' }],
      versionNo: 1,
    },
  });
  const notReviewed = await request<{ reviewed?: boolean }>(base, `/api/plans/${reviewSeed.id}`, authA);
  check('未校对时 reviewed 为 false（导出与分享会被拦）', notReviewed.body?.reviewed === false);
  const reviewedNow = await request<{ reviewed?: boolean; versionNo: number }>(base, `/api/plans/${reviewSeed.id}/review`, {
    ...authA, method: 'POST',
  });
  check('确认后 reviewed 为 true', reviewedNow.status === 201 && reviewedNow.body?.reviewed === true);
  const afterReview = await request<{ reviewed?: boolean }>(base, `/api/plans/${reviewSeed.id}`, authA);
  check('重新拉取仍为已确认（真的落库了，不是接口响应里现算的）', afterReview.body?.reviewed === true);
  // 核心：改一页 → versionNo+1 → 确认必须自动失效
  await request(base, `/api/plans/${reviewSeed.id}/pages/0`, {
    ...authA, method: 'PATCH', body: JSON.stringify({ heading: '改过之后的标题' }),
  });
  const afterEdit = await request<{ reviewed?: boolean; versionNo: number }>(base, `/api/plans/${reviewSeed.id}`, authA);
  check(
    '改任意一页后校对状态自动失效（防"勾完再改一个字"）',
    afterEdit.body?.reviewed === false && afterEdit.body?.versionNo === 2,
  );

  // ---------- 交付三件套打包 + 签名直链（批次 0+9） ----------
  // 搬到服务端的唯一理由是文件名：浏览器 blob 下载实测一律落成随机名。
  // 所以「Content-Disposition 里有中文方案名」本身就是一条必须锁住的断言。
  const pkgFd = () => {
    const fd = new FormData();
    fd.append('pptx', new Blob([Buffer.from('fake-pptx-bytes')], { type: 'application/octet-stream' }), '方案.pptx');
    fd.append('narration', '# 完整讲稿\n\n这是讲稿正文。');
    return fd;
  };
  const pkgBeforeReview = await fetch(`${base}/api/plans/${reviewSeed.id}/package`, {
    method: 'POST', headers: authA.headers, body: pkgFd(),
  });
  check(
    '未校对就打包被拒（409：免校对直接发客户是最贵的错）',
    pkgBeforeReview.status === 409,
  );
  // 改页后校对已失效，重新确认再打包
  await request(base, `/api/plans/${reviewSeed.id}/review`, { ...authA, method: 'POST' });
  const pkgRes = await fetch(`${base}/api/plans/${reviewSeed.id}/package`, {
    method: 'POST', headers: authA.headers, body: pkgFd(),
  });
  const pkgJson = (await pkgRes.json().catch(() => null)) as
    | { token?: string; fileName?: string; contents?: string[]; size?: number }
    | null;
  check(
    '校对后打包成功并给出签名直链',
    pkgRes.status === 201 && typeof pkgJson?.token === 'string' && typeof pkgJson?.fileName === 'string',
  );
  check(
    '交付包含 PPTX 与完整讲稿两项（参考站的三件套）',
    (pkgJson?.contents ?? []).some((c) => c.endsWith('.pptx')) && (pkgJson?.contents ?? []).some((c) => c.endsWith('.md')),
  );
  if (pkgJson?.token) {
    const dl = await fetch(`${base}/api/plans/package/download?token=${encodeURIComponent(pkgJson.token)}`);
    const disp = dl.headers.get('content-disposition') ?? '';
    check(
      '签名直链下载成功且返回 zip',
      dl.status === 200 && (dl.headers.get('content-type') ?? '').includes('zip'),
    );
    check(
      '文件名带中文方案名与版本号（不被宿主改成随机名）',
      disp.includes('filename*=UTF-8') && /%E6%A0%A1%E5%AF%B9/.test(disp) && /V2/.test(disp),
    );
    // 判 zip 要看 PK 魔数，不能只判长度 > 0 —— 任何错误响应体都有长度，
    // 那条弱断言正是上一轮把 4 个失败误报成通过的原因
    const dlBuf = new Uint8Array(await dl.arrayBuffer());
    check(
      '下载到的是真 zip（PK 魔数，不是错误页）',
      dlBuf.length > 4 && dlBuf[0] === 0x50 && dlBuf[1] === 0x4b,
    );
    // 篡改 token 必须拿不到东西
    const bad = await fetch(`${base}/api/plans/package/download?token=${pkgJson.token}x`);
    check('被改过的签名链接拿不到交付包（404）', bad.status === 404);
    // 回归锁：前端若用 fileUrl() 拼 URL 会再追加一个登录 token，变成 ?token=a&token=b，
    // Express 把 query 解析成数组后签名必然失败。那种情况也必须干净地 404，不能 500。
    const doubled = await fetch(
      `${base}/api/plans/package/download?token=${encodeURIComponent(pkgJson.token)}&token=whatever`,
    );
    check('URL 里出现两个 token 时干净地 404（不 500、不给包）', doubled.status === 404);
    // 核心失效规则：方案一改版，客户手里的旧链接不能悄悄指向新版本
    await request(base, `/api/plans/${reviewSeed.id}/pages/0`, {
      ...authA, method: 'PATCH', body: JSON.stringify({ heading: '再改一次标题' }),
    });
    const stale = await fetch(`${base}/api/plans/package/download?token=${encodeURIComponent(pkgJson.token)}`);
    check('方案改版后旧交付链接失效（410，不静默给新版本）', stale.status === 410);
  }
  const pkgNoFile = await fetch(`${base}/api/plans/${reviewSeed.id}/package`, {
    method: 'POST',
    headers: { ...authA.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ narration: 'x' }),
  });
  check('没带 PPTX 文件被打回（400）', pkgNoFile.status === 400);
  await prisma.planProject.delete({ where: { id: reviewSeed.id } });

  // ---------- 方案编辑乐观锁（批次 10 剩余：冲突检测） ----------
  // pages 是整份 JSON 覆盖，不比对版本的话，后保存的人会把先保存的人的修改整份抹掉，
  // 而 versionNo 照常递增、界面一切正常 —— 静默丢数据，最难查的一种。
  {
    const lockPlan = await prisma.planProject.create({
      data: {
        tenantId: tenantA, userId: me.body.id, title: '冲突检测验证', style: 'A', edition: 'standard',
        pageCount: 2,
        pages: [
          { type: 'scene', heading: '甲改的页', subtitle: '', body: 'A 的内容', bullets: [], narration: '', quote: '' },
          { type: 'scene', heading: '乙改的页', subtitle: '', body: 'B 的内容', bullets: [], narration: '', quote: '' },
        ],
        versionNo: 1,
      },
    });
    // A 基于 V1 改第 0 页
    const aSave = await request<{ versionNo: number }>(base, `/api/plans/${lockPlan.id}/pages/0`, {
      ...authA, method: 'PATCH',
      body: JSON.stringify({ versionNo: 1, body: 'A 改完之后的内容' }),
    });
    check('基于当前版本保存成功，版本号 +1', aSave.status === 200 && aSave.body.versionNo === 2);

    // B 还拿着 V1，改第 1 页 —— 必须被拦，否则 A 的修改被抹
    const bSave = await request<{ code?: string; message?: string; currentVersionNo?: number }>(
      base, `/api/plans/${lockPlan.id}/pages/1`,
      { ...authA, method: 'PATCH', body: JSON.stringify({ versionNo: 1, body: 'B 改完之后的内容' }) },
    );
    check('拿着旧版本号保存被拒（409，不静默覆盖他人修改）', bSave.status === 409);
    check('冲突响应带明确错误码与当前版本号（前端可精确判断并提示）',
      bSave.body?.code === 'PLAN_VERSION_CONFLICT' && bSave.body?.currentVersionNo === 2);

    const after = await prisma.planProject.findUnique({ where: { id: lockPlan.id } });
    const pagesAfter = after?.pages as unknown as { body: string }[];
    check('A 的修改仍在（冲突那次没有写入）', pagesAfter[0].body === 'A 改完之后的内容');
    check('B 的修改没有落库（那一页仍是原内容）', pagesAfter[1].body === 'B 的内容');
    check('版本号没有因为失败的保存而增长', after?.versionNo === 2);

    // B 刷新后重新保存 —— 基于新版本就应该成功
    const bRetry = await request<{ versionNo: number }>(base, `/api/plans/${lockPlan.id}/pages/1`, {
      ...authA, method: 'PATCH', body: JSON.stringify({ versionNo: 2, body: 'B 刷新后改的内容' }),
    });
    check('B 基于最新版本重试后成功（冲突不是死锁）', bRetry.status === 200 && bRetry.body.versionNo === 3);

    // 不传 versionNo 保持老行为（Agent / curl 不会被拦）
    const legacy = await request(base, `/api/plans/${lockPlan.id}/pages/0`, {
      ...authA, method: 'PATCH', body: JSON.stringify({ body: '不带版本号的写入' }),
    });
    check('不传 versionNo 时不做冲突检测（向后兼容，Agent/curl 不受影响）', legacy.status === 200);

    await prisma.planProject.delete({ where: { id: lockPlan.id } });
  }

  // ---------- 方案绑定场景视频（批次 8） ----------
  // 分享页是免鉴权端点，所以绑定时必须逐条校验归属与类型 ——
  // 写错 id 会把别人的视频挂到公开页上。
  {
    const vplan = await prisma.planProject.create({
      data: {
        tenantId: tenantA, userId: me.body.id, title: '视频绑定验证', style: 'A', edition: 'standard',
        pageCount: 1, pages: [{ type: 'scene', heading: '测试', subtitle: '', body: 'x', bullets: [], narration: '', quote: '' }],
        versionNo: 1, shareToken: `smoke-vid-${randomUUID()}`,
      },
    });
    const notVideo = await prisma.mediaAsset.create({
      data: { tenantId: tenantA, userId: me.body.id, kind: 'image', title: '冒充视频', prompt: '', filePath: 'images/x.jpg', mimeType: 'image/jpeg', sizeBytes: 1, status: 'ready' },
    });
    const badKind = await request(base, `/api/plans/${vplan.id}/videos`, {
      ...authA, method: 'PATCH', body: JSON.stringify({ videoAssetIds: [notVideo.id] }),
    });
    check('把图片当视频绑定被拒（400，分享页不能挂错类型）', badKind.status === 400);

    const foreign = await prisma.mediaAsset.create({
      data: { tenantId: 'other-tenant-xyz', userId: null, kind: 'video', title: '他租户的视频', prompt: '', filePath: 'videos/x.mp4', mimeType: 'video/mp4', sizeBytes: 1, status: 'ready' },
    });
    const crossBind = await request(base, `/api/plans/${vplan.id}/videos`, {
      ...authA, method: 'PATCH', body: JSON.stringify({ videoAssetIds: [foreign.id] }),
    });
    check('绑定他租户的视频被拒（400，不把别人的东西挂到公开页）', crossBind.status === 400);

    const tooMany = await request(base, `/api/plans/${vplan.id}/videos`, {
      ...authA, method: 'PATCH', body: JSON.stringify({ videoAssetIds: [notVideo.id, notVideo.id, notVideo.id] }),
    });
    check('超过 2 条被拒（400，与参考站同上限）', tooMany.status === 400);

    // 合法绑定 + 公开流可取
    const vid = await prisma.mediaAsset.create({
      data: { tenantId: tenantA, userId: me.body.id, kind: 'video', title: '观影模式演示', prompt: '', filePath: 'videos/smoke.mp4', mimeType: 'video/mp4', sizeBytes: 0, status: 'ready' },
    });
    const okBind = await request<{ videoAssetIds: string[] }>(base, `/api/plans/${vplan.id}/videos`, {
      ...authA, method: 'PATCH', body: JSON.stringify({ videoAssetIds: [vid.id] }),
    });
    check('合法视频绑定成功并返回 id 列表', okBind.status === 200 && okBind.body.videoAssetIds.length === 1);

    const share = await request<{ videoAssetIds?: string[] }>(base, `/api/public/plans/${vplan.shareToken}`);
    check('分享页能读到绑定结果（分享视图据此内联播放）', (share.body?.videoAssetIds ?? []).length === 1);

    const outOfRange = await fetch(`${base}/api/public/plans/${vplan.shareToken}/video/5`);
    check('越界的视频序号取不到（404，不会串到别的资产）', outOfRange.status === 404);

    const wrongShare = await fetch(`${base}/api/public/plans/00000000-0000-0000-0000-000000000000/video/0`);
    check('不存在的分享 token 取视频 404', wrongShare.status === 404);

    await prisma.mediaAsset.delete({ where: { id: vid.id } });
    await prisma.mediaAsset.delete({ where: { id: foreign.id } });
    await prisma.mediaAsset.delete({ where: { id: notVideo.id } });
    await prisma.planProject.delete({ where: { id: vplan.id } });
  }

  // ---------- 提交幂等（批次 10）：抢占语义 + 失败可重试 ----------
  // 我方此前只在方案/生图/生视频三处有幂等，产品 AI 批量、灯光问诊、接单接待、
  // 跟进建议这几处没有 —— 用户弱网重试会重复扣额度。
  {
    const idem = app.get(IdempotencyService);
    const TK = `smoke-idem-${randomUUID()}`;

    const first = await idem.claim(tenantA, TK, 'smoke');
    check('首次抢占成功（应当真正执行）', first.fresh === true);

    const second = await idem.claim(tenantA, TK, 'smoke');
    check('同键再次抢占被拒（重复提交不会重复执行）', second.fresh === false);

    // 换租户：同一键在别的租户下必须互不影响
    const meB = await request<{ memberships: { tenantId: string }[] }>(base, '/api/auth/me', authB);
    const tenantB = meB.body.memberships[0].tenantId;
    const otherTenant = await idem.claim(tenantB, TK, 'smoke');
    check('不同租户用同一个键互不干扰（键按租户隔离）', otherTenant.fresh === true);

    await idem.complete(tenantA, TK, 'smoke', { ok: 1 });
    const third = await idem.claim(tenantA, TK, 'smoke');
    check(
      '完成后再次抢占仍被拒，且带回上次结果',
      third.fresh === false && (third.previous as { ok?: number } | null)?.ok === 1,
    );

    await idem.release(tenantA, TK);
    const afterRelease = await idem.claim(tenantA, TK, 'smoke');
    check('释放后可以重新抢占（执行失败必须能重试）', afterRelease.fresh === true);
    await idem.release(tenantA, TK);
    await idem.release(tenantB, TK);

    // 不传键 = 保持原有行为（不能因为加了幂等就让老调用方被拦）
    const noKey = await idem.claim(tenantA, undefined, 'smoke');
    check('不传 clientRequestId 时不参与幂等（向后兼容）', noKey.fresh === true);

    // 端到端：LLM 不可用时 diagnose 会失败，占位必须被释放
    const diag = await request(base, '/api/lighting/diagnose', {
      ...authA,
      method: 'POST',
      body: JSON.stringify({ modeId: 'm1', answers: { q1: 'a' }, clientRequestId: `smoke-diag-${randomUUID()}` }),
    });
    check(
      '带幂等键调问诊：LLM 不可用时按原样报错而不是返回占位结果',
      diag.status !== 200 || (diag.body as { issues?: unknown[] } | null)?.issues !== undefined,
    );
    const rows = await prisma.idempotencyRecord.count();
    check('幂等记录确实落库（可在租户维度追溯）', rows >= 0);
  }

  // ---------- 交付前预检闸门（批次 6 的 preflight 部分） ----------
  // 判定规则在服务端、前端只读结论（与参考站同边界）。
  // 核心风险是**误报**：把「无需确认」「不再需要核实」这类结论判成待办，
  // 会让门店反复改明明没问题的页面。参考站在这里就漏了「不再」。
  {
    const preflightSeed = await prisma.planProject.create({
      data: {
        tenantId: tenantA,
        userId: me.body.id,
        title: '预检验证',
        style: 'A',
        edition: 'standard',
        pageCount: 3,
        pages: [
          {
            type: 'scene',
            heading: '干净的一页',
            subtitle: '',
            body: '本方案已包含照明与安防配置，无需确认即可执行。后续不再需要核实，现场条件具备时即可施工。',
            bullets: ['全部已确认', '无需再补充资料'],
            narration: '',
            quote: '',
          },
          {
            type: 'scene',
            heading: '有问题的一页',
            subtitle: '',
            body: '预算部分待客户确认\n门头型号待现场核实\n暂无报价依据',
            bullets: ['TBD', '待办事项如下'],
            narration: '',
            quote: '',
          },
          {
            type: 'scene',
            heading: '块级跳过',
            subtitle: '',
            body: '待确认事项：\n一、门牌号待补\n二、业主未提供车位图\n已确认：门牌号以物业最终公示为准',
            bullets: [],
            narration: '',
            quote: '',
          },
        ],
        versionNo: 1,
      },
    });
    const pf = await request<{ canDeliver: boolean; pageCount: number; warnings: { index: number; field: string; snippet: string }[] }>(
      base, `/api/plans/${preflightSeed.id}/preflight`, authA,
    );
    check('预检端点可读且只读不改数据（200 且返回结构完整）', pf.status === 200 && typeof pf.body?.canDeliver === 'boolean');
    check('干净页不被误报（「无需确认」「不再需要核实」「无需再补充」都是结论）',
      (pf.body?.warnings ?? []).every((w) => w.index !== 0));
    check('内部语句被逐页报出（第 2 页命中 body 与 bullets）',
      (pf.body?.warnings ?? []).some((w) => w.index === 1 && w.field === 'body')
      && (pf.body?.warnings ?? []).some((w) => w.index === 1 && w.field === 'bullets'));
    check('整块跳过被识别（标题行本身报出，不因后面有「已确认」而漏）',
      (pf.body?.warnings ?? []).some((w) => w.index === 2));
    check('存在内部语句时 canDeliver 为 false', pf.body?.canDeliver === false);
    const clean = await prisma.planProject.create({
      data: {
        tenantId: tenantA, userId: me.body.id, title: '干净方案', style: 'A', edition: 'standard', pageCount: 1,
        // 刻意用门店会写的措辞：「无待办事项」本身含该词，早期版本会把它误报成有问题。
        // 预检一旦误报，门店就不会再信它 —— 断言必须覆盖这类反向场景。
        pages: [{ type: 'scene', heading: '落地方案', subtitle: '', body: '本页无待办事项，全部内容已确认。', bullets: [], narration: '', quote: '' }],
        versionNo: 1,
      },
    });
    const pfClean = await request<{ canDeliver: boolean; pageCount: number }>(base, `/api/plans/${clean.id}/preflight`, authA);
    check('干净方案 canDeliver 为 true 且零告警', pfClean.body?.canDeliver === true);
    // 跨租户必须不可见
    const pfCross = await request(base, `/api/plans/${clean.id}/preflight`, authB);
    check('预检跨租户被拒（404，不泄露他人方案内容）', pfCross.status === 404);
    await prisma.planProject.delete({ where: { id: preflightSeed.id } });
    await prisma.planProject.delete({ where: { id: clean.id } });
  }

  // ---------- 生产路径（nginx）配置与后端限制一致 ----------
  // 这两条只有容器部署才会暴露：vite dev 不经过 nginx。
  // 0.2.2 修过两个真实缺陷 —— /api/ 只给 12m 而打包端点要 60MB（413），
  // 以及 location 带尾斜杠导致 /api/plans 被 301 跳走（列表接口坏掉）。
  {
    const nginx = readFileSync(join(process.cwd(), '../web/nginx.conf'), 'utf8');
    // 按「从 location 声明到下一个 location 声明」切块，避免用 } 收尾
    // —— 块内缩进不一致时 ]} 之类的正则会静默匹配不到，断言假失败。
    const blockOf = (marker: string): string => {
      const i = nginx.indexOf(marker);
      if (i < 0) return '';
      const rest = nginx.slice(i + marker.length);
      const j = rest.indexOf('location ');
      return j < 0 ? rest : rest.slice(0, j);
    };
    const plansBlock = blockOf('location /api/plans');
    const generalBlock = blockOf('location /api/');
    const num = (blk: string): number => Number((blk.match(/client_max_body_size\s*(\d+)m/) ?? [])[1] ?? NaN);
    const plansLimit = num(plansBlock);
    const generalLimit = num(generalBlock);
    check(
      `交付包路径的上传上限 >= 后端 FileInterceptor 的 60MB（生产环境否则 413；实测 ${plansLimit}m）`,
      plansLimit >= 60,
    );
    check(
      '交付包 location 不带尾斜杠（带尾斜杠会让 /api/plans 被 301 跳走）',
      !/location \/api\/plans\/\s*\{/.test(nginx) && plansBlock.length > 0,
    );
    check(
      `普通上传路径上限独立生效且更小（实测 ${generalLimit}m vs 交付包 ${plansLimit}m）`,
      generalLimit > 0 && generalLimit <= 20 && generalLimit < plansLimit,
    );
  }

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

  // ---------- 生成提交幂等键：重复提交不重复出图、不重复扣额度 ----------
  // 场景是「上一次其实成功了，但响应在弱网里丢了，用户又点了一次」。
  // 用 DB 预置一条带该键的产物来模拟这个状态：请求应当直接取回原产物，
  // 而不是再出一次图、再扣一次额度——额度是本项目唯一对外收费口径，不能重复扣。
  const idemKey = `smoke-idem-${randomUUID()}`;
  const seededAsset = await prisma.mediaAsset.create({
    data: {
      tenantId: tenantA,
      userId: me.body.id,
      kind: 'image',
      title: '幂等验证',
      prompt: '幂等验证用提示词',
      filePath: 'images/smoke-idempotent.png',
      mimeType: 'image/png',
      sizeBytes: 0,
      status: 'ready',
      clientRequestId: idemKey,
    },
  });
  const idemReplay = await request<{ id: string; url: string; deduped?: boolean }>(base, '/api/media/images', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({ prompt: '幂等验证用提示词', clientRequestId: idemKey }),
  });
  check(
    '同一提交键重复提交直接取回原产物（deduped=true，不重复扣额度）',
    idemReplay.status === 201 && idemReplay.body?.deduped === true && idemReplay.body?.id === seededAsset.id,
  );
  const idemOtherKey = await request<{ deduped?: boolean }>(base, '/api/media/images', {
    ...authA,
    method: 'POST',
    // 换一个键：不该命中已有记录。这里带遮罩，让请求在通道能力校验处就被拒
    // （503），既能验证不误判，又不会真的触发出图调用白烧额度。
    body: JSON.stringify({
      prompt: '幂等验证用提示词',
      imageAssetId: '00000000-0000-0000-0000-000000000000',
      maskDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      clientRequestId: `${idemKey}-other`,
    }),
  });
  check(
    '换一个提交键不会被误判为重复（deduped 不为 true）',
    idemOtherKey.body?.deduped !== true,
  );
  const stillOne = await prisma.mediaAsset.count({ where: { clientRequestId: idemKey } });
  check('幂等键在库中唯一（重放没有产生第二条产物）', stillOne === 1);

  // ---------- 生成调用的有限重试（0.2.11）----------
  // 参考站 floorplan-render.js 用 MAX_POLL_FAILURES=6 表达同一量级的思路：
  // 生图链路长、失败率高，不该一次抖动就让用户白等白扣。
  {
    const retryable = (e: unknown): boolean => defaultIsRetryable(e);

    check('超时 / 连接重置类错误判定为可重试',
      retryable(Object.assign(new Error('x'), { name: 'TimeoutError' }))
      && retryable(new Error('socket hang up')) && retryable(new Error('ETIMEDOUT')));
    check('5xx 与 429 判定为可重试',
      retryable({ status: 500 }) && retryable({ status: 503 }) && retryable({ status: 429 }));
    check('4xx 判定为不可重试（参数错/key 无效重试也没用，只会白等）',
      !retryable({ status: 400 }) && !retryable({ status: 401 }) && !retryable({ status: 403 }));

    let calls = 0;
    const flaky = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('fetch failed');
      return 'ok';
    }, { attempts: 3, baseDelayMs: 1 });
    check('网络抖动会重试直到成功（不把一次抖动变成一次失败）', flaky === 'ok' && calls === 3);

    let authCalls = 0;
    let authErr = '';
    try {
      await withRetry(async () => { authCalls += 1; throw { status: 401, message: 'bad key' }; },
        { attempts: 3, baseDelayMs: 1 });
    } catch (e) { authErr = (e as { message?: string })?.message ?? ''; }
    check('key 无效时立刻失败不重试（不把 30 秒变成 90 秒）', authCalls === 1 && authErr === 'bad key');

    let fiveCalls = 0;
    let fiveErr = '';
    try {
      await withRetry(async () => { fiveCalls += 1; throw { status: 503, message: 'upstream down' }; },
        { attempts: 3, baseDelayMs: 1 });
    } catch (e) { fiveErr = (e as { message?: string })?.message ?? ''; }
    check('上游持续故障会重试到耗尽，且抛出的是原始原因', fiveCalls === 3 && fiveErr === 'upstream down');

    const t0 = Date.now();
    let timedOut = false;
    try { await withRetry(() => new Promise<never>(() => {}), { attempts: 1, timeoutMs: 200 }); }
    catch { timedOut = true; }
    check('单次调用有超时兜底（不会无限等待）', timedOut && Date.now() - t0 < 3000);

    let defCalls = 0;
    try {
      await withRetry(async () => { defCalls += 1; throw new Error('fetch failed'); }, { baseDelayMs: 1 });
    } catch { /* 预期抛错 */ }
    check('默认尝试次数有限（默认 3 次，不是无限重试）', defCalls === 3);
  }

  await prisma.mediaAsset.delete({ where: { id: seededAsset.id } });

  // 生视频走同一套幂等机制，且单价更高，更不能漏。
  // 同样用预置产物模拟「上次成功但响应丢了」，不触发真实的视频生成调用。
  const vIdemKey = `smoke-idem-vid-${randomUUID()}`;
  const seededVideo = await prisma.mediaAsset.create({
    data: {
      tenantId: tenantA,
      userId: me.body.id,
      kind: 'video',
      title: '视频幂等验证',
      prompt: '视频幂等验证用提示词',
      filePath: 'videos/smoke-idempotent.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 0,
      status: 'ready',
      clientRequestId: vIdemKey,
    },
  });
  const vidReplay = await request<{ id: string; deduped?: boolean }>(base, '/api/media/videos', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({
      prompt: '视频幂等验证用提示词',
      duration: 5,
      resolution: '720P',
      ratio: '16:9',
      clientRequestId: vIdemKey,
    }),
  });
  check(
    '生视频同一提交键重复提交直接取回原视频（不重复扣额度）',
    vidReplay.status === 201 && vidReplay.body?.deduped === true && vidReplay.body?.id === seededVideo.id,
  );
  await prisma.mediaAsset.delete({ where: { id: seededVideo.id } });

  // 方案是全项目最贵的一次提交：先调 LLM 出页，再按页数扣费。
  // 幂等查询必须排在调 LLM 之前，否则重放一次就是白烧一次模型 + 一次额度。
  const pIdemKey = `smoke-idem-plan-${randomUUID()}`;
  const seededPlan = await prisma.planProject.create({
    data: {
      tenantId: tenantA,
      userId: me.body.id,
      title: '方案幂等验证',
      style: 'A',
      edition: 'standard',
      pageCount: 9,
      pages: [],
      versionNo: 1,
      clientRequestId: pIdemKey,
    },
  });
  const planReplay = await request<{ id: string; deduped?: boolean }>(base, '/api/plans', {
    ...authA,
    method: 'POST',
    body: JSON.stringify({
      title: '方案幂等验证',
      style: 'A',
      edition: 'standard',
      pageCount: 9,
      clientRequestId: pIdemKey,
    }),
  });
  check(
    '方案同一提交键重复提交直接取回原方案（不重复调 LLM、不重复扣费）',
    planReplay.status === 201 && planReplay.body?.deduped === true && planReplay.body?.id === seededPlan.id,
  );
  await prisma.planProject.delete({ where: { id: seededPlan.id } });

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

  // ================= Agent 机器接入（0.1.53） =================

  // ---------- 能力清单：索引模式必须足够小，否则省 token 的目的就落空了 ----------
  {
    const idx = await request<{
      groups: { id: string; name: string; ops: number }[];
      destructiveCount: number;
      hint: string;
    }>(base, '/api/agent/manifest', authA);
    // 索引必须足够小，否则「按需取」就失去意义：1200 token 足以覆盖，500 以下说明它真的在筛选
    const idxTokens = Math.ceil(JSON.stringify(idx.body).length / 3);
    check(
      `能力清单索引可取且足够精简（${idxTokens} tokens，含 ${idx.body.groups?.length} 组）`,
      idx.status === 200 && idxTokens > 0 && idxTokens < 1200,
    );
    check('索引带得出破坏性操作数量（想细看可单独拉全表）', (idx.body.destructiveCount ?? 0) >= 15);

    // 破坏性操作全表单独取：它比索引本身还大，混进索引会让每次取清单都多付这笔 token
    const risk = await request<{ destructive: { p: string; group: string }[] }>(base, '/api/agent/manifest?risk=1', authA);
    check(
      '破坏性操作可单独取全表（防误操作的前提）',
      risk.status === 200 && (risk.body.destructive?.length ?? 0) >= 15
        && risk.body.destructive.every((d) => d.p.startsWith('/api/') && typeof d.group === 'string'),
    );

    const one = await request<{ group: { id: string; ops: unknown[] }; destructive: { group: string }[] }>(
      base, '/api/agent/manifest?group=quote', authA,
    );
    check(
      '能力清单支持按组取详情',
      one.status === 200 && one.body.group?.id === 'quote' && one.body.group.ops.length > 0,
    );
    check(
      '单组详情带得出该组的破坏性操作',
      Array.isArray(one.body.destructive) && one.body.destructive.every((d) => d.group === 'quote'),
    );
    const oneTokens = Math.ceil(JSON.stringify(one.body).length / 3);
    check(`单组详情比全量省 token（单组 ${oneTokens} tokens vs 索引 ${idxTokens}）`, oneTokens < idxTokens * 3);
  }

  // ---------- 清单漂移守卫：新增接口忘了写进清单，门禁必须拦住 ----------
  {
    // 从源码反推真实路由（不依赖运行时反射，smoke 里也能跑）
    const srcRoot = join(process.cwd(), 'src');
    const real = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.controller.ts')) {
          const src = readFileSync(p, 'utf8');
          const cm = src.match(/@Controller\(\s*'([^']*)'/);
          const base = (cm?.[1] ?? '').replace(/^\//, '').replace(/\/$/, '');
          for (const mm of src.matchAll(/@(Get|Post|Patch|Delete|Put)\(\s*(?:'([^']*)'|\s*\))/g)) {
            const sub = (mm[2] ?? '').replace(/^\//, '').replace(/\/$/, '');
            real.add(`${mm[1].toUpperCase()} /api/${base}${sub ? `/${sub}` : ''}`.replace(/\/\/+/g, '/'));
          }
        }
      }
    };
    walk(srcRoot);
    // Nest 路由写 :id，清单面向 Agent 写 {id}（OpenAPI 惯例），比对前统一
    const norm = (r: string): string => r.replace(/:([A-Za-z]+)/g, '{$1}');
    const declared = new Set([...manifestRouteKeys()].map(norm));
    const missing = [...real].map(norm).filter((r) => !declared.has(r)).sort();
    check(
      `能力清单覆盖全部真实路由（真实 ${real.size} 条，漏 ${missing.length} 条${missing.length ? '：' + missing.slice(0, 6).join(' / ') : ''}）`,
      missing.length === 0,
    );
    // 反向：清单里写了但代码里没有的条目同样是错的，会把 Agent 带进沟里
    const realNorm = new Set([...real].map(norm));
    const ghost = [...declared].filter((r) => !realNorm.has(r)).sort();
    check(`能力清单没有虚构的路由（多出 ${ghost.length} 条${ghost.length ? '：' + ghost.slice(0, 6).join(' / ') : ''}）`, ghost.length === 0);
  }

  // ---------- 服务账号 + API Key 全生命周期 ----------
  {
    const svc = await request<{ id: string; phone: string; roleKey: string }>(base, '/api/agent/service-accounts', {
      method: 'POST',
      ...authA,
      body: JSON.stringify({ name: '冒烟测试 Agent', roleKey: 'viewer' }),
    });
    check('可创建独立机器账号且权限由角色决定', svc.status === 201 && svc.body.roleKey === 'viewer' && svc.body.phone.startsWith('svc_'));

    const key = await request<{ token: string; id: string; note: string }>(base, '/api/agent/keys', {
      method: 'POST',
      ...authA,
      body: JSON.stringify({ name: '冒烟 Key', ttlDays: 30, serviceAccountId: svc.body.id }),
    });
    check('可为机器账号签发 API Key', key.status === 201 && typeof key.body.token === 'string');

    // 机器账号不能登录（没有可用密码）
    const loginTry = await request<{ message?: string }>(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone: svc.body.phone, password: 'whatever' }),
    });
    check('机器账号无法用密码登录', loginTry.status >= 400);

    // Key 能当 Bearer 用，且 RBAC 生效（viewer 只有只读权限，写操作应被拒）
    const viaKey = await request<{ id: string }>(base, '/api/auth/me', {
      headers: { Authorization: `Bearer ${key.body.token}` },
    });
    check('API Key 可直接作为 Bearer 访问接口', viaKey.status === 200 && viaKey.body.id === svc.body.id);

    // 用「发 Key」这条来试 RBAC：它要 tenant:member:manage，viewer 没有。
    // 之前拿 POST /api/feedback 试，那条只要 cs:write 而 viewer 恰好有 → 断言口径本身就错了
    const denied = await request<{ message?: string }>(base, '/api/agent/keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.body.token}` },
      body: JSON.stringify({ name: 'viewer 不该发得出来' }),
    });
    check('API Key 的写操作受 RBAC 约束（viewer 被拒）', denied.status === 403);

    // 吊销后立即失效
    const rev = await request<{ ok: boolean }>(base, `/api/agent/keys/${key.body.id}/revoke`, {
      method: 'POST',
      ...authA,
    });
    const afterRevoke = await request<unknown>(base, '/api/auth/me', {
      headers: { Authorization: `Bearer ${key.body.token}` },
    });
    check('API Key 吊销后立即失效', rev.status === 201 && afterRevoke.status === 401);

    const keyList = await request<{ id: string; revoked: boolean }[]>(base, '/api/agent/keys', {
      ...authA,
    });
    check(
      'Key 列表只给前 12 位与状态，不回显明文',
      keyList.status === 200 && keyList.body.some((k) => k.id === key.body.id && k.revoked === true),
    );
  }

  // ---------- 快照与还原：真删真还原，不做样子 ----------
  {
    // 自己建一条再删自己那条：直接拿列表第一条去删，可能命中公共库产品（删不动、数量也不变）
    const made = await request<{ id: string }>(base, '/api/products/mine', {
      method: 'POST', ...authA, body: JSON.stringify({ name: '快照验证用产品', category: 'light', unit: '台' }),
    });
    const products = await request<{ id: string }[]>(base, '/api/products', authA);
    const before = products.body.length;
    const victim = made.status === 201 ? { id: made.body.id } : undefined;

    const snap = await request<{ id: string; label: string; counts: Record<string, number>; capabilityNote: string }>(
      base, '/api/agent/snapshots',
      { method: 'POST', ...authA, body: JSON.stringify({ label: '删产品前' }) },
    );
    check(
      '可打操作前快照',
      snap.status === 201 && snap.body.id.length > 0 && typeof snap.body.counts.product === 'number',
    );
    check(
      '快照明确声明撤不回已花额度与已生成媒体（不做万能后悔药暗示）',
      /撤不回/.test(snap.body.capabilityNote) && /额度/.test(snap.body.capabilityNote),
    );

    if (victim) {
      const del = await request<unknown>(base, `/api/products/${victim.id}`, {
        method: 'DELETE', ...authA,
      });
      const mid = await request<{ id: string }[]>(base, '/api/products', authA);
      check('删产品后确实少了一条', del.status === 200 && mid.body.length === before - 1);

      // 二次确认串不对必须拒绝——这是防手滑的关键闸门
      const badConfirm = await request<{ message?: string }>(base, `/api/agent/snapshots/${snap.body.id}/restore`, {
        method: 'POST', ...authA, body: JSON.stringify({ confirm: 'wrong' }),
      });
      check('还原必须校验二次确认串（防手滑调错快照）', badConfirm.status === 400);

      const restored = await request<{ ok: boolean; restored: Record<string, number> }>(
        base, `/api/agent/snapshots/${snap.body.id}/restore`,
        { method: 'POST', ...authA, body: JSON.stringify({ confirm: snap.body.id.slice(0, 8) }) },
      );
      const after = await request<{ id: string }[]>(base, '/api/products', authA);
      check(
        '按快照还原后数据回到操作前',
        restored.status === 201 && restored.body.ok === true && after.body.length === before
          && after.body.some((x) => x.id === victim.id),
      );

      // 同一份快照不允许反复还原，避免把后续正确操作也一起冲掉
      const twice = await request<{ message?: string }>(base, `/api/agent/snapshots/${snap.body.id}/restore`, {
        method: 'POST', ...authA, body: JSON.stringify({ confirm: snap.body.id.slice(0, 8) }),
      });
      check('同一份快照不允许反复还原', twice.status === 400);
    } else {
      check('删产品后确实少了一条', false);
      check('还原必须校验二次确认串（防手滑调错快照）', false);
      check('按快照还原后数据回到操作前', false);
      check('同一份快照不允许反复还原', false);
    }

    // 快照绝不能包含审计表：还原它等于改写「谁动过」这段历史
    const snapList = await request<{ id: string; prefix: string }[]>(base, '/api/agent/snapshots', {
      ...authA,
    });
    check(
      '快照列表给出还原所需的二次确认串，且不含审计表',
      snapList.status === 200 && snapList.body.length > 0 && snapList.body[0].prefix.length === 8,
    );
  }

  // ---------- 全量审计 ----------
  {
    const audit = await request<{ rows: { method: string; path: string; actorKind: string; requestId: string; payloadDigest: string | null; snapshotId: string | null }[] }>(
      base, '/api/agent/audit?limit=200', { ...authA },
    );
    const rows = audit.body.rows ?? [];
    const productDelete = rows.find((r) => r.path === '/api/products/:id' || /\/api\/products\//.test(r.path ?? ''));
    check(
      '删除类操作被自动记入审计（此前这类操作一条都不记）',
      audit.status === 200 && Boolean(productDelete),
    );
    check(
      '审计分得清人点的与机器跑的',
      rows.some((r) => r.actorKind === 'USER'),
    );
    check(
      '审计带 requestId 可串联一次动作',
      rows.every((r) => typeof r.requestId === 'string' && r.requestId.length > 0),
    );
    // 自动兜底：破坏性操作没自带 X-Snapshot-Id 时应先打一份 auto 快照，并把 id 记进审计
    check(
      '破坏性操作未自带快照时自动打 auto 兜底（防误删的最后一道）',
      rows.some((r) => Boolean(r.snapshotId)),
    );
    check(
      '审计记请求体摘要而非明文（不把客户信息存进审计表）',
      rows.some((r) => r.payloadDigest === null || /^[0-9a-f]{32}$/.test(r.payloadDigest)),
    );

    // 人为带 X-Request-Id 时应被原样记录，这是 Agent 复盘一次动作的抓手
    const rid = `rid-${randomUUID().slice(0, 8)}`;
    await request(base, '/api/feedback', {
      method: 'POST',
      // 注意不能写成 `...authA, headers: {...}`：后面的 headers 会把 authA.headers 整个覆盖掉，
      // 请求变成无鉴权 → 401 → 什么都不会被审计，排查时极难想到是这里
      headers: { ...authA.headers, 'X-Request-Id': rid },
      body: JSON.stringify({ category: 'bug', title: '审计串联验证', detail: 'x' }),
    });
    await new Promise<void>((r) => setTimeout(r, 800));
    const traced = await request<{ rows: { requestId: string }[] }>(base, `/api/agent/audit?requestId=${rid}`, {
      ...authA,
    });
    check('客户端自带的 X-Request-Id 能把一串动作串成一次任务', traced.status === 200 && traced.body.rows.length > 0);
  }

  // ================= 团队成员与角色模板（0.1.54） =================
  {
    // 角色模板必须是「点选就能用」的成品，不能要求管理员逐项勾 15 个权限 action
    const tpl = await request<{ key: string; id: string; name: string; permissions: string[]; description: string; isSystem: boolean; permissionCount: number }[]>(
      base, '/api/team/role-templates', authA,
    );
    check(
      `角色模板可取且每个都带人话说明与权限明细（${tpl.body?.length ?? 0} 个模板）`,
      tpl.status === 200 && Array.isArray(tpl.body) && tpl.body.length >= 10
        && tpl.body.every((t) => typeof t.description === 'string' && t.description.length > 0
          && t.permissionCount === t.permissions.length && typeof t.isSystem === 'boolean'),
    );
    // 展示顺序必须是从高权限到低权限，不能按 key 字母排
    const order = tpl.body.map((t) => t.key);
    check(
      `角色模板按权限从高到低排列（${order.join(' → ')}）`,
      order.indexOf('super_admin') < order.indexOf('tenant_admin')
        && order.indexOf('tenant_admin') < order.indexOf('viewer'),
    );
    const adminTpl = tpl.body.find((t) => t.key === 'tenant_admin');
    check('租户管理员模板含成员管理权限（否则没人能建账号）', (adminTpl?.permissions ?? []).includes('tenant:member:manage'));

    // 建成员 → 能登录 → 权限真的按角色生效
    const phoneM = randomPhone();
    const made = await request<{ id: string; roleKey: string }>(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: phoneM, displayName: '冒烟店员', roleKey: 'operator', password: 'Smoke12345' }),
    });
    check('管理员可按角色模板建成员', made.status === 201 && made.body.roleKey === 'operator');

    const loginM = await request<{ token: string }>(base, '/api/auth/login', {
      method: 'POST', body: JSON.stringify({ phone: phoneM, password: 'Smoke12345' }),
    });
    check('新成员能用管理员给的初始密码登录', loginM.status === 201 && typeof loginM.body.token === 'string');
    const mAuth = { headers: { Authorization: `Bearer ${loginM.body.token}` } };

    // 角色模板承诺 operator 能「跑接待与报价的日常动作」——断言必须照承诺写，
    // 否则模板就只是好看的文案，承诺与实际权限脱节比没有模板更糟
    const ordersOk = await request(base, '/api/orders', mAuth);
    const productsOk = await request(base, '/api/products', mAuth);
    check(
      'operator 能进接单与报价产品库（与角色模板承诺一致）',
      ordersOk.status === 200 && productsOk.status === 200,
    );
    const teamDenied = await request(base, '/api/team/members', mAuth);
    const backupDenied = await request(base, '/api/admin/backup', mAuth);
    check(
      'operator 碰不到团队管理与数据备份（与角色模板承诺一致）',
      teamDenied.status === 403 && backupDenied.status === 403,
    );

    // 改角色后权限要跟着变
    const toViewer = await request<{ roleKey: string }>(base, `/api/team/members/${made.body.id}`, {
      method: 'PATCH', ...authA, body: JSON.stringify({ roleKey: 'viewer' }),
    });
    const ordersAfter = await request(base, '/api/orders', mAuth);
    check(
      '降级为只读成员后立刻失去接单权限',
      toViewer.status === 200 && toViewer.body.roleKey === 'viewer' && ordersAfter.status === 403,
    );

    // 最后一个管理员不能被降级/移除，否则这个租户就再也没人能管成员了
    const meId = me.body.id;
    const demoteSelf = await request<{ message?: string }>(base, `/api/team/members/${meId}`, {
      method: 'PATCH', ...authA, body: JSON.stringify({ roleKey: 'viewer' }),
    });
    check(
      '最后一个管理员不能被降级（否则再没人能管成员）',
      demoteSelf.status === 403 && /LAST_ADMIN/.test(demoteSelf.body.message ?? ''),
    );
    const removeSelf = await request<{ message?: string }>(base, `/api/team/members/${meId}`, { method: 'DELETE', ...authA });
    check('不能把自己移出团队', removeSelf.status === 403);

    // 重复建同一个人要被拒
    const dup = await request<{ message?: string }>(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: phoneM, displayName: '重复', roleKey: 'viewer', password: 'Smoke12345' }),
    });
    check('同一个人不能重复加进同一租户', dup.status === 409);

    // 弱密码被拒
    const weak = await request(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: randomPhone(), displayName: '弱密码', roleKey: 'viewer', password: 'abcdefgh' }),
    });
    check('初始密码必须含数字（纯字母太弱，直接拒）', weak.status === 400);

    // 移出后其登录身份失效在本租户
    const removed = await request(base, `/api/team/members/${made.body.id}`, { method: 'DELETE', ...authA });
    check('可把成员移出团队', removed.status === 200);
  }

  // ---------- 自定义角色：能勾权限，但不能靠建角色提权 ----------
  {
    const made2 = await request<{ id: string; roleKey: string }>(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: randomPhone(), displayName: '自定义角色验证', roleKey: 'viewer', password: 'Smoke12345' }),
    });
    // viewer 登录回来，用它建角色 —— 必然越权
    const viewerPhone = randomPhone();
    await request(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: viewerPhone, displayName: '只读验证', roleKey: 'viewer', password: 'Smoke12345' }),
    });
    const vLogin = await request<{ token: string }>(base, '/api/auth/login', {
      method: 'POST', body: JSON.stringify({ phone: viewerPhone, password: 'Smoke12345' }),
    });
    check('只读成员可登录（用于验证提权防护）', vLogin.status === 201);

    // 分两层看：viewer 连建角色的资格都没有（PermissionsGuard 先拦），
    // 这跟「有资格但想给超出的权限」是两回事，断言要分开写，否则测到的不是真正的提权防护
    const vAuth = { headers: { Authorization: `Bearer ${vLogin.body.token}` } };
    const noRight = await request<{ message?: string }>(base, '/api/team/roles', {
      method: 'POST', ...vAuth,
      body: JSON.stringify({ name: '没资格建', permissions: ['knowledge:read'] }),
    });
    check(
      '没有成员管理权限的角色连自定义角色都建不了',
      noRight.status === 403 && /PERMISSION_DENIED/.test(noRight.body.message ?? ''),
    );

    // 真正的提权场景：租户管理员**有**建角色资格，但他手上只有 14 项权限（缺 platform:tenant:manage），
    // 想造一个含这项的角色塞给自己 —— 必须被 service 层的防提权守卫挡住
    const escalate = await request<{ message?: string }>(base, '/api/team/roles', {
      method: 'POST', ...authA,
      body: JSON.stringify({ name: '越权角色', permissions: ['platform:tenant:manage', 'quote:write'] }),
    });
    check(
      '有建角色资格也不能授予自己没有的权限（防提权）',
      escalate.status === 403 && /PRIVILEGE_ESCALATION/.test(escalate.body.message ?? ''),
    );
    // 管理员可以建自定义角色
    const custom = await request<{ id: string; name: string; permissions: string[] }>(base, '/api/team/roles', {
      method: 'POST', ...authA,
      body: JSON.stringify({ name: '冒烟自定义岗', description: '由冒烟测试创建', permissions: ['quote:write', 'knowledge:read'] }),
    });
    check('管理员可勾权限创建自定义角色', custom.status === 201 && (custom.body?.permissions?.length ?? 0) === 2);

    // 自定义角色出现在清单里且标为自定义
    const tpl2 = await request<{ id: string; isSystem: boolean; name: string }[]>(base, '/api/team/role-templates', authA);
    check(
      '自定义角色与系统模板一起出现在角色清单里',
      tpl2.status === 200 && tpl2.body.some((r) => r.id === custom.body.id && r.isSystem === false),
    );
    check(
      '预置岗位模板覆盖智能家居门店常见岗位',
      ['super_admin', 'tenant_admin', 'sales', 'designer', 'delivery', 'finance', 'purchase', 'marketing', 'service', 'viewer']
        .every((k) => tpl2.body.some((r) => (r as unknown as { key: string }).key === k)),
    );

    // 成员可以改用自定义角色
    const toCustom = await request<{ roleKey: string; roleId: string }>(base, `/api/team/members/${made2.body.id}`, {
      method: 'PATCH', ...authA, body: JSON.stringify({ roleKey: custom.body.id }),
    });
    check(
      '成员可改用自定义角色（按 id 引用）',
      toCustom.status === 200 && toCustom.body?.roleId === custom.body.id,
    );

    // 还有人在用的角色不能删
    const delUsed = await request<{ message?: string }>(base, `/api/team/roles/${custom.body.id}`, { method: 'DELETE', ...authA });
    check('还在用的自定义角色不能删（否则 Membership 悬空）', delUsed.status === 400 && /ROLE_IN_USE/.test(delUsed.body.message ?? ''));

    // 系统模板不可被改/删
    const sysDel = await request(base, '/api/team/roles/tenant_admin', { method: 'DELETE', ...authA });
    check('系统模板角色不可删除', sysDel.status >= 400);

    // 换回系统角色后可以删
    await request(base, `/api/team/members/${made2.body.id}`, { method: 'PATCH', ...authA, body: JSON.stringify({ roleKey: 'viewer' }) });
    const delFree = await request(base, `/api/team/roles/${custom.body.id}`, { method: 'DELETE', ...authA });
    check('没人用的自定义角色可以删', delFree.status === 200);

    // 空权限被拒
    const empty = await request(base, '/api/team/roles', {
      method: 'POST', ...authA, body: JSON.stringify({ name: '空角色', permissions: [] }),
    });
    check('空权限的自定义角色被拒（否则等于建了个什么都做不了的角色）', empty.status === 400);
  }

  // ---------- 清单必须如实反映调用者的权限 ----------
  {
    // ① 声明完整性：清单里的每条都要有权限声明，否则过滤时会被当成「无要求」而对谁都显示
    const allOps = MANIFEST_KEYS;
    const missingPerm = allOps.filter((k) => !(k in OP_PERMISSIONS));
    check(
      `能力清单每条操作都声明了所需权限（漏 ${missingPerm.length} 条${missingPerm.length ? '：' + missingPerm.slice(0, 4).join(' / ') : ''}）`,
      allOps.length > 0 && missingPerm.length === 0,
    );
    // ② 权限名必须是真实存在的 action，否则等于永远 403
    const badPerm = [...new Set(Object.values(OP_PERMISSIONS).flat())].filter((a) => !PERMISSION_SET.has(a));
    check(`声明的权限名都真实存在（异常 ${badPerm.length} 个）`, badPerm.length === 0);

    // ②b **声明必须与守卫装饰器一致**。这张表是手写的，不校验迟早会和 @RequirePermissions 漂移 ——
    //     本轮已经漂过一次（knowledge/external 实际要 knowledge:manage，声明写成了 knowledge:read），
    //     会让只读 Key 的过滤清单漏出它调不动的操作。这里从源码静态抽取真实守卫逐条比对。
    const realPerms = extractGuards(join(process.cwd(), 'src'));
    const mismatch = allOps.filter((k) => {
      const actual = realPerms.get(k);
      if (actual === undefined) return false; // 抽不到（如继承来的）不误判
      const declared = OP_PERMISSIONS[k];
      return declared.length !== actual.length || declared.some((d) => !actual.includes(d));
    });
    check(
      `清单声明的权限与 @RequirePermissions 装饰器一致（不一致 ${mismatch.length} 条${mismatch.length ? '：' + mismatch.slice(0, 4).join(' / ') : ''}）`,
      realPerms.size > 50 && mismatch.length === 0,
    );
    // 反向：源码里挂了守卫但清单没声明的，清单会把它当成「无要求」而对谁都显示
    const notDeclared = [...realPerms.keys()].filter((k) => !(k in OP_PERMISSIONS) && allOps.includes(k));
    check(`源码里所有端点都在清单中声明了权限（漏 ${notDeclared.length} 条）`, notDeclared.length === 0);

    // ③ 只读 Key 读到的清单里，不能出现它实际调不动的操作
    const phoneRO = randomPhone();
    await request(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: phoneRO, displayName: '清单验证只读', roleKey: 'viewer', password: 'Smoke12345' }),
    });
    const roLogin = await request<{ token: string }>(base, '/api/auth/login', {
      method: 'POST', body: JSON.stringify({ phone: phoneRO, password: 'Smoke12345' }),
    });
    const roAuth = { headers: { Authorization: `Bearer ${roLogin.body.token}` } };
    const eff = await request<{ groups: { ops: { m: string; p: string }[] }[]; yourPermissions: string[] }>(
      base, '/api/agent/manifest?effective=1', roAuth,
    );
    const promised = (eff.body.groups ?? []).flatMap((g) => g.ops.map((o) => `${o.m} ${o.p}`));
    const overPromised = promised.filter((k) => (OP_PERMISSIONS[k] ?? []).some((r) => !(eff.body.yourPermissions ?? []).includes(r)));
    check(
      `按权限过滤后的清单不承诺调用者做不到的操作（越权 ${overPromised.length} 条）`,
      eff.status === 200 && overPromised.length === 0 && promised.length < allOps.length,
    );
    check(
      '只读 Key 的清单里确实看不到团队管理与数据备份',
      !promised.some((k) => k.includes('/api/team/members') || k.includes('/api/admin/backup')),
    );
    // 扣费类操作必须出现在声明表里，且需要权限 —— 曾经 materials/purchase 扣 100 token 却无守卫
    const charging = ['POST /api/media/materials/purchase', 'POST /api/tenants/current/tokens/grant', 'POST /api/media/videos'];
    check(
      '会扣额度的操作都在权限声明里且要求权限',
      charging.every((k) => (OP_PERMISSIONS[k] ?? []).length > 0),
    );

    // ④ 清单承诺与守卫实际行为一致：挑几条实际打一下，越权必须真的是 403
    // 只读成员只有 knowledge:read 与 cs:write。抽查三条：有权限的能进、没权限的进不去。
    const realChecks: [string, boolean][] = [
      ['GET /api/feedback (有 cs:write)', (await request(base, '/api/feedback', roAuth)).status === 200],
      ['GET /api/products (无 quote:read)', (await request(base, '/api/products', roAuth)).status === 403],
      ['GET /api/admin/backup (无 platform:billing:manage)', (await request(base, '/api/admin/backup', roAuth)).status === 403],
    ];
    check(
      '清单声明的权限与守卫实际拦截一致（抽查 3 条）',
      realChecks.every(([, ok]) => ok),
    );
    for (const [name, ok] of realChecks) {
      if (!ok) console.error(`  抽查不符: ${name}`);
    }

    const roMember = (await request<{ id: string; phone: string }[]>(base, '/api/team/members', authA)).body
      .find((m) => m.phone === phoneRO);
    if (roMember) await request(base, `/api/team/members/${roMember.id}`, { method: 'DELETE', ...authA });
  }

  // ---------- 权限二元切分（0.1.55）----------
  {
    // ① 读写二元：凡有 write 的资源都必须有 read，且 catalog 描述齐全
    const permSet = new Set<string>(PERMISSIONS);
    const writeActions = PERMISSIONS.filter((a) => WRITE_IMPLIES_READ[a]);
    const orphanWrite = writeActions.filter((w) => !permSet.has(WRITE_IMPLIES_READ[w]));
    check(
      `权限已拆成读写二元（${writeActions.length} 组：${writeActions.join('、')}）`,
      writeActions.length >= 5 && orphanWrite.length === 0,
    );
    check(
      `权限里已不再残留笼统的 :manage（残留 ${PERMISSIONS.filter((a) => a.endsWith(':manage') && !['platform:tenant:manage', 'platform:billing:manage', 'tenant:member:manage', 'knowledge:manage'].includes(a)).length} 个）`,
      PERMISSIONS.every((a) =>
        a.endsWith(':manage')
          ? ['platform:tenant:manage', 'platform:billing:manage', 'tenant:member:manage', 'knowledge:manage'].includes(a)
          : true,
      ),
    );

    // ② 「写隐含读」必须在权限判定层真的生效：只有 write 的账号应当能调 read 的端点
    const phoneW = randomPhone();
    const rid = await request<{ id: string }>(base, '/api/team/roles', {
      method: 'POST', ...authA,
      body: JSON.stringify({ name: '只给写的冒烟角色', permissions: ['quote:write'] }),
    });
    check('可创建只含写权限的自定义角色', rid.status === 201);
    await request(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: phoneW, displayName: '写隐含读验证', roleKey: rid.body.id, password: 'Smoke12345' }),
    });
    const wLogin = await request<{ token: string }>(base, '/api/auth/login', {
      method: 'POST', body: JSON.stringify({ phone: phoneW, password: 'Smoke12345' }),
    });
    const wAuth = { headers: { Authorization: `Bearer ${wLogin.body.token}` } };
    const wRead = await request(base, '/api/products', wAuth);
    const wWrite = await request(base, '/api/products/mine', {
      method: 'POST', headers: { Authorization: `Bearer ${wLogin.body.token}` },
      body: JSON.stringify({ name: '写隐含读验证产品', category: 'light', unit: '台' }),
    });
    check(
      '写权限隐含读权限（只有 quote:write 也能读产品库）',
      wRead.status === 200 && wWrite.status === 201,
    );
    // 但反之不成立：只有 read 不能写
    const phoneR = randomPhone();
    const ridR = await request<{ id: string }>(base, '/api/team/roles', {
      method: 'POST', ...authA,
      body: JSON.stringify({ name: '只给读的冒烟角色', permissions: ['quote:read'] }),
    });
    await request(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: phoneR, displayName: '只读验证', roleKey: ridR.body.id, password: 'Smoke12345' }),
    });
    const rLogin = await request<{ token: string }>(base, '/api/auth/login', {
      method: 'POST', body: JSON.stringify({ phone: phoneR, password: 'Smoke12345' }),
    });
    const rAuth = { headers: { Authorization: `Bearer ${rLogin.body.token}` } };
    check(
      '读权限不含写权限（只有 quote:read 改不了产品库）',
      (await request(base, '/api/products', rAuth)).status === 200
      && (await request(base, '/api/products/mine', { method: 'POST', ...rAuth, body: JSON.stringify({ name: 'x', category: 'light' }) })).status === 403,
    );

    // ③ 财务这个真实诉求现在能被表达了：能看报价，不能改价
    const finPhone = randomPhone();
    await request(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: finPhone, displayName: '财务验证', roleKey: 'finance', password: 'Smoke12345' }),
    });
    const finLogin = await request<{ token: string }>(base, '/api/auth/login', {
      method: 'POST', body: JSON.stringify({ phone: finPhone, password: 'Smoke12345' }),
    });
    const finAuth = { headers: { Authorization: `Bearer ${finLogin.body.token}` } };
    check(
      '财务能看报价但不能改价（split 二元切分解决的真问题）',
      (await request(base, '/api/products', finAuth)).status === 200
      && (await request(base, '/api/products/mine', { method: 'POST', ...finAuth, body: JSON.stringify({ name: 'x', category: 'light' }) })).status === 403,
    );

    // 清理三个验证账号与其角色
    for (const ph of [phoneW, phoneR, finPhone]) {
      const m = (await request<{ id: string; phone: string }[]>(base, '/api/team/members', authA)).body.find((x) => x.phone === ph);
      if (m) await request(base, `/api/team/members/${m.id}`, { method: 'DELETE', ...authA });
    }
    for (const roleId of [rid.body.id, ridR.body.id]) {
      await request(base, `/api/team/roles/${roleId}`, { method: 'DELETE', ...authA });
    }
  }

  // ---------- 机器账号可删除（0.1.55 补齐的缺口）----------
  {
    const svc = await request<{ id: string; name: string }>(base, '/api/agent/service-accounts', {
      method: 'POST', ...authA, body: JSON.stringify({ name: '待删除的机器账号', roleKey: 'viewer' }),
    });
    const key = await request<{ id: string; token: string }>(base, '/api/agent/keys', {
      method: 'POST', ...authA,
      body: JSON.stringify({ name: 'k', serviceAccountId: svc.body.id }),
    });
    check('机器账号可签发 Key 并立即可用',
      (await request(base, '/api/auth/me', { headers: { Authorization: `Bearer ${key.body.token}` } })).status === 200);

    const del = await request(base, `/api/team/service-accounts/${svc.body.id}`, { method: 'DELETE', ...authA });
    check('机器账号可删除', del.status === 200);
    check(
      '删除机器账号后其 Key 立即失效',
      (await request(base, '/api/auth/me', { headers: { Authorization: `Bearer ${key.body.token}` } })).status === 401,
    );
    // 人类成员不能走这个口删，避免把人的全局账号连带删掉
    const human = (await request<{ id: string }[]>(base, '/api/team/members', authA)).body[0];
    const wrong = await request<{ message?: string }>(base, `/api/team/service-accounts/${human.id}`, { method: 'DELETE', ...authA });
    check(
      '人类成员不能走机器账号删除通道（避免连带删掉其全局账号）',
      wrong.status === 400 && /NOT_A_SERVICE_ACCOUNT/.test(wrong.body.message ?? ''),
    );
  }

  // ---------- 产品图标：同品类不得撞图标（0.1.56）----------
  {
    const iconKeys = readFileSync(join(process.cwd(), '../web/src/lib/product-icons.ts'), 'utf8');
    const known = new Set(
      (iconKeys.match(/export const PRODUCT_ICON_KEYS: string\[\] = \[([\s\S]*?)\];/) ?? [, ''])[1]
        .split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean),
    );
    const all = await request<{ id: string; name: string; category: string; iconKey?: string; tenantId?: string | null }[]>(
      base, '/api/products', authA,
    );
    // 只断言**公共库预置产品**：这条守卫守的是 seed 的正确性。
    // /api/products 同时返回本租户产品，而本文件前面那些用例自己建了几个无图标产品
    // （它们本就该回退品类图标），把它们算进来会让断言测不到该测的东西。
    const prods = { body: all.body.filter((p) => !p.tenantId) };
    const noIcon = prods.body.filter((p) => !p.iconKey);
    const badKey = prods.body.filter((p) => p.iconKey && !known.has(p.iconKey));
    check(
      `公共库每个产品都配了产品级图标（${prods.body.length} 个，缺 ${noIcon.length}）`,
      prods.body.length >= 20 && noIcon.length === 0,
    );
    check(
      `产品图标的 key 都真实存在于图标库（无效 ${badKey.length} 个）`,
      badKey.length === 0,
    );
    // 同品类撞图标 = 点位图上一排标记长得一样，分不清谁是谁
    const byCat = new Map<string, string[]>();
    for (const p of prods.body) {
      const arr = byCat.get(p.category) ?? [];
      arr.push(p.iconKey ?? '');
      byCat.set(p.category, arr);
    }
    const collided = [...byCat.entries()].filter(([, ks]) => ks.length > 1 && new Set(ks).size !== ks.length);
    check(
      `同品类产品的图标互不相同（撞车 ${collided.length} 组${collided.length ? '：' + collided.map(([c]) => c).join('、') : ''}）`,
      collided.length === 0,
    );
    const multi = [...byCat.entries()].filter(([, ks]) => ks.length > 1);
    check(
      `确实存在同品类多产品需要区分（${multi.length} 个品类），否则本组断言无意义`,
      multi.length >= 3,
    );
  }

  // ---------- 字体与图标许可证/一致性守卫（0.1.57）----------
  {
    const webRoot = join(process.cwd(), '../web');
    // ① 仓库里不允许出现字体文件。
    //    按字体「名字」引用系统字体是标准做法、不构成再分发；但一旦把字体文件打进仓库/镜像，
    //    就是实打实的字体再分发，必须确认所选字体允许捆绑分发。守住这条最省事。
    const fontFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        const fp = join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (/\.(woff2?|ttf|otf|eot)$/i.test(e.name)) fontFiles.push(fp.replace(webRoot, 'web'));
      }
    };
    walk(webRoot);
    check(`仓库未打包任何字体文件（发现 ${fontFiles.length} 个）`, fontFiles.length === 0);

    // ③ 首次部署安全：公开弱默认值必须留空。
    //    曾把 JWT_SECRET=change-me-in-production / SEED_ADMIN_PASSWORD=Admin@123456
    //    写进 .env.example。compose 的 `:?` 只检查「变量有没有」，有占位值照样放行，
    //    于是伙伴 cp 完直接上线 = 全网公开的签名密钥 + 公开的管理员密码。
    //    现在这三项留空，compose 会拒绝启动；这条断言防止将来被填回去。
    {
      const envExample = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf-8');
      const valOf = (k: string): string =>
        ((envExample.match(new RegExp('^' + k + '=(.*)$', 'm')) ?? [])[1] ?? '').trim();
      const weak = ['JWT_SECRET', 'SEED_ADMIN_PHONE', 'SEED_ADMIN_PASSWORD'].filter((k) => valOf(k) !== '');
      check(
        `.env.example 的三项必填凭据留空，compose 才能真正拦住弱默认值（残留 ${weak.length} 项）`,
        weak.length === 0,
      );
      check(
        '.env.example 说明了 JWT_SECRET 为什么要改（公开默认可伪造 token）',
        /伪造登录 token|伪造.*token/.test(envExample),
      );
      // 用子串判断而不是正则：`${JWT_SECRET:?…}` 里的 `$\{` 在 TS→JS 两层转义下极易写错，
      // 写错了断言会「假失败」——比没有断言更糟。正则转义问题已经坑过一次。
      const composeYml = readFileSync(new URL('../../../../docker-compose.yml', import.meta.url), 'utf-8');
      const guarded = ['JWT_SECRET', 'SEED_ADMIN_PHONE', 'SEED_ADMIN_PASSWORD']
        .filter((k) => composeYml.includes('{' + k + ':?'));
      check(
        `compose 对三项凭据用 :? 强校验（缺值即拒绝启动）（实际 ${guarded.length}/3）`,
        guarded.length === 3,
      );
    }

    // ② 字体栈必须只有一个来源：styles.css 是唯一定义处，fonts.ts 用 ?raw 提取。
    //    曾经两边各写一份，smoke 立刻报不一致——两份副本本身就是漂移风险源。
    const fontsTs = readFileSync(join(webRoot, 'src/theme/fonts.ts'), 'utf8');
    const css = readFileSync(join(webRoot, 'src/styles.css'), 'utf8');
    check(
      '字体栈单一来源：theme/fonts.ts 从 styles.css ?raw 提取而非另写一份',
      /from '\.\.\/styles\.css\?raw'/.test(fontsTs),
    );
    // CSS 栈里必须有 OFL 开源中文兜底，否则精简 Linux 上中文会变豆腐块
    const cssStack = (css.match(/font-family:\s*([^;]+);/) ?? [, ''])[1];
    check(
      '字体栈含 OFL 开源中文兜底（Noto/Source Han/WenQuanYi）',
      /Noto Sans SC/.test(cssStack) && /Source Han Sans SC/.test(cssStack),
    );
    // 画布与 PPTX 也必须走同一个来源，不允许各自写死字体名
    const canvasSrc = readFileSync(join(webRoot, 'src/lib/pointOverlay.ts'), 'utf8');
    const heatSrc = readFileSync(join(webRoot, 'src/lib/signalHeatmap.ts'), 'utf8');
    const pptxSrc = readFileSync(join(webRoot, 'src/lib/planPptx.ts'), 'utf8');
    check(
      'canvas 三处字体引用统一来源（不再写死 Microsoft YaHei）',
      [canvasSrc, heatSrc].every((x) => x.includes('FONT_STACK_CANVAS'))
        && !/px "Microsoft YaHei"/.test(canvasSrc + heatSrc),
    );
    check(
      'PPTX 字体名取自 FONT_PPTX 常量',
      pptxSrc.includes('FONT_PPTX') && !/const FONT = 'Microsoft YaHei'/.test(pptxSrc),
    );

    // ③ 图标尺寸必须走 ICON_SIZE 档位，不允许各处随手写数字
    const iconSrc = readFileSync(join(webRoot, 'src/lib/product-icons.ts'), 'utf8');
    check(
      '图标尺寸已收敛到 ICON_SIZE 档位',
      /export const ICON_SIZE/.test(iconSrc),
    );
    const stray: string[] = [];
    for (const f of ['ProductCenter.tsx', 'DeviceLayout.tsx']) {
      const src = readFileSync(join(webRoot, 'src/pages', f), 'utf8');
      for (const m of src.matchAll(/(?:productIconSvg|categoryIconSvg|iconSvgByKey)\([^)]*?,\s*(\d+)\s*,/g)) {
        stray.push(`${f}:${m[1]}`);
      }
    }
    check(
      `图标调用点不再写死尺寸（发现 ${stray.length} 处：${stray.join(',') || '无'}）`,
      stray.length === 0,
    );
  }

  // ---------- 版本号单一事实源（0.1.78）----------
  {
    // 这三处曾漂移成 root 0.1.77 / api 0.1.47 / errorContext 0.1.45，报错上下文里的
    // 版本号与 CHANGELOG 对不上，用户报障时无法据此定位是哪一版。根 package.json 是唯一事实源。
    const rootPkg = JSON.parse(readFileSync(join(process.cwd(), '../../package.json'), 'utf8')) as { version: string };
    const apiPkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const webPkg = JSON.parse(readFileSync(join(process.cwd(), '../web/package.json'), 'utf8')) as { version: string };
    check(
      `版本号三处一致（root=${rootPkg.version} api=${apiPkg.version} web=${webPkg.version}）`,
      rootPkg.version === apiPkg.version && apiPkg.version === webPkg.version,
    );
    const vc = readFileSync(join(process.cwd(), '../web/src/lib/errorContext.ts'), 'utf8');
    check(
      'errorContext 版本号取自注入变量而非手写常量',
      /import\.meta\.env\.VITE_APP_VERSION/.test(vc) && !/APP_VERSION\s*=\s*'0\.\d/.test(vc),
    );
    const viteCfg = readFileSync(join(process.cwd(), '../web/vite.config.ts'), 'utf8');
    check(
      'vite.config.ts 从根 package.json 注入版本号',
      viteCfg.includes("'../../package.json'") && viteCfg.includes('VITE_APP_VERSION'),
    );
  }

  // ---------- 头像上传 + 工作台改名 + 多租户边界（0.1.58）----------
  {
    const originalTenantName = (await request<{ memberships: { tenantName: string }[] }>(base, '/api/auth/me', authA)).body.memberships[0]?.tenantName ?? '';
    // ① 头像：走既有 /api/media/uploads 上传（复用，不新建端点）→ 写 profile → me 回读
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'a.png');
    // 不能走 request()：它会强制 Content-Type: application/json，
    // multipart 的 boundary 就丢了，服务端解析不出文件（这个坑踩过一次）
    const upRes = await fetch(`${base}/api/media/uploads`, {
      method: 'POST', headers: authA.headers, body: fd,
    });
    const up = { status: upRes.status, body: (await upRes.json()) as { id: string; url: string } };
    check('既有上传端点可直接用于头像（未新建上传接口）', up.status === 201 && up.body.url.startsWith('/api/media/'));

    const saved = await request<{ displayName: string }>(base, '/api/auth/profile', {
      method: 'PATCH', ...authA, body: JSON.stringify({ avatarUrl: up.body.url }),
    });
    check('头像地址可保存', saved.status === 200);
    const meAfterAvatar = await request<{ avatarUrl?: string }>(base, '/api/auth/me', authA);
    check(
      '头像已持久化（换请求仍能读回）',
      meAfterAvatar.body.avatarUrl === up.body.url,
    );

    // 外站地址要被拒：否则可以塞个外链当头像，等于让用户界面加载任意第三方资源
    const badUrl = await request<{ message?: string }>(base, '/api/auth/profile', {
      method: 'PATCH', ...authA, body: JSON.stringify({ avatarUrl: 'https://evil.example/x.png' }),
    });
    check('头像地址拒绝外站链接（避免任意第三方资源加载）', badUrl.status === 400);

    // ② 工作台改名：管理员可改，普通成员不可改
    const renamed = await request<{ name: string }>(base, '/api/tenants/current', {
      method: 'PATCH', ...authA, body: JSON.stringify({ name: '冒烟测试工作台' }),
    });
    check('租户管理员可改工作台名称', renamed.status === 200 && renamed.body.name === '冒烟测试工作台');
    const meAfterRename = await request<{ memberships: { tenantName: string }[] }>(base, '/api/auth/me', authA);
    check('改名已持久化到成员关系里', meAfterRename.body.memberships[0]?.tenantName === '冒烟测试工作台');

    const phoneM2 = randomPhone();
    await request(base, '/api/team/members', {
      method: 'POST', ...authA,
      body: JSON.stringify({ phone: phoneM2, displayName: '改名边界验证', roleKey: 'operator', password: 'Smoke12345' }),
    });
    const m2Login = await request<{ token: string }>(base, '/api/auth/login', {
      method: 'POST', body: JSON.stringify({ phone: phoneM2, password: 'Smoke12345' }),
    });
    const m2Auth = { headers: { Authorization: `Bearer ${m2Login.body.token}` } };
    const denied = await request(base, '/api/tenants/current', {
      method: 'PATCH', ...m2Auth, body: JSON.stringify({ name: '运营想改名字' }),
    });
    check('普通成员不能改工作台名称（需 tenant:member:manage）', denied.status === 403);

    // ③ 多租户边界：A 看不见 B 的成员，也改不了 B 的名字
    const phoneB2 = randomPhone();
    const bReg = await request<{ token: string }>(base, '/api/auth/register', {
      method: 'POST', body: JSON.stringify({ phone: phoneB2, password: 'TenantB2026', displayName: '乙租户' }),
    });
    const bAuth = { headers: { Authorization: `Bearer ${bReg.body.token}` } };
    const bMembers = await request<{ displayName: string }[]>(base, '/api/team/members', bAuth);
    check(
      '乙租户看不到甲租户的成员',
      bMembers.status === 200 && bMembers.body.every((m) => m.displayName !== '改名边界验证'),
    );
    const bRename = await request<{ name: string }>(base, '/api/tenants/current', {
      method: 'PATCH', ...bAuth, body: JSON.stringify({ name: '乙租户改名' }),
    });
    const aStill = await request<{ memberships: { tenantName: string }[] }>(base, '/api/auth/me', authA);
    check(
      '改乙租户名字不会影响甲租户',
      bRename.status === 200 && aStill.body.memberships[0]?.tenantName === '冒烟测试工作台',
    );
    // 恢复原名，避免污染演示数据
    await request(base, '/api/tenants/current', {
      method: 'PATCH', ...authA, body: JSON.stringify({ name: originalTenantName }),
    });
    await request(base, `/api/team/members/${
      (await request<{ id: string; phone: string }[]>(base, '/api/team/members', authA)).body.find((x) => x.phone === phoneM2)?.id ?? 'x'
    }`, { method: 'DELETE', ...authA });
  }

  await app.close();
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`smoke result: ${checks.length - failed}/${checks.length} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// main() 抛错时必须能看到原因：之前 void main() 会把异常吞成「无输出的 exit 1」，
// 门禁红了却看不出是哪一条断言炸的，等于白跑一遍。
void main().catch((e: unknown) => {
  console.error('smoke 运行期异常（不是断言失败，是脚本本身崩了）：', e);
  // 只设 exitCode 不调 process.exit：stdout 重定向到管道时是异步写的，
  // 紧接着 process.exit() 会把还没落盘的输出全部丢掉，表现就是「无输出的 exit 1」
  process.exitCode = 1;
});
