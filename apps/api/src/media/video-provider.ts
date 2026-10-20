import { Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * 生视频 provider 适配层：
 *   VIDEO_PROVIDER=minimax（默认，T2V/I2V-01-Director）| openai（Sora 2 videos API / 兼容网关）
 * 统一返回视频 Buffer，由 MediaService 落盘。
 */
const logger = new Logger('VideoProvider');

export interface GeneratedVideo {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

export interface VideoGenParams {
  prompt: string;
  /** 秒数（字符串，如 "5"） */
  duration: string;
  /** 480 | 720 | 1080 */
  resolution: string;
  /** 16:9 | 9:16 | 1:1 */
  ratio: string;
  /** 首帧图 data URL（可选，图生视频） */
  firstFrameImage?: string;
}

/**
 * 视频模型名解析（抽成纯函数，便于直接断言，避免只能靠真实调用来验证）。
 *
 * 回归背景：曾经这里写死 `first_frame_image ? 'I2V-01-Director' : 'T2V-01-Director'`，
 * 用户在「模型配置」页填的视频模型被静默丢弃——配置页显示已保存，实际请求永远发旧模型。
 * 判定标准：配置了就必须原样下发；只有留空/纯空白才回落到第一代默认模型。
 */
export function resolveMinimaxVideoModel(configured: string | undefined, hasFirstFrame: boolean): string {
  const c = (configured ?? '').trim();
  if (c) return c;
  return hasFirstFrame ? 'I2V-01-Director' : 'T2V-01-Director';
}

/**
 * MiniMax 视频生成：提交 video_generation -> 轮询 query -> files/retrieve 取下载地址
 *
 * 换新模型后如果参数枚举不同（如 H3 的分辨率/时长档位），以上游返回的错误为准，不在这里猜。
 */
export async function generateViaMinimaxVideo(opts: {
  baseUrl: string;
  apiKey: string;
  /** 用户在「模型配置」页指定的视频模型名；留空则按有无首帧自动选 */
  model?: string;
  params: VideoGenParams;
  resolutionMap: Record<string, string>;
  ratioMap: Record<string, string>;
}): Promise<GeneratedVideo> {
  const { baseUrl, apiKey, params } = opts;
  const configured = (opts.model ?? '').trim();
  const model = resolveMinimaxVideoModel(opts.model, Boolean(params.firstFrameImage));
  if (!configured) {
    logger.log(`未指定视频模型，按${params.firstFrameImage ? '首帧图生' : '文生'}视频使用默认模型 ${model}`);
  } else {
    logger.log(`使用配置的视频模型 ${model}`);
  }
  const submit = await fetch(`${baseUrl}/video_generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      prompt: params.prompt,
      ...(params.firstFrameImage ? { first_frame_image: params.firstFrameImage } : {}),
      duration: Number(params.duration),
      resolution: opts.resolutionMap[params.resolution] ?? '720P',
      fps: 24,
      aspect_ratio: opts.ratioMap[params.ratio] ?? '16:9',
    }),
  });
  const submitData = (await submit.json().catch(() => null)) as {
    task_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  } | null;
  const taskId = submitData?.task_id;
  if (!submit.ok || !taskId) {
    const msg = submitData?.base_resp?.status_msg ?? `HTTP ${submit.status}`;
    logger.warn(`video_generation 提交失败: ${msg}`);
    throw new ServiceUnavailableException({ code: 'VIDEO_SUBMIT_FAILED', message: `视频任务提交失败：${msg}` });
  }

  // 轮询：最长约 5 分钟
  let fileUrl = '';
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    const q = await fetch(`${baseUrl}/query/video_generation?task_id=${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const qd = (await q.json().catch(() => null)) as {
      status?: string;
      file_id?: string | number;
      base_resp?: { status_msg?: string };
    } | null;
    if (qd?.status === 'Success' && qd.file_id) {
      const f = await fetch(`${baseUrl}/files/retrieve?file_id=${qd.file_id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const fd = (await f.json().catch(() => null)) as { file?: { download_url?: string } } | null;
      fileUrl = fd?.file?.download_url ?? '';
      break;
    }
    if (qd?.status === 'Fail') {
      throw new ServiceUnavailableException({ code: 'VIDEO_GEN_FAILED', message: '视频这次没生成出来，过一会儿再试一次' });
    }
  }
  if (!fileUrl) throw new ServiceUnavailableException({ code: 'VIDEO_TIMEOUT', message: '视频生成超时，任务仍在后台处理' });

  const dl = await fetch(fileUrl);
  if (!dl.ok) throw new ServiceUnavailableException({ code: 'ASSET_DOWNLOAD_FAILED', message: `视频下载失败 ${dl.status}` });
  return { buffer: Buffer.from(await dl.arrayBuffer()), mimeType: dl.headers.get('content-type') ?? 'video/mp4', ext: 'mp4' };
}

/** ratio+resolution -> Sora size 映射 */
function soraSize(resolution: string, ratio: string): string {
  const h = Number(resolution) || 720;
  if (ratio === '9:16') return `${Math.round((h * 9) / 16)}x${h}`;
  if (ratio === '1:1') return `${h}x${h}`;
  return `${Math.round((h * 16) / 9)}x${h}`;
}

/** OpenAI Sora 2 videos API：POST /videos -> 轮询 GET /videos/{id} -> GET /videos/{id}/content 下载 */
export async function generateViaOpenaiVideo(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  params: VideoGenParams;
}): Promise<GeneratedVideo> {
  const { baseUrl, apiKey, model, params } = opts;
  const submit = await fetch(`${baseUrl}/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      prompt: params.prompt,
      seconds: String(Number(params.duration) || 4),
      size: soraSize(params.resolution, params.ratio),
    }),
  });
  const created = (await submit.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
  if (!submit.ok || !created?.id) {
    const msg = created?.error?.message ?? `HTTP ${submit.status}`;
    logger.warn(`sora videos 提交失败: ${msg}`);
    throw new ServiceUnavailableException({ code: 'VIDEO_SUBMIT_FAILED', message: `视频任务提交失败：${msg}` });
  }

  // 轮询任务状态：最长约 8 分钟
  for (let i = 0; i < 96; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const q = await fetch(`${baseUrl}/videos/${created.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const job = (await q.json().catch(() => null)) as { status?: string; error?: { message?: string } } | null;
    if (job?.status === 'completed') break;
    if (job?.status === 'failed') {
      throw new ServiceUnavailableException({ code: 'VIDEO_GEN_FAILED', message: `视频生成失败：${job.error?.message ?? '未知原因'}` });
    }
    if (i === 95) throw new ServiceUnavailableException({ code: 'VIDEO_TIMEOUT', message: '视频生成超时，任务仍在后台处理' });
  }

  const content = await fetch(`${baseUrl}/videos/${created.id}/content`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!content.ok) throw new ServiceUnavailableException({ code: 'ASSET_DOWNLOAD_FAILED', message: `视频下载失败 ${content.status}` });
  return { buffer: Buffer.from(await content.arrayBuffer()), mimeType: content.headers.get('content-type') ?? 'video/mp4', ext: 'mp4' };
}
