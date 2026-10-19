import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * 文生图 provider 适配层：
 *   IMAGE_PROVIDER=minimax（默认，MiniMax image-01）| openai（OpenAI images / 任意兼容网关）| comfyui（本地 ComfyUI workflow）
 * 统一返回图片 Buffer + mime，由 MediaService 落盘。
 */
const logger = new Logger('ImageProvider');

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

/** MiniMax image-01（response_format=url 后下载） */
export async function generateViaMinimax(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  aspect: string;
}): Promise<GeneratedImage> {
  const res = await fetch(`${opts.baseUrl}/image_generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: opts.model,
      prompt: opts.prompt,
      aspect_ratio: opts.aspect,
      response_format: 'url',
      n: 1,
    }),
  });
  const data = (await res.json().catch(() => null)) as {
    data?: { image_urls?: string[] };
    base_resp?: { status_code?: number; status_msg?: string };
  } | null;
  const remoteUrl = data?.data?.image_urls?.[0];
  if (!res.ok || !remoteUrl) {
    const msg = data?.base_resp?.status_msg ?? `HTTP ${res.status}`;
    throw new ServiceUnavailableException({ code: 'IMAGE_GEN_FAILED', message: `图片生成失败：${msg}` });
  }
  const imgRes = await fetch(remoteUrl);
  if (!imgRes.ok) throw new ServiceUnavailableException({ code: 'ASSET_DOWNLOAD_FAILED', message: `素材下载失败 ${imgRes.status}` });
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  return { buffer, mimeType: imgRes.headers.get('content-type') ?? 'image/jpeg', ext: 'jpg' };
}

/** OpenAI 兼容 images API（gpt-image-1 返回 b64_json；dall-e-3 兼容 data[].b64_json/url） */
export async function generateViaOpenai(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
}): Promise<GeneratedImage> {
  const res = await fetch(`${opts.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: opts.model,
      prompt: opts.prompt,
      n: 1,
      size: opts.size,
      response_format: 'b64_json',
    }),
  });
  const data = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string; url?: string }[];
    error?: { message?: string };
  } | null;
  const item = data?.data?.[0];
  if (!res.ok || !item) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    throw new ServiceUnavailableException({ code: 'IMAGE_GEN_FAILED', message: `图片生成失败：${msg}` });
  }
  if (item.b64_json) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png', ext: 'png' };
  }
  if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new ServiceUnavailableException({ code: 'ASSET_DOWNLOAD_FAILED', message: `素材下载失败 ${imgRes.status}` });
    return { buffer: Buffer.from(await imgRes.arrayBuffer()), mimeType: imgRes.headers.get('content-type') ?? 'image/png', ext: 'png' };
  }
  throw new ServiceUnavailableException({ code: 'IMAGE_GEN_FAILED', message: '图片生成返回空结果' });
}

/**
 * OpenAI 局部重绘（images/edits）
 *
 * 与 generateViaOpenai 的区别：走 multipart 而非 JSON，且必须同时带原图与 mask。
 * OpenAI 的约定是**mask 里透明(alph=0)的区域才会被重绘**，不透明区域保持原样——
 * 所以前端要把「用户涂选的区域」画成不透明、其余留透明。
 * 只在 provider=openai 时可用；其它 provider 走到这里会由 service 层提前拒绝。
 */
