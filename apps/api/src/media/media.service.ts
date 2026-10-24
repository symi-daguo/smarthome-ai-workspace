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
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaService } from '../prisma/prisma.module.js';
import { TokenService } from '../billing/token.service.js';
import { ModelConfigService } from '../llm/model-config.service.js';
import { resolveChatModel, isTruncatedOutput } from '../llm/llm.service.js';
import { generateViaComfyui, generateViaMinimax, generateViaOpenai,
  generateViaOpenaiEdit, type GeneratedImage } from './image-provider.js';
import { generateViaMinimaxVideo, generateViaOpenaiVideo } from './video-provider.js';
import { fetchUpstream, UPSTREAM_TIMEOUT_MS } from '../common/upstream-timeout.js';

/**
 * 产物配额（字节）：UPLOAD_QUOTA_MB（MB）。
 *
 * 为什么放在这里而不是各端点各读一次 env：
 * 配额此前**只被读取用于报告**，没有任何写入路径比较过它 ——
 * 于是「配额」只是个好看的数字，反复上传就能把 uploads 卷写爆。
 * 现在上传闸门与 GET /api/admin/storage 共用这一份换算，报告与实际拦截不会漂移。
 */
export const DEFAULT_UPLOAD_QUOTA_MB = 4096;

/** 配额换算：env 值（MB）→ 字节。缺失/非法一律回落到默认值（与部署默认值一致）。 */
export function uploadQuotaBytes(rawMb: string | number | null | undefined): number {
  const mb = Number(rawMb ?? DEFAULT_UPLOAD_QUOTA_MB);
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_UPLOAD_QUOTA_MB * 1024 * 1024;
  return Math.floor(mb) * 1024 * 1024;
}

/** 体积统一按 MB 显示，一位小数。报告与错误提示共用，避免两处口径不同。 */
export function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 上传配额判定（纯函数，便于单独验证）。
 *
 * 两道闸门是**并存的**：单文件体积上限（控制器里的 multer limits）挡单个大文件，
 * 配额上限挡「反复上传把卷撑满」。两道都要留。
 *
 * 为什么上传不扣 token：上传不消耗模型算力，扣 token 会破坏「上传免费」的语义。
 * 这里只做配额校验，不做任何额度扣减。
 */
export function checkUploadQuota(
  usedBytes: number,
  incomingBytes: number,
  quotaBytes: number,
): { ok: true } | { ok: false; message: string } {
  const used = Math.max(0, usedBytes);
  const incoming = Math.max(0, incomingBytes);
  if (used + incoming <= quotaBytes) return { ok: true };
  return {
    ok: false,
    message:
      `存储配额已满：当前已用 ${formatMb(used)} / 配额 ${formatMb(quotaBytes)}，`
      + `本次上传还需 ${formatMb(incoming)}。`
      + '请先在「个人中心」清理未被引用的历史产物（POST /api/admin/storage/cleanup）后再上传。',
  };
}

/** 从引用路径里取 MediaAsset id：优先 /api/media/assets/<id>/file，其次路径里最后一段 uuid。 */
export function extractAssetIdFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const m = path.match(/\/api\/media\/assets\/([^/]+)\/file/);
  if (m) return m[1];
  const u = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return u ? u[0] : null;
}

/**
 * 「仍被引用、不能删」的素材集合（纯函数，便于单独验证）。
 *
 * **为什么必须收全**：清理工具（POST /api/admin/storage/cleanup）按「未被引用」决定删谁。
 * 少收一个字段 = 删掉仍在用的图 —— 方案页户型图裂了、交付包缺图、头像变空白。
 * 这里列的是**全部**存着 MediaAsset id 的地方（按 schema 逐条核对）：
 *   - planProject.floorplanAssetId / extraFloorplanAssetIds[] / renderAssetIds[]
 *     / renderedFloorplanAssetId / videoAssetIds[]
 *   - floorplanLayout.mediaAssetId
 *   - product.imageUrl（路径形态，取其中的 id）
 *   - lightingScene.sourceAssetId / videoAssetId
 *   - user.avatarUrl（路径形态，取其中的 id）
 * 数组字段（extraFloorplanAssetIds / renderAssetIds / videoAssetIds）是
 * Postgres 的 String[]，必须按「数组包含该 id」判断，不能当标量比。
 */
