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
 * ComfyUI 本地 workflow 生图（官方 Server API：POST /prompt -> 轮询 GET /history/{id} -> GET /view 下载）。
 * 工作流 JSON 由用户在 ComfyUI「Workflow -> Export(API)」导出后放到 COMFYUI_WORKFLOW_PATH；
 * 提示词注入 COMFYUI_PROMPT_NODE（默认 6，CLIPTextEncode 正向），负向注入 COMFYUI_NEGATIVE_NODE（默认 7），
 * 尺寸写入 COMFYUI_LATENT_NODE（默认 5，EmptyLatentImage），随机种子写入 COMFYUI_SEED_NODE（默认 3，KSampler）。
 */
export async function generateViaComfyui(opts: {
  baseUrl: string;
  workflow: Record<string, unknown>;
  prompt: string;
  width: number;
  height: number;
  promptNode: string;
  negativeNode: string;
  latentNode: string;
  seedNode: string;
}): Promise<GeneratedImage> {
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }),
  });
  if (!submit.ok) {
    const errText = await submit.text().catch(() => '');
    throw new ServiceUnavailableException({ code: 'COMFYUI_SUBMIT_FAILED', message: `ComfyUI 提交失败：${errText.slice(0, 200)}` });
  }

  // 轮询 history 直到产出（最长 3 分钟）
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await fetch(`${opts.baseUrl}/history/${promptId}`).catch(() => null);
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
    const view = await fetch(`${opts.baseUrl}/view?${params.toString()}`);
    if (!view.ok) throw new ServiceUnavailableException({ code: 'COMFYUI_VIEW_FAILED', message: `ComfyUI 取图失败 ${view.status}` });
    const buffer = Buffer.from(await view.arrayBuffer());
    const ext = img.filename.split('.').pop()?.toLowerCase() ?? 'png';
    return { buffer, mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, ext };
  }
  logger.warn('ComfyUI 生成超时');
  throw new ServiceUnavailableException({ code: 'COMFYUI_TIMEOUT', message: 'ComfyUI 生成超时（本地机器首次加载大模型较慢，稍后重试）' });
}
