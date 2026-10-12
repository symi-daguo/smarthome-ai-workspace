import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const cfg = await this.modelConfig.imageConfig();
    // 校验在扣费前：key 缺失直接拒绝，不白扣额度（批量生图场景尤其重要）
    const apiKey = cfg.apiKey ?? '';
    if (cfg.provider !== 'comfyui' && !apiKey) {
      throw new ServiceUnavailableException({
        code: 'IMAGE_KEY_MISSING',
        message: cfg.provider === 'openai' ? '生图 API Key 未配置（provider=openai），请在「模型配置」页填写' : '生图 API Key 未配置，请在「模型配置」页填写 MiniMax Key',
      });
    }
    await this.tokens.consume(opts.tenantId, IMAGE_TOKENS, 'CONSUME', { kind: 'image', prompt: opts.prompt.slice(0, 80) }, opts.userId);

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
      img = await generateViaOpenai({
        baseUrl: cfg.baseUrl,
        apiKey,
        model: cfg.model,
        prompt: opts.prompt,
        size: opts.size,
      });
    } else {
      img = await generateViaMinimax({
        baseUrl: cfg.baseUrl,
        apiKey,
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

  /**
   * 解析 ComfyUI 工作流文件绝对路径（兼容三种运行形态）：
   * ① 用户显式配置（绝对路径或相对进程 CWD）；
   * ② 容器镜像：CWD=/repo，模板随 apps/api 拷贝在 /repo/apps/api/；
   * ③ 本地 dev：pnpm --filter @app/api 的 CWD=apps/api，模板就在 CWD 下；
   * 另兜底编译产物 dist/src/media（../../..）与源码 src/media（../../..）两个模块相对位置。
   */
  private resolveComfyWorkflowPath(configured: string): string | null {
    const base = basename(configured);
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(configured),
      join(process.cwd(), base),
      join(process.cwd(), 'apps', 'api', base),
      join(here, '..', '..', '..', base),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  private async loadComfyWorkflow(path: string): Promise<Record<string, unknown>> {
    const resolved = this.resolveComfyWorkflowPath(path);
    if (!resolved) {
      throw new ServiceUnavailableException({
        code: 'COMFYUI_WORKFLOW_MISSING',
        message: `未找到 ComfyUI 工作流文件（COMFYUI_WORKFLOW_PATH=${path}）。内置模板位于 apps/api/comfyui-workflow.json，或在 ComfyUI 中「Workflow → Export(API)」导出后放到该路径`,
      });
    }
    try {
      const raw = await readFile(resolved, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new ServiceUnavailableException({
        code: 'COMFYUI_WORKFLOW_INVALID',
        message: `ComfyUI 工作流文件不是合法 JSON：${resolved}`,
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

  /**
   * 文件流读取解析：本租户资产直接放行；
   * 公共产品图（被任一启用产品 imageUrl 引用）跨租户可读——公共库对所有租户展示，其产品图天然是公开资产
   */
  async resolveReadable(tenantId: string, id: string) {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id, tenantId } });
    if (asset) return asset;
    const referenced = await this.prisma.product.findFirst({ where: { active: true, imageUrl: { contains: id } } });
    if (referenced) return this.byId(id);
    throw new NotFoundException('ASSET_NOT_FOUND');
  }

  /** 按 id 直查（公开分享页文件流用，无租户上下文） */
  async byId(id: string) {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    return asset;
  }

  /**
   * 图片反推提示词：参考图 → 视觉模型 → 可直接喂给文生图的详细中文描述。
   * image-01 等纯文生图 provider 不支持图像输入，行业通用做法是先用视觉模型把画面的
   * 空间/风格/色调/构图/材质/灯光反推成提示词，再文生图，保证成图风格一致。
   */
  async reverseImagePrompt(tenantId: string, userId: string, assetId: string): Promise<{ prompt: string; model: string }> {
    const asset = await this.resolveReadable(tenantId, assetId);
    if (!asset.mimeType?.startsWith('image/')) throw new BadRequestException('ASSET_NOT_IMAGE');
    const buf = await readFile(this.resolveSafe(asset.filePath));
    if (buf.length > 8 * 1024 * 1024) throw new BadRequestException('IMAGE_TOO_LARGE');

    const cfg = await this.modelConfig.chatConfig();
    if (!cfg.apiKey) {
      throw new ServiceUnavailableException({
        code: 'LLM_KEY_MISSING',
        message: '对话模型（需支持图片理解的多模态模型）API Key 未配置，无法反推提示词',
      });
    }
    const model = cfg.model || 'multimodal-model';
    const system = [
      '你是资深 AI 绘画提示词工程师，擅长从一张室内参考图反推文生图提示词。',
      '输出一段 120-260 字的中文画面描述，必须覆盖：空间类型与布局、整体风格、主色调与色温、',
      '构图与镜头视角、主要材质、灯光氛围（智能灯具要点出灯具形态/亮度/光色）、画面真实感要求。',
      '只输出描述本身，不要标题、不要分点、不要解释。',
    ].join('');
    const dataUri = `data:${asset.mimeType};base64,${buf.toString('base64')}`;

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [
            { type: 'text', text: '请反推这张图的 AI 绘画提示词，用于生成相同风格的智能家居空间效果图。' },
            { type: 'image_url', image_url: { url: dataUri } },
          ] },
        ],
        temperature: 0.4,
        max_tokens: 600,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`反推提示词失败 ${res.status}: ${body.slice(0, 200)}`);
      throw new ServiceUnavailableException({
        code: 'VISION_UNSUPPORTED',
        message: `当前对话模型不支持图片理解或调用失败（HTTP ${res.status}），请在模型配置中换成多模态视觉模型；也可以直接手写提示词`,
        upstream: body.slice(0, 200),
      });
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
    const prompt = (data.choices?.[0]?.message?.content ?? '').replace(/[\s\S]*?<\/think>\s*/g, '').trim();
    if (prompt.length < 10) throw new ServiceUnavailableException({ code: 'VISION_EMPTY', message: '模型未返回有效描述，请重试或手写提示词' });
    await this.tokens.consume(tenantId, 10, 'CONSUME', { kind: 'image-reverse-prompt' }, userId).catch(() => undefined);
    return { prompt, model: data.model ?? model };
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

  /**
   * 重命名本租户的产物（最基本的修改能力）。
   * 公共产品图不可改——被任一启用产品 imageUrl 引用的页码反而会被产品中心管理走，ponytail: 复用 StorageCleanup 的引用解析思路，
   * 这里抛 400 ASSET_REFUSED 让前端给出明确提示。
   */
  async renameAsset(tenantId: string, id: string, title: string) {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id, tenantId } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    const referenced = await this.prisma.product.findFirst({ where: { active: true, imageUrl: { contains: id } } });
    if (referenced) throw new BadRequestException('ASSET_REFUSED_BY_PRODUCT');
    const updated = await this.prisma.mediaAsset.update({ where: { id }, data: { title } });
    return { id: updated.id, title: updated.title };
  }

  /**
   * 删除本租户产物：DB 行 + 本地文件一并清。
   * 公共产品图引用保护：与 StorageCleanup 同逻辑，被任一启用产品 imageUrl 引用的产物不可删。
   */
  async deleteAsset(tenantId: string, id: string): Promise<{ id: string }> {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id, tenantId } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    const referenced = await this.prisma.product.findFirst({ where: { active: true, imageUrl: { contains: id } } });
    if (referenced) throw new BadRequestException('ASSET_REFUSED_BY_PRODUCT');
    try {
      await unlink(this.resolveSafe(asset.filePath));
    } catch {
      // 文件已不存在，照常删行
    }
    await this.prisma.mediaAsset.delete({ where: { id } });
    return { id };
  }
}
