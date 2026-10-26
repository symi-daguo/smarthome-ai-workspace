/**
 * 「方案页型配图」端点的断言。
 *
 * 为什么单独成文件：smoke.ts 里还有其他并行任务在加断言，
 * 同一个文件同时编辑会互相覆盖。拆成独立模块，由 smoke.ts 一行 import + 一行调用挂接。
 *
 * 覆盖三条主线：
 *   1. 写入 → 读取 → 清除（正常路径，且清除后不留垃圾行）；
 *   2. **跨租户引用被拒**（A 的素材不能写进 B 的配置，反之亦然）——
 *      这是本功能唯一真正的安全边界，漏了就是数据泄露；
 *   3. 入参校验（非法 uuid / 不存在的素材 / 非法页型都要被明确拒绝，而不是 500）。
 */
export interface PlanPageImagesSmokeContext {
  /** 与 smoke.ts 的 check() 同签名：登记一条断言并计入总条数 */
  check: (name: string, ok: boolean, detail?: string) => void;
  /** 与 smoke.ts 的 request() 同签名 */
  request: <T>(base: string, path: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
  /** 被测服务地址 */
  base: string;
  /** A 租户（正常操作方）的鉴权头 */
  authA: { headers: { Authorization: string } };
  /** B 租户（越权方）的鉴权头 */
  authB: { headers: { Authorization: string } };
}

interface PageImageEntry {
  mediaAssetId: string;
  url: string;
}

/** 一个像样的 PNG 头（服务端只校验 mimeType，不解析图片内容） */
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * 上传一张图并拿到素材 id。
 *
 * 刻意走真实的 multipart 上传端点（POST /api/media/uploads）：
 * 配图最终引用的就是 MediaAsset，只有真的传上去过，
 * 「素材存在且属于本租户」这条前提才是真的。
 */
async function uploadImage(
  base: string,
  token: string,
  title: string,
): Promise<{ id: string; url: string } | null> {
  const fd = new FormData();
  fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'page-image.png');
  fd.append('title', title);
  const res = await fetch(`${base}/api/media/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) return null;
  return (await res.json()) as { id: string; url: string };
}

/**
 * 跑页型配图相关的断言。
 */
export async function assertPlanPageImagesAssertions(ctx: PlanPageImagesSmokeContext): Promise<void> {
  const { check, request, base, authA, authB } = ctx;
  const path = '/api/plans/page-images';

  const tokenA = authA.headers.Authorization.replace(/^Bearer\s+/, '');
  const tokenB = authB.headers.Authorization.replace(/^Bearer\s+/, '');

  // ---------- 迁移前置检查 ----------
  // 表不存在时端点会 500，后续每一条断言都会以同样面貌失败（看不出真实原因）。
  // 这里先探一次，把「缺迁移」这件事单独说清楚，然后不再往下跑 ——
  // 宁可少跑几条，也不要给出一堆看不懂的失败。
  const probe = await request<{ message?: string }>(base, path, authA);
  if (probe.status !== 200) {
    const detail = JSON.stringify(probe.body ?? '').slice(0, 200);
    const missingTable = detail.includes('PlanPageImage');
    check(
      '页型配图端点可用（缺 PlanPageImage 表时需先执行迁移 20261026153000_plan_page_image）',
      false,
      missingTable
        ? `数据库里没有 PlanPageImage 表 —— 请先执行 pnpm --filter @app/api prisma:deploy（${detail}）`
        : `status=${probe.status} body=${detail}`,
    );
    return;
  }
  check('页型配图端点可用（GET 返回 200）', true);

  // ---------- 准备：上传两张素材（A 租户）----------
  const asset1 = await uploadImage(base, tokenA, '页型配图冒烟图1');
  const asset2 = await uploadImage(base, tokenA, '页型配图冒烟图2');
  check('A 上传页型配图素材成功', Boolean(asset1?.id) && Boolean(asset2?.id), `asset1=${asset1?.id ?? ''}`);
  if (!asset1?.id || !asset2?.id) return;

  try {
    // ---------- 读：没配过时是空对象 ----------
    const empty = await request<Record<string, PageImageEntry>>(base, path, authA);
    check(
      '未配置时读取页型配图返回空映射（没配过的页型不出现）',
      empty.status === 200 && Object.keys(empty.body ?? {}).length === 0,
      `status=${empty.status} body=${JSON.stringify(empty.body).slice(0, 200)}`,
    );

    // ---------- 写：PUT 保存某页型的配图 ----------
    const put = await request<PageImageEntry>(base, `${path}/floorplan`, {
      ...authA,
      method: 'PUT',
      body: JSON.stringify({ mediaAssetId: asset1.id }),
    });
    check(
      '写入页型配图成功（PUT /page-images/floorplan）',
      put.status === 200 && put.body?.mediaAssetId === asset1.id,
      `status=${put.status} body=${JSON.stringify(put.body).slice(0, 200)}`,
    );

    // ---------- 读：能读回来，url 与素材同源 ----------
    const got = await request<Record<string, PageImageEntry>>(base, path, authA);
    check(
      '读回页型配图：mediaAssetId 与写入一致且带 url',
      got.status === 200
        && got.body?.floorplan?.mediaAssetId === asset1.id
        && typeof got.body?.floorplan?.url === 'string'
        && got.body.floorplan.url.includes(asset1.id),
      `status=${got.status} body=${JSON.stringify(got.body).slice(0, 200)}`,
    );

    // ---------- 写：重复 PUT 是覆盖，不是新增第二条 ----------
    const put2 = await request<PageImageEntry>(base, `${path}/floorplan`, {
      ...authA,
      method: 'PUT',
      body: JSON.stringify({ mediaAssetId: asset2.id }),
    });
    const got2 = await request<Record<string, PageImageEntry>>(base, path, authA);
    check(
      '重复写入同一页型是覆盖（一个租户一个页型只留一条）',
      put2.status === 200
        && got2.status === 200
        && got2.body?.floorplan?.mediaAssetId === asset2.id
        && Object.keys(got2.body ?? {}).length === 1,
      `status=${put2.status} body=${JSON.stringify(got2.body).slice(0, 200)}`,
    );

    // ---------- 安全边界：B 不能引用 A 的素材 ----------
    const cross = await request(base, `${path}/floorplan`, {
      ...authB,
      method: 'PUT',
      body: JSON.stringify({ mediaAssetId: asset1.id }),
    });
    check(
      '跨租户引用素材被拒（B 用 A 的素材写配置 → 404）',
      cross.status === 404,
      `status=${cross.status}`,
    );

    // ---------- 租户隔离：B 读不到 A 配的页型 ----------
    const bView = await request<Record<string, PageImageEntry>>(base, path, authB);
    check(
      '租户隔离：B 读不到 A 配的页型',
      bView.status === 200 && !Object.prototype.hasOwnProperty.call(bView.body ?? {}, 'floorplan'),
      `status=${bView.status} body=${JSON.stringify(bView.body).slice(0, 200)}`,
    );

    // ---------- 入参校验 ----------
    const badUuid = await request(base, `${path}/floorplan`, {
      ...authA,
      method: 'PUT',
      body: JSON.stringify({ mediaAssetId: 'not-a-uuid' }),
    });
    check('素材 id 非法被拒（400）', badUuid.status === 400, `status=${badUuid.status}`);

    const missingAsset = await request(base, `${path}/floorplan`, {
      ...authA,
      method: 'PUT',
      body: JSON.stringify({ mediaAssetId: '00000000-0000-0000-0000-000000000000' }),
    });
    check('素材不存在被拒（404，不是 500）', missingAsset.status === 404, `status=${missingAsset.status}`);

    const badPageType = await request(base, `${path}/Bad-Type`, {
      ...authA,
      method: 'PUT',
      body: JSON.stringify({ mediaAssetId: asset1.id }),
    });
    check('页型标识非法被拒（400）', badPageType.status === 400, `status=${badPageType.status}`);

    // ---------- 引用保护：被页型配图引用的素材不能直接删 ----------
    // 删了它，门店配的页型图当场裂开（导出 PPT 时那页变成空白）。
    const delRefused = await request(base, `/api/media/assets/${asset2.id}`, { ...authA, method: 'DELETE' });
    check(
      '被页型配图引用的素材不可删（400，删了当场裂图）',
      delRefused.status === 400,
      `status=${delRefused.status}`,
    );

    // ---------- 删：清除后该页型消失，回到兜底图 ----------
    const del = await request(base, `${path}/floorplan`, { ...authA, method: 'DELETE' });
    const afterDel = await request<Record<string, PageImageEntry>>(base, path, authA);
    check(
      '清除页型配图成功且该页型消失（回到默认图）',
      del.status === 200
        && afterDel.status === 200
        && !Object.prototype.hasOwnProperty.call(afterDel.body ?? {}, 'floorplan'),
      `status=${del.status} body=${JSON.stringify(afterDel.body).slice(0, 200)}`,
    );

    // ---------- 幂等：没配过时再删一次不报错、不留垃圾行 ----------
    const delAgain = await request(base, `${path}/floorplan`, { ...authA, method: 'DELETE' });
    const finalView = await request<Record<string, PageImageEntry>>(base, path, authA);
    check(
      '清除是幂等的（没配过时再删一次仍成功，且不留垃圾行）',
      delAgain.status === 200 && finalView.status === 200 && Object.keys(finalView.body ?? {}).length === 0,
      `status=${delAgain.status} body=${JSON.stringify(finalView.body).slice(0, 200)}`,
    );
  } finally {
    // 清理顺序要紧：**先解除引用再删素材**。
    // 素材被页型配图引用时删除会被引用保护挡下（400），先删素材就会留下垃圾行与孤儿文件。
    await request(base, `${path}/floorplan`, { ...authA, method: 'DELETE' });
    await request(base, `/api/media/assets/${asset1.id}`, { ...authA, method: 'DELETE' });
    await request(base, `/api/media/assets/${asset2.id}`, { ...authA, method: 'DELETE' });
  }
}
