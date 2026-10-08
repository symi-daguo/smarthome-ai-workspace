import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.module.js';
import { TokenService } from '../billing/token.service.js';
import { ModelConfigService } from '../llm/model-config.service.js';
import { generateViaComfyui, generateViaMinimax, generateViaOpenai, type GeneratedImage } from './image-provider.js';
import { generateViaMinimaxVideo, generateViaOpenaiVideo } from './video-provider.js';

/** 图片/视频生成代理：产物一律下载到本地 UPLOAD_DIR，前端只访问本地文件 */

// 扣费额度 env 可配（自部署用户按自己的模型成本调整；默认值仅为演示口径）
const IMAGE_TOKENS = Number(process.env.BILLING_IMAGE_TOKENS ?? 300);
const VIDEO_TOKENS = Number(process.env.BILLING_VIDEO_TOKENS ?? 1500);
const IMAGE_ASPECT: Record<string, string> = {
  '1536x1024': '16:9',
  '1024x1536': '9:16',
  '1024x1024': '1:1',
};
const VIDEO_RESOLUTION: Record<string, string> = {
  '480': '480P',
  '720': '720P',
  '1080': '1080P',
};
const VIDEO_ASPECT: Record<string, string> = {
  '16:9': '16:9',
  '9:16': '9:16',
  '1:1': '1:1',
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly tokens: TokenService,
    private readonly modelConfig: ModelConfigService,
  ) {}

  private uploadDir(): string {
    return this.config.get<string>('UPLOAD_DIR', 'uploads');
  }

  /** 相对路径 -> 绝对路径，并阻止路径穿越 */
  resolveSafe(rel: string): string {
    const root = this.uploadDir();
    const abs = join(root, rel);
    if (!abs.startsWith(join(root))) throw new BadRequestException('BAD_PATH');
    return abs;
  }

  /** provider 返回的内存图片/视频写入本地卷 */
  private async saveBuffer(img: GeneratedImage, rel: string): Promise<{ sizeBytes: number; mimeType: string }> {
    if (img.buffer.length === 0) throw new ServiceUnavailableException('ASSET_EMPTY');
    const abs = join(this.uploadDir(), rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, img.buffer);
    return { sizeBytes: img.buffer.length, mimeType: img.mimeType };
  }

  private dayDir(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 文生图：扣额度 -> 按 IMAGE_PROVIDER 生成 -> 本地落盘 -> 写 MediaAsset */
  async generateImage(opts: {
    tenantId: string;
    userId: string;
    prompt: string;
    size: string;
    title?: string;
  }): Promise<{ id: string; url: string; status: string }> {
    await this.tokens.consume(opts.tenantId, IMAGE_TOKENS, 'CONSUME', { kind: 'image', prompt: opts.prompt.slice(0, 80) }, opts.userId);

    const cfg = await this.modelConfig.imageConfig();
    let img: GeneratedImage;
    if (cfg.provider === 'comfyui') {
      img = await generateViaComfyui({
        baseUrl: cfg.comfyBaseUrl,
        workflow: await this.loadComfyWorkflow(cfg.workflowPath),
        prompt: opts.prompt,
        width: Number(opts.size.split('x')[0]) || 1024,
        height: Number(opts.size.split('x')[1]) || 1024,
        promptNode: cfg.promptNode,
        negativeNode: cfg.negativeNode,
        latentNode: cfg.latentNode,
        seedNode: cfg.seedNode,
      });
    } else if (cfg.provider === 'openai') {
      if (!cfg.apiKey) {
        throw new ServiceUnavailableException({ code: 'IMAGE_KEY_MISSING', message: '生图 API Key 未配置（provider=openai），请在「模型配置」页填写' });
      }
      img = await generateViaOpenai({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        prompt: opts.prompt,
        size: opts.size,
      });
    } else {
      if (!cfg.apiKey) {
        throw new ServiceUnavailableException({ code: 'IMAGE_KEY_MISSING', message: '生图 API Key 未配置，请在「模型配置」页填写 MiniMax Key' });
      }
      img = await generateViaMinimax({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        prompt: opts.prompt,
        aspect: IMAGE_ASPECT[opts.size] ?? '16:9',
      });
    }

    const rel = `images/${this.dayDir()}/${randomUUID()}.${img.ext}`;
    const { sizeBytes, mimeType } = await this.saveBuffer(img, rel);

    const asset = await this.prisma.mediaAsset.create({
      data: {
        tenantId: opts.tenantId,
        userId: opts.userId,
        kind: 'image',
        title: opts.title?.trim() || opts.prompt.slice(0, 30),
        prompt: opts.prompt,
        filePath: rel,
        mimeType,
        sizeBytes,
        status: 'ready',
      },
    });
    return { id: asset.id, url: `/api/media/assets/${asset.id}/file`, status: 'ready' };
  }

  /** 读取用户导出的 ComfyUI API 格式工作流 JSON */
  private async loadComfyWorkflow(path: string): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new ServiceUnavailableException({
        code: 'COMFYUI_WORKFLOW_MISSING',
        message: `未找到 ComfyUI 工作流文件（COMFYUI_WORKFLOW_PATH=${path}）。请在 ComfyUI 中「Workflow → Export(API)」导出后放到该路径`,
      });
    }
  }

  /** 文生视频：扣额度 -> 提交任务 -> 轮询 -> 下载本地 -> 写 MediaAsset */
  async generateVideo(opts: {
    tenantId: string;
    userId: string;
    prompt: string;
    duration: string;
    resolution: string;
    ratio: string;
    firstFrameAssetId?: string;
    title?: string;
  }): Promise<{ id: string; url: string; status: string }> {
    // 首帧图：读取本地资产转 data URL，切换 I2V-01-Director（图生视频导演版，同支持运镜指令）
    // 先校验再扣额：资产无效时不应白扣额度
    let firstFrameImage = '';
    if (opts.firstFrameAssetId) {
      const asset = await this.prisma.mediaAsset.findFirst({
        where: { id: opts.firstFrameAssetId, tenantId: opts.tenantId },
      });
      if (!asset) throw new NotFoundException('FIRST_FRAME_NOT_FOUND');
      if (asset.kind !== 'image') throw new BadRequestException('FIRST_FRAME_MUST_BE_IMAGE');
      const buf = await readFile(this.resolveSafe(asset.filePath));
      firstFrameImage = `data:${asset.mimeType ?? 'image/jpeg'};base64,${buf.toString('base64')}`;
    }

    await this.tokens.consume(opts.tenantId, VIDEO_TOKENS, 'CONSUME', { kind: 'video', prompt: opts.prompt.slice(0, 80) }, opts.userId);

    const vcfg = await this.modelConfig.videoConfig();
    if (!vcfg.apiKey) {
      throw new ServiceUnavailableException({ code: 'LLM_KEY_MISSING', message: '生视频 API Key 未配置，请在「模型配置」页填写对应 provider 的 Key' });
    }
    const params = { prompt: opts.prompt, duration: opts.duration, resolution: opts.resolution, ratio: opts.ratio, firstFrameImage: firstFrameImage || undefined };
    const video =
      vcfg.provider === 'openai'
        ? await generateViaOpenaiVideo({ baseUrl: vcfg.baseUrl, apiKey: vcfg.apiKey, model: vcfg.model, params })
        : await generateViaMinimaxVideo({ baseUrl: vcfg.baseUrl, apiKey: vcfg.apiKey, params, resolutionMap: VIDEO_RESOLUTION, ratioMap: VIDEO_ASPECT });

    const rel = `videos/${this.dayDir()}/${randomUUID()}.${video.ext}`;
    const { sizeBytes, mimeType } = await this.saveBuffer({ buffer: video.buffer, mimeType: video.mimeType, ext: video.ext }, rel);

    const asset = await this.prisma.mediaAsset.create({
      data: {
        tenantId: opts.tenantId,
        userId: opts.userId,
        kind: 'video',
        title: opts.title?.trim() || opts.prompt.slice(0, 30),
        prompt: opts.prompt,
        filePath: rel,
        mimeType,
        sizeBytes,
        status: 'ready',
      },
    });
    return { id: asset.id, url: `/api/media/assets/${asset.id}/file`, status: 'ready' };
  }

  /** 用户上传本地图片（户型平面图等）：落盘 UPLOAD_DIR + 写 MediaAsset，复用 ?token= 文件流 */
  async uploadImage(tenantId: string, userId: string, file: { buffer: Buffer; mimeType: string }, title: string): Promise<{ id: string; url: string }> {
    if (!file?.buffer?.length) throw new BadRequestException('EMPTY_FILE');
    const ext = (file.mimeType ?? '').includes('png') ? 'png' : 'jpg';
    const rel = `uploads/${this.dayDir()}/${randomUUID()}.${ext}`;
    const abs = join(this.uploadDir(), rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, file.buffer);
    const asset = await this.prisma.mediaAsset.create({
      data: {
        tenantId,
        userId,
        kind: 'image',
        title: title.trim().slice(0, 60) || '上传图片',
        prompt: '',
        filePath: rel,
        mimeType: file.mimeType || `image/${ext}`,
        sizeBytes: file.buffer.length,
        status: 'ready',
      },
    });
    return { id: asset.id, url: `/api/media/assets/${asset.id}/file` };
  }

  /** 产物列表（按租户） */
  list(tenantId: string) {
    return this.prisma.mediaAsset.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async get(tenantId: string, id: string) {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id, tenantId } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    return asset;
  }

  /** 按 id 直查（公开分享页文件流用，无租户上下文） */
  async byId(id: string) {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    return asset;
  }

  /** 素材库购买：扣 ¥1（100 token），写入产物库（kind=material）作为已购买凭证 */
  async purchaseMaterial(tenantId: string, userId: string, key: string): Promise<{ url: string }> {
    const allowed = new Set(['m1', 'm2']);
    if (!allowed.has(key)) throw new BadRequestException('MATERIAL_NOT_FOUND');
    const dup = await this.prisma.mediaAsset.findFirst({
      where: { tenantId, kind: 'material', title: key },
    });
    if (!dup) {
      await this.tokens.consume(tenantId, 100, 'CONSUME', { kind: 'material', materialKey: key }, userId);
      await this.prisma.mediaAsset.create({
        data: {
          tenantId,
          userId,
          kind: 'material',
          title: key,
          prompt: '素材库购买',
          filePath: `images/materials/${key}.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: 0,
          status: 'ready',
        },
      });
    }
    return { url: `/images/materials/${key}.jpg` };
  }
}