export interface AssetReferenceRows {
  plans: Array<{
    floorplanAssetId: string | null;
    extraFloorplanAssetIds: string[];
    renderAssetIds: string[];
    renderedFloorplanAssetId: string | null;
    videoAssetIds: string[];
  }>;
  layouts: Array<{ mediaAssetId: string }>;
  products: Array<{ imageUrl: string }>;
  lightingScenes: Array<{ sourceAssetId: string | null; videoAssetId: string | null }>;
  users: Array<{ avatarUrl: string }>;
}

export function collectReferencedAssetIds(rows: AssetReferenceRows): Set<string> {
  const out = new Set<string>();
  const add = (v: string | null | undefined): void => {
    if (v) out.add(v);
  };
  for (const p of rows.plans ?? []) {
    add(p.floorplanAssetId);
    add(p.renderedFloorplanAssetId);
    for (const id of p.extraFloorplanAssetIds ?? []) add(id);
    for (const id of p.renderAssetIds ?? []) add(id);
    for (const id of p.videoAssetIds ?? []) add(id);
  }
  for (const l of rows.layouts ?? []) add(l.mediaAssetId);
  for (const p of rows.products ?? []) add(extractAssetIdFromPath(p.imageUrl));
  for (const s of rows.lightingScenes ?? []) {
    add(s.sourceAssetId);
    add(s.videoAssetId);
  }
  for (const u of rows.users ?? []) add(extractAssetIdFromPath(u.avatarUrl));
  return out;
}

/** 卷内真实占用（字节）。口径说明见 MediaService.volumeUsage()。 */
export interface VolumeUsage {
  /** 卷内真实占用：产物 + 交付包 + 备份 + 孤儿文件 */
  usedBytes: number;
  /** MediaAsset 表记账的字节（只算有行的产物） */
  trackedBytes: number;
  /** 磁盘上产物目录的实际字节 */
  onDiskMediaBytes: number;
  /** 有文件、无 MediaAsset 行的孤儿字节（清理端点删不到，只会一直占着） */
  orphanBytes: number;
  /** 交付包字节（纯文件，不入库） */
  planPackageBytes: number;
  /** 全库备份字节（纯文件，不入库） */
  backupBytes: number;
  /** 卷内文件总数 */
  files: number;
}

/** 图片/视频生成代理：产物一律下载到本地 UPLOAD_DIR，前端只访问本地文件 */

/**
 * 给错误打上「额度已扣」的标记。
 *
 * 为什么需要：出图是「先扣额度、再调模型、再落库」，扣费之后的失败**不是**
 * 「没花钱的失败」。上层（画布作业）据此把状态记成 unknown（结果待核对）
 * 而不是 failed——笼统报「失败」会让用户以为没扣钱就再点一次，反而多扣一次。
 *
 * 用属性而不是改错误类型：错误要原样抛给上层和日志，不能为了加标记改变它的语义。
 */
export function markCharged(error: unknown): void {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      (error as { charged?: boolean }).charged = true;
    } catch {
      // 冻结对象等极端情况打不上标记就作罢，不影响主流程
    }
  }
}