export async function generateViaOpenaiEdit(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
  image: Buffer;
  imageMime: string;
  mask: Buffer;
}): Promise<GeneratedImage> {
  const form = new FormData();
  form.append('model', opts.model);
  form.append('prompt', opts.prompt);
  form.append('n', '1');
  form.append('size', opts.size);
  // Buffer 的底层可能是 SharedArrayBuffer，与 BlobPart 的类型不兼容，显式转成 ArrayBuffer
  const toPart = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  form.append('image', new Blob([toPart(opts.image)], { type: opts.imageMime }), 'image.png');
  form.append('mask', new Blob([toPart(opts.mask)], { type: 'image/png' }), 'mask.png');

  const res = await fetch(`${opts.baseUrl}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
  });
  const data = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string; url?: string }[];
    error?: { message?: string };
  } | null;
  const item = data?.data?.[0];
  if (!res.ok || !item) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    throw new ServiceUnavailableException({ code: 'IMAGE_EDIT_FAILED', message: `局部重绘失败：${msg}` });
  }
  if (item.b64_json) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png', ext: 'png' };
  }
  if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new ServiceUnavailableException({ code: 'ASSET_DOWNLOAD_FAILED', message: `素材下载失败 ${imgRes.status}` });
    return { buffer: Buffer.from(await imgRes.arrayBuffer()), mimeType: imgRes.headers.get('content-type') ?? 'image/png', ext: 'png' };
  }
  throw new ServiceUnavailableException({ code: 'IMAGE_EDIT_FAILED', message: '局部重绘返回空结果' });
}

/** ComfyUI 三步调用共用请求头：云端实例（RunPod / autodl 反代 / 自建网关）需 Bearer，本地默认无鉴权 */
function comfyHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * ComfyUI workflow 生图（官方 Server API：POST /prompt -> 轮询 GET /history/{id} -> GET /view 下载）。
 * 同时支持**本机直连**（apiKey 留空）与**云端实例**（apiKey 作 Bearer token 三步全带）；
 * 云端反代常把工作流放在子路径下（https://host/proxy/8188），baseUrl 带子路径即可，无需额外配置。
 * 工作流 JSON 由用户在 ComfyUI「Workflow -> Export(API)」导出后放到 COMFYUI_WORKFLOW_PATH；
 * 提示词注入 COMFYUI_PROMPT_NODE（默认 6，CLIPTextEncode 正向），负向注入 COMFYUI_NEGATIVE_NODE（默认 7），
 * 尺寸写入 COMFYUI_LATENT_NODE（默认 5，EmptyLatentImage），随机种子写入 COMFYUI_SEED_NODE（默认 3，KSampler）。
 */
export async function generateViaComfyui(opts: {
  baseUrl: string;
  apiKey?: string;
  workflow: Record<string, unknown>;
  prompt: string;
  width: number;
  height: number;
  promptNode: string;
  negativeNode: string;
  latentNode: string;
  seedNode: string;
}): Promise<GeneratedImage> {
  const headers = comfyHeaders(opts.apiKey);
  const graph = structuredClone(opts.workflow) as Record<string, { inputs?: Record<string, unknown> }>;
  const setNode = (id: string, patch: Record<string, unknown>): void => {
    if (graph[id]?.inputs) Object.assign(graph[id].inputs as object, patch);
  };
  setNode(opts.promptNode, { text: opts.prompt });
  setNode(opts.negativeNode, { text: 'lowres, bad anatomy, watermark' });
  setNode(opts.latentNode, { width: opts.width, height: opts.height, batch_size: 1 });
  setNode(opts.seedNode, { seed: Math.floor(Math.random() * 2 ** 31) });

  const clientId = randomUUID();
  const promptId = randomUUID();
  const submit = await fetch(`${opts.baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }),
  });
  if (!submit.ok) {
    const errText = await submit.text().catch(() => '');
    if (submit.status === 401 || submit.status === 403) {
      throw new ServiceUnavailableException({ code: 'COMFYUI_UNAUTHORIZED', message: 'ComfyUI 拒绝认证（401/403）：云端实例需填 ComfyUI API Key' });
    }
    throw new ServiceUnavailableException({ code: 'COMFYUI_SUBMIT_FAILED', message: `ComfyUI 提交失败：${errText.slice(0, 200)}` });
  }

  // 轮询 history 直到产出（最长 3 分钟）
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await fetch(`${opts.baseUrl}/history/${promptId}`, { headers }).catch(() => null);
    if (!h?.ok) continue;
    const hist = (await h.json().catch(() => null)) as Record<
      string,
      { outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }> }
    > | null;
    const outputs = hist?.[promptId]?.outputs;
    const saved = outputs ? Object.values(outputs).flatMap((o) => o.images ?? []) : [];
    if (saved.length === 0) continue;
    const img = saved[0];
    const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
    const view = await fetch(`${opts.baseUrl}/view?${params.toString()}`, { headers });
    if (!view.ok) throw new ServiceUnavailableException({ code: 'COMFYUI_VIEW_FAILED', message: `ComfyUI 取图失败 ${view.status}` });
    const buffer = Buffer.from(await view.arrayBuffer());
    const ext = img.filename.split('.').pop()?.toLowerCase() ?? 'png';
    return { buffer, mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, ext };
  }
  logger.warn('ComfyUI 生成超时');
  throw new ServiceUnavailableException({ code: 'COMFYUI_TIMEOUT', message: 'ComfyUI 生成超时（本地机器首次加载大模型较慢，稍后重试）' });
}
