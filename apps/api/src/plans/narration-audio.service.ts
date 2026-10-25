import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 方案讲解音频：把讲稿文本合成成可播放的音频，供交付包与智能体取用。
 *
 * **为什么要做音频**：交付包里的讲稿是 Markdown 文本，客户拿到后还得自己念。
 * 门店给客户讲方案时，把音频推到有喇叭的设备（智能面板、背景音乐、中控屏），
 * 讲稿就变成了「能放出来的东西」，而不是一份要人盯着读的稿子。
 *
 * **为什么做成可插拔的**：工作台跑在容器里，容器内没有 macOS 的 `say`，
 * 也没有装 Piper —— 自己在镜像里塞一套语音引擎，等于给每个部署都加几十 MB
 * 与一份许可负担。所以合成能力放在**外部服务**（采集端已经带了三档 TTS 后端），
 * 工作台只持有一个地址；**没配就降级**（只出讲稿文本，不出音频），
 * 绝不因为「没有语音服务」就让整个交付包打不出来。
 *
 * **文本从哪来**：讲稿文本的唯一来源是前端（`buildNarrationText`），
 * 前端把**净化后**的讲稿文本传上来（净化掉「待客户确认现场条件」这类内部语句 ——
 * 讲解稿是直接发给客户的，带着内部话术会引发追问）。
 * 本服务不自己重建讲稿：**页序逻辑在前端**（含点位清单续页），
 * 服务端再实现一遍就是两份会漂移的真相。
 */

export interface NarrationAudio {
  /** 相对 UPLOAD_DIR 的路径（与 MediaAsset.filePath 同一形态） */
  filePath: string;
  /** 方案内可读名，例如 `我的方案-V3-讲解音频.wav` */
  fileName: string;
  bytes: number;
  mimeType: string;
  /** 音频时长（秒）。解析不出来时为 null */
  durationSec: number | null;
  /** 合成用的讲稿文本（已净化） */
  text: string;
  /** ISO 时间戳 */
  generatedAt: string;
}

/** WAV 文件头：RIFF....WAVE */
const RIFF = Buffer.from('RIFF');
const WAVE = Buffer.from('WAVE');

/**
 * 是不是一段像样的 WAV。
 *
 * 为什么要校验：合成服务的返回值完全在它手里，**我们无法假设它给了音频**。
 * 一个 200 字节的 JSON 错误页被当成音频存进交付包，客户点开发现播不出来，
 * 而且要等到交付现场才发现。宁可当场拒掉。
 */
export function isWavBuffer(buf: Buffer): boolean {
  return buf.length >= 44 && buf.subarray(0, 4).equals(RIFF) && buf.subarray(8, 12).equals(WAVE);
}

/**
 * 从 WAV 头算时长（秒）。
 *
 * 只认标准 PCM WAV：读 fmt 块的 byteRate 与 data 块长度。
 * 读不出来就返回 null —— 宁可不给时长，也不要给一个错的数字。
 */
export function wavDurationSeconds(buf: Buffer): number | null {
  if (!isWavBuffer(buf)) return null;
  // fmt 块：从第 12 字节开始找 'fmt '
  const fmtIdx = buf.indexOf(Buffer.from('fmt '), 12);
  if (fmtIdx < 0) return null;
  // fmt 块体第 8 个起是 byteRate（16-bit chunk size + 2 字节 format code + 2 字节声道 + 4 字节采样率）
  const byteRate = buf.readUInt32LE(fmtIdx + 16);
  if (!byteRate) return null;
  // data 块：找 'data' 再读其长度
  const dataIdx = buf.indexOf(Buffer.from('data'), fmtIdx);
  if (dataIdx < 0) return null;
  const dataLen = buf.readUInt32LE(dataIdx + 4);
  if (!dataLen) return null;
  return Math.round((dataLen / byteRate) * 100) / 100;
}

@Injectable()
export class NarrationAudioService {
  private readonly logger = new Logger(NarrationAudioService.name);

  constructor(private readonly config: ConfigService) {}

  /** 合成服务地址。没配就是「本部署不支持语音」，不是错误。 */
  private ttsUrl(): string {
    return (this.config.get<string>('NARRATION_TTS_URL') ?? '').trim();
  }

  private ttsToken(): string {
    return (this.config.get<string>('NARRATION_TTS_TOKEN') ?? '').trim();
  }

  private timeoutMs(): number {
    const raw = Number(this.config.get<string>('NARRATION_TTS_TIMEOUT_MS') ?? 60_000);
    return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
  }