/** 判断一个错误是否发生在扣额度之后 */
export function isChargedError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { charged?: boolean }).charged === true);
}


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

  /**
   * 产物配额上限（字节）。
   *
   * 与 GET /api/admin/storage 用的是同一个换算函数 —— 报告与实际拦截必须同源，
   * 否则会出现「面板显示还有空间、上传却被拒」这种没法解释的现象。
   */
  quotaBytes(): number {
    return uploadQuotaBytes(this.config.get<string>('UPLOAD_QUOTA_MB') ?? process.env.UPLOAD_QUOTA_MB);
  }

  /**
   * 该租户当前已用的产物字节（MediaAsset 记账口径）。
   *
   * 配额是**按租户**算的：租户之间互不影响，平台租户（platform）同样受这条约束，
   * 不给任何绕过口子 —— 否则单租户自部署等于没有上限。
   */
  async tenantUsedBytes(tenantId: string): Promise<number> {
    const agg = await this.prisma.mediaAsset.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } });
    return agg._sum.sizeBytes ?? 0;
  }

  /**
   * 上传前的配额闸门：超了直接抛 400，错误信息带具体数字与下一步动作。
   *
   * 为什么必须在**写文件之前**判：判晚了文件已经落盘，
   * 拒绝上传却留下垃圾文件，占用照涨、还得靠清理端点兜底。
   */
  async assertUploadWithinQuota(tenantId: string, incomingBytes: number): Promise<void> {
    const quotaBytes = this.quotaBytes();
    const usedBytes = await this.tenantUsedBytes(tenantId);
    const verdict = checkUploadQuota(usedBytes, incomingBytes, quotaBytes);
    if (!verdict.ok) throw new BadRequestException(verdict.message);
  }

  /**
   * 仍被引用的素材 id 集合（数据库侧收集，具体规则见 collectReferencedAssetIds）。
   *
   * 清理工具（POST /api/admin/storage/cleanup）靠它决定「谁不许删」。
   * 放在这里而不是控制器里，是为了让「引用关系」这件事只有一处定义：
   * 少收一个字段 = 删掉仍在用的图（方案户型图裂、交付包缺图、头像变空白）。
   */
  async referencedAssetIds(): Promise<Set<string>> {
    const [plans, layouts, products, lightingScenes, users] = await Promise.all([
      this.prisma.planProject.findMany({
        select: {
          floorplanAssetId: true,
          extraFloorplanAssetIds: true,
          renderAssetIds: true,
          renderedFloorplanAssetId: true,
          videoAssetIds: true,
        },
      }),
      this.prisma.floorplanLayout.findMany({ select: { mediaAssetId: true } }),
      this.prisma.product.findMany({ where: { active: true, imageUrl: { not: '' } }, select: { imageUrl: true } }),
      this.prisma.lightingScene.findMany({ select: { sourceAssetId: true, videoAssetId: true } }),
      this.prisma.user.findMany({ where: { avatarUrl: { not: '' } }, select: { avatarUrl: true } }),
    ]);
    return collectReferencedAssetIds({ plans, layouts, products, lightingScenes, users });
  }

  /**
   * 卷内真实占用（字节）。
   *
   * 为什么不能只报 MediaAsset.sizeBytes 之和：交付包（plan-packages）与全库备份（backups）
   * 是**纯文件不入库**，孤儿文件（有文件、无 MediaAsset 行）更是连表都没有 ——
   * 只统计入库行会把真实占用严重低估（实测 4.2MB vs 实际 314MB），
   * 面板说「才用了 4MB」，卷其实已经被写满。
   */
  async volumeUsage(): Promise<VolumeUsage> {
    const root = this.uploadDir();
    const agg = await this.prisma.mediaAsset.aggregate({ _sum: { sizeBytes: true } });
    const trackedBytes = agg._sum.sizeBytes ?? 0;
    const trackedPaths = new Set(
      (await this.prisma.mediaAsset.findMany({ select: { filePath: true } })).map((r) => r.filePath),
    );

    let onDiskMediaBytes = 0;
    let orphanBytes = 0;
    let planPackageBytes = 0;
    let backupBytes = 0;
    let files = 0;
    try {
      // recursive 读目录，返回相对 UPLOAD_DIR 的路径（与 MediaAsset.filePath 同一形态，可直接比对）
      const names = await readdir(root, { recursive: true });
      for (const raw of names) {
        // 统一成正斜杠：MediaAsset.filePath 存的是 'images/2026-10-06/x.jpg' 这种形态，
        // Windows 上 readdir 返回的是反斜杠，不归一就比不上，孤儿会被全量误判。
        const name = raw.split(sep).join('/');
        const abs = join(root, raw);
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(abs);
        } catch {
          continue; // 读不到（并发删除/权限）就跳过，不让统计整体失败
        }
        if (!st.isFile()) continue;
        files += 1;
        if (name.startsWith('plan-packages/')) planPackageBytes += st.size;
        else if (name.startsWith('backups/')) backupBytes += st.size;
        else {
          onDiskMediaBytes += st.size;
          // 有文件但库里没有对应行 = 孤儿（清理端点删不到它，会一直占着卷）
          if (!trackedPaths.has(name)) orphanBytes += st.size;
        }
      }
    } catch {
      // uploads 目录还不存在：全部按 0 计（首次启动的正常状态）
    }

    return {
      usedBytes: onDiskMediaBytes + planPackageBytes + backupBytes,
      trackedBytes,
      onDiskMediaBytes,
      orphanBytes,
      planPackageBytes,
      backupBytes,
      files,
    };
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
    /** 适配视频：统一 16:9 画幅 + 构图不裁切约束 */
    fitVideo?: boolean;
    /** 背景意图：transparent / white 追加到提示词，auto 不干预 */
    background?: 'auto' | 'transparent' | 'white';
    /** 局部重绘：原图资产 id + 遮罩 dataURL（二者需同时提供） */
    imageAssetId?: string;
    maskDataUrl?: string;
  /** 提交幂等键：命中已有产物直接返回，不重复出图也不重复扣额度 */
  clientRequestId?: string;
    title?: string;
  }): Promise<{ id: string; url: string; status: string; deduped?: boolean }> {
    const cfg = await this.modelConfig.imageConfig();
    // 校验在扣费前：key 缺失直接拒绝，不白扣额度（批量生图场景尤其重要）
    const apiKey = cfg.apiKey ?? '';
    if (cfg.provider !== 'comfyui' && !apiKey) {
      throw new ServiceUnavailableException({
        code: 'IMAGE_KEY_MISSING',
        message: cfg.provider === 'openai' ? '生图 API Key 未配置（provider=openai），请在「模型配置」页填写' : '生图 API Key 未配置，请在「模型配置」页填写 MiniMax Key',
      });
    }

    // 幂等：同一提交键直接返回已有产物。放在所有扣费之前——
    // 弱网超时后重试、跨标签页重复提交，靠这里避免第二次出图 + 第二次扣额度。
    // 按租户查，避免撞上别的租户恰好用了同一个键。
    if (opts.clientRequestId) {
      const existing = await this.prisma.mediaAsset.findFirst({
        where: { tenantId: opts.tenantId, clientRequestId: opts.clientRequestId },
      });
      if (existing) {
        return { id: existing.id, url: `/api/media/assets/${existing.id}/file`, status: existing.status, deduped: true };
      }
    }

    // 两个参数在此转成「真实生效的输入」，而不是透传给上游却不生效：
    // 1) 适配视频 -> 画幅强制 16:9，并在提示词声明保持原图构图
    // 2) 背景 -> 写进提示词约束（模型无独立背景参数时，这是唯一可靠通道）
    // 注：实际使用的生图模型统一取自「模型配置」页，不再由前端选择
    // （原前端 pro/fast 下拉对结果毫无影响，是假控件，已移除）。
    const size = opts.fitVideo ? '1536x1024' : opts.size;
    const bgHint =
      opts.background === 'transparent'
        ? '，背景为完全透明、无任何投影与地面'
        : opts.background === 'white'
          ? '，背景为纯白无杂色，主体边缘干净'
          : '';
    const fitHint = opts.fitVideo ? '，严格保持参考图构图与主体位置，画面边缘自然过渡不被硬裁切' : '';
    const prompt = `${opts.prompt}${bgHint}${fitHint}`;

    // 局部重绘的入参与能力校验放在扣费**之前**（同上面 KEY_MISSING 的理由）：
    // 参数不全或通道不支持而被拒绝的请求，不该让用户白扣额度。
    // 查证 MiniMax 官方 /v1/image_generation 的请求 schema（platform.minimax.io/docs/api-reference/image-generation-i2i）：
    // 只有 model / prompt / subject_reference / aspect_ratio / width / height / response_format / seed / n /
    // prompt_optimizer，**没有 mask、没有 inpainting 区域、没有 denoise 强度**。
    // subject_reference 是「参考图主体一致性」（type=character，用于保持人物特征），
    // 拿它冒充遮罩重绘会让用户以为圈选生效、实际整张重画——这正是这里要避免的。
    // 所以：没有 mask 语义的 provider 明确拒绝，而不是静默降级。
    let editInput: { image: Buffer; mime: string; mask: Buffer } | null = null;
    if (opts.maskDataUrl || opts.imageAssetId) {
      // 参数完整性先于能力判断：只给一半是请求错误（400），不是能力不支持（503）
      if (!opts.imageAssetId || !opts.maskDataUrl) {
        throw new BadRequestException('局部重绘需要同时提供原图（imageAssetId）与遮罩（maskDataUrl）');
      }
      if (cfg.provider !== 'openai') {
        const why =
          cfg.provider === 'minimax'
            ? 'MiniMax 的图像生成接口只有「参考图（subject_reference）」，没有 mask / 遮罩区域参数'
            : `provider=${cfg.provider} 没有实现遮罩重绘`;
        throw new ServiceUnavailableException({
          code: 'IMAGE_EDIT_UNSUPPORTED',
          message: `当前出图通道（${cfg.provider}）不支持按遮罩局部重绘：${why}。`
            + '可行做法：① 在「模型配置」把生图切到 OpenAI 兼容端点后使用圈选；'
            + '② 或不用圈选，改在提示词里直接描述要改动的位置，让参考图模式重画整张。',
        });
      }
      const src = await this.prisma.mediaAsset.findFirst({ where: { id: opts.imageAssetId, tenantId: opts.tenantId } });
      if (!src || src.kind !== 'image') throw new BadRequestException('EDIT_SOURCE_NOT_FOUND');
      const srcBuf = await readFile(this.resolveSafe(src.filePath));
      const maskBuf = Buffer.from(opts.maskDataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (!maskBuf.length) throw new BadRequestException('INVALID_MASK');
      editInput = { image: srcBuf, mime: src.mimeType || 'image/png', mask: maskBuf };
    }

    await this.tokens.consume(opts.tenantId, IMAGE_TOKENS, 'CONSUME', { kind: 'image', prompt: opts.prompt.slice(0, 80) }, opts.userId);

    // 扣额度之后的任何失败都不是「没花钱的失败」。
    // 上层据此把作业标成 unknown（结果待核对）而不是 failed：
    // 笼统报「失败」会让用户以为没扣额度就再点一次，反而多扣一次。
    try {
      return await this.generateAndStore(opts, cfg, apiKey, prompt, size, editInput);
    } catch (error) {
      markCharged(error);
      throw error;
    }
  }

  /** 扣费之后的出图 + 落库。单独抽出便于上面统一标注「已扣费」。 */
  private async generateAndStore(
    // 类型直接取自源方法，将来给 generateImage 加字段，这里不会漂移
    opts: Parameters<MediaService['generateImage']>[0],
    cfg: Awaited<ReturnType<ModelConfigService['imageConfig']>>,
    apiKey: string,
    prompt: string,
    size: string,
    editInput: { image: Buffer; mime: string; mask: Buffer } | null,
  ): Promise<{ id: string; url: string; status: string }> {
    let img: GeneratedImage;

    if (editInput) {
      img = await generateViaOpenaiEdit({
        baseUrl: cfg.baseUrl,
        apiKey,
        model: cfg.model,
        prompt,
        size,
        image: editInput.image,
        imageMime: editInput.mime,
        mask: editInput.mask,
      });
    } else if (cfg.provider === 'comfyui') {
      img = await generateViaComfyui({
        baseUrl: cfg.comfyBaseUrl,
        apiKey: cfg.comfyApiKey,
        workflow: await this.loadComfyWorkflow(cfg.workflowPath),
        prompt,
        width: Number(size.split('x')[0]) || 1024,
        height: Number(size.split('x')[1]) || 1024,
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
        clientRequestId: opts.clientRequestId ?? null,
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
    /** 提交幂等键：与生图同一机制，命中直接返回已有视频 */
    clientRequestId?: string;
    title?: string;
  }): Promise<{ id: string; url: string; status: string; deduped?: boolean }> {
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

    // 幂等：与生图同一套，按租户查、扣费之前返回。
    // 视频单价高于图片，重复提交的直接代价更大，所以这里更不能漏。
    if (opts.clientRequestId) {
      const existing = await this.prisma.mediaAsset.findFirst({
        where: { tenantId: opts.tenantId, clientRequestId: opts.clientRequestId },
      });
      if (existing) {
        return { id: existing.id, url: `/api/media/assets/${existing.id}/file`, status: existing.status, deduped: true };
      }
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
        : await generateViaMinimaxVideo({
            baseUrl: vcfg.baseUrl,
            apiKey: vcfg.apiKey,
            model: vcfg.model,
            params,
            resolutionMap: VIDEO_RESOLUTION,
            ratioMap: VIDEO_ASPECT,
          });

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
        clientRequestId: opts.clientRequestId ?? null,
      },
    });
    return { id: asset.id, url: `/api/media/assets/${asset.id}/file`, status: 'ready' };
  }

  /** 用户上传本地图片（户型平面图等）：落盘 UPLOAD_DIR + 写 MediaAsset，复用 ?token= 文件流 */
  async uploadImage(tenantId: string, userId: string, file: { buffer: Buffer; mimeType: string }, title: string): Promise<{ id: string; url: string }> {
    if (!file?.buffer?.length) throw new BadRequestException('EMPTY_FILE');
    // 配额闸门：判在写盘之前。超配额直接 400，文件不落盘（否则拒了却留下垃圾，占用照涨）。
    // 注意这里**不扣 token** —— 上传不消耗模型算力，扣 token 会破坏「上传免费」的语义。
    await this.assertUploadWithinQuota(tenantId, file.buffer.length);
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
    // 模型名兜底口径与 llm.service 保持一致（resolveChatModel）：
    // 原来的 'multimodal-model' 是**编造的名字**，上游不认，发出去必然回
    // `unknown model 'multimodal-model'`，反推提示词功能等于 100% 不可用。
    const model = resolveChatModel(cfg.model, undefined);
    const system = [
      '你是资深 AI 绘画提示词工程师，擅长从一张室内参考图反推文生图提示词。',
      '输出一段 120-260 字的中文画面描述，必须覆盖：空间类型与布局、整体风格、主色调与色温、',
      '构图与镜头视角、主要材质、灯光氛围（智能灯具要点出灯具形态/亮度/光色）、画面真实感要求。',
      '只输出描述本身，不要标题、不要分点、不要解释。',
    ].join('');
    const dataUri = `data:${asset.mimeType};base64,${buf.toString('base64')}`;

    const res = await fetchUpstream(
      `${cfg.baseUrl}/chat/completions`,
      {
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
          // 8000 是实测值，不是拍的：同一条多模态反推请求直连上游对比
          //   max_tokens=600  → finish_reason=length，completion=600 里 reasoning=599，正文长度 0（功能 100% 不可用）
          //   max_tokens=4000 → finish_reason=length，reasoning=3297，正文 1951 但末尾代码块未闭合（仍被截断）
          //   max_tokens=8000 → finish_reason=stop，reasoning=2941，正文 3319 字 ✅
          //   max_tokens=16000→ finish_reason=stop，reasoning=2645，正文 3117 字 ✅（与 8000 同等效果，白花预算）
          // 关键：**思考 token 也占 max_tokens 预算**，600 全被思考吃掉，正文一个字都没吐。
          max_tokens: 8000,
        }),
      },
      UPSTREAM_TIMEOUT_MS.llm,
      'LLM',
      '图片反推提示词',
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`反推提示词失败 ${res.status}: ${body.slice(0, 200)}`);
      throw new ServiceUnavailableException({
        code: 'VISION_UNSUPPORTED',
        message: `当前对话模型不支持图片理解或调用失败（HTTP ${res.status}），请在模型配置中换成多模态视觉模型；也可以直接手写提示词`,
        upstream: body.slice(0, 200),
      });
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      model?: string;
      usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const prompt = (data.choices?.[0]?.message?.content ?? '').replace(/[\s\S]*?<\/think>\s*/g, '').trim();
    // 预算被思考吃光（正文一个字都没吐）与「模型没听话」处置完全不同：
    // 前者要调大 max_tokens，后者要改提示词 —— 判据必须能一眼分开。
    // 这条链路自己直连 fetchUpstream、不走 LlmService.chat()，所以 llm.service 里那道保护覆盖不到，
    // 这里复用**同一个纯函数**（两处各写一遍正则口径，早晚会长歪）。
    const finishReason = data.choices?.[0]?.finish_reason ?? 'unknown';
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    if (isTruncatedOutput(finishReason, prompt)) {
      throw new ServiceUnavailableException({
        code: 'LLM_OUTPUT_TRUNCATED',
        message: `模型输出被 max_tokens 预算截断，正文为空（思考 token 用了 ${reasoningTokens}/${completionTokens}）。`
          + '该功能已按实测把预算调到 8000；若仍被截断，请在「模型配置」页换成思考更省的多模态模型，或直接手写提示词。',
        usage: { completionTokens, reasoningTokens },
      });
    }
    if (prompt.length < 10) throw new ServiceUnavailableException({ code: 'VISION_EMPTY', message: '模型未返回有效描述，请重试或手写提示词' });
    await this.tokens.consume(tenantId, 10, 'CONSUME', { kind: 'image-reverse-prompt' }, userId).catch(() => undefined);
    return { prompt, model: data.model ?? model };
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
   *
   * 引用保护必须用唯一真源（referencedAssetIds）：原来这里只查「启用产品 imageUrl」，
   * 漏掉方案户型图、渲染图、交付包、灯光场景源图、用户头像 ——
   * 删掉其中任何一个，方案当场裂图，而接口当时还返回成功，用户以为删干净了。
   */
  async deleteAsset(tenantId: string, id: string): Promise<{ id: string }> {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id, tenantId } });
    if (!asset) throw new NotFoundException('ASSET_NOT_FOUND');
    const referenced = await this.referencedAssetIds();
    if (referenced.has(id)) {
      throw new BadRequestException({
        code: 'ASSET_REFUSED_BY_REFERENCE',
        message:
          '该产物正被引用（方案户型图 / 渲染图 / 交付包 / 灯光场景 / 用户头像 / 启用产品图），'
          + '删除会让引用处当场裂图，请先解除引用再删。',
      });
    }
    try {
      await unlink(this.resolveSafe(asset.filePath));
    } catch {
      // 文件已不存在，照常删行
    }
    await this.prisma.mediaAsset.delete({ where: { id } });
    return { id };
  }

  /** 视频素材上传（与图片上传分离，体积与类型各自独立） */
  async uploadVideo(tenantId: string, userId: string, file: { buffer: Buffer; mimeType: string }, title: string): Promise<{ id: string; url: string }> {
    if (!file?.buffer?.length) throw new BadRequestException('EMPTY_FILE');
    // 配额闸门：与图片上传同一条路径，同样在写盘之前判、同样不扣 token。
    // 视频单文件上限 100MB，比图片大一个量级，更需要这道闸门兜底。
    await this.assertUploadWithinQuota(tenantId, file.buffer.length);
    const mime = file.mimeType || 'video/mp4';
    const ext = mime.includes('webm') ? 'webm' : mime.includes('quicktime') ? 'mov' : 'mp4';
    const rel = `uploads/${this.dayDir()}/${randomUUID()}.${ext}`;
    const abs = join(this.uploadDir(), rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, file.buffer);
    const asset = await this.prisma.mediaAsset.create({
      data: {
        tenantId,
        userId,
        kind: 'video',
        title: title.trim().slice(0, 60) || '上传视频',
        prompt: '',
        filePath: rel,
        mimeType: mime,
        sizeBytes: file.buffer.length,
        status: 'ready',
      },
    });
    return { id: asset.id, url: `/api/media/assets/${asset.id}/file` };
  }
}