  /** 本部署是否配了语音合成服务 */
  configured(): boolean {
    return this.ttsUrl().length > 0;
  }

  private dir(): string {
    return join(this.config.get<string>('UPLOAD_DIR', 'uploads'), 'narration');
  }

  private fileNameFor(planId: string, versionNo: number): string {
    return `${planId}-v${versionNo}.wav`;
  }

  /**
   * 调外部服务合成。
   *
   * 失败要**说清是哪一步失败**：地址没配、服务不可达、超时、返回的不是音频 ——
   * 这四种的处置完全不同（第一种是部署没做，第三种该重试，第四种是对方坏了）。
   */
  async synthesize(text: string): Promise<Buffer> {
    const url = this.ttsUrl();
    if (!url) throw new ServiceUnavailableException('NARRATION_TTS_NOT_CONFIGURED');
    const body = text.trim();
    if (!body) throw new ServiceUnavailableException('NARRATION_TEXT_EMPTY');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.ttsToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: body }),
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ServiceUnavailableException(`NARRATION_TTS_UNREACHABLE: ${msg}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new ServiceUnavailableException(`NARRATION_TTS_FAILED: ${res.status} ${detail}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isWavBuffer(buf)) {
      throw new ServiceUnavailableException('NARRATION_TTS_NOT_AUDIO');
    }
    return buf;
  }

  /**
   * 取（或生成）某个方案某一版的讲解音频。
   *
   * 同一版直接复用已存的文件：**方案每次改动都会 bump 版本号**，
   * 所以「同版本 = 同一份讲稿 = 同一段音频」，复用是安全的，也省掉一次合成。
   */
  async ensure(planId: string, versionNo: number, text: string, displayName: string): Promise<NarrationAudio> {
    const stored = this.fileNameFor(planId, versionNo);
    const abs = join(this.dir(), stored);
    let existing: Buffer | null = null;
    try {
      existing = await readFile(abs);
    } catch {
      existing = null;
    }
    const buf = existing && isWavBuffer(existing) ? existing : await this.synthesize(text);

    await mkdir(this.dir(), { recursive: true });
    await writeFile(abs, buf);
    // 只留当前版本的音频：方案改一次就多一份旧音频，不清就会慢慢堆起来
    await this.prune(planId, versionNo);

    return {
      filePath: `narration/${stored}`,
      fileName: `${displayName}-讲解音频.wav`,
      bytes: buf.length,
      mimeType: 'audio/wav',
      durationSec: wavDurationSeconds(buf),
      text,
      generatedAt: new Date().toISOString(),
    };
  }

  /** 读某个方案某一版已存的音频。没有就返回 null（不是错误：还没生成过而已） */
  async find(planId: string, versionNo: number, displayName = ''): Promise<NarrationAudio | null> {
    const stored = this.fileNameFor(planId, versionNo);
    const abs = join(this.dir(), stored);
    try {
      const st = await stat(abs);
      const buf = await readFile(abs);
      if (!isWavBuffer(buf)) return null;
      return {
        filePath: `narration/${stored}`,
        // 对外给可读名（方案名 + 版本），落盘名是给机器看的
        fileName: displayName ? `${displayName}-讲解音频.wav` : stored,
        bytes: st.size,
        mimeType: 'audio/wav',
        durationSec: wavDurationSeconds(buf),
        text: '',
        generatedAt: st.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  /** 读音频文件内容（给文件流端点用） */
  async read(planId: string, versionNo: number): Promise<Buffer | null> {
    const abs = join(this.dir(), this.fileNameFor(planId, versionNo));
    try {
      return await readFile(abs);
    } catch {
      return null;
    }
  }

  /** 只保留当前版本的音频，其余版本的删掉 */
  private async prune(planId: string, keepVersion: number): Promise<void> {
    const keep = this.fileNameFor(planId, keepVersion);
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith(`${planId}-v`) || n === keep) continue;
      await unlink(join(this.dir(), n)).catch(() => undefined);
    }
  }

  /**
   * 方案被删时清掉它的音频。
   *
   * 与交付包同理：音频是**纯文件、不入库**的，方案一删就没人认领，
   * 永久留在卷里。单份讲解音频按 20 页讲稿算约 1-3MB。
   */
  async removeByPlan(planId: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return 0;
    }
    let removed = 0;
    for (const n of names.filter((x) => x.startsWith(`${planId}-v`))) {
      try {
        await unlink(join(this.dir(), n));
        removed += 1;
      } catch {
        // 文件已不存在就跳过，清理失败不能连带让删方案失败
      }
    }
    return removed;
  }
}
