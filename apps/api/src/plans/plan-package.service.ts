import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import JSZip from 'jszip';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { MediaService } from '../media/media.service.js';
import { PlansService } from './plans.service.js';

/**
 * 交付三件套打包（`POST /package`）。
 *
 * 为什么要搬到服务端：**浏览器 blob 下载的文件名由宿主决定**，
 * 实测一律落成 `.com.minimax.agent.cn.XXXX`，客户拿到的是一串随机名，
 * 而交付物的名字恰恰是最不该丢的东西（`方案名-V3-交付三件套.zip`）。
 * 服务端 `Content-Disposition` 才能保证文件名，而且中文名要走 RFC 5987 编码。
 *
 * 职责边界（刻意不做多）：
 * - PPTX 由**前端生成后上传**：它依赖浏览器 canvas 做预裁剪与点位合成，
 *   搬到服务端要引入 node-canvas 原生编译，那才是真造轮子。
 * - 图片包由**服务端从 media 取**：原图都在 uploads 卷里，再让前端传一遍纯属浪费。
 * - 打包完成后给的是**签名直链**：不落 token 到数据库，stateless。
 *
 * 两个必须有的闸门（校对门与链接失效）：
 * 1. 打包前必须已逐页校对，否则 409 —— 免校对直接发给客户是最贵的错
 * 2. 下载时版本对不上就 410 —— 客户手里的旧链接不能悄悄指向新版本，那等于篡改已发出的交付物
 */

/** token 载荷里的主体标记，防止把普通登录 token 当成下载 token 用 */
const TOKEN_SUBJECT = 'plan-package';
/** 签名直链有效期：够微信里中转一次，又不至于长期挂着 */
const TOKEN_TTL = '2h';
/** 每个方案保留的交付包份数。不限量的话每次校对后重新打包都会留一份，磁盘只增不减 */
const KEEP_PACKAGES = 3;

interface PackageTokenPayload {
  sub: string;
  planId: string;
  tenantId: string;
  versionNo: number;
  /** 落盘文件名，下载时用它还原出可读名字 */
  stored: string;
  /** 交付给客户的名字（含中文与版本号） */
  downloadName: string;
}

@Injectable()
export class PlanPackageService {
  constructor(
    private readonly plans: PlansService,
    private readonly media: MediaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private packageDir(): string {
    return join(this.config.get<string>('UPLOAD_DIR', 'uploads'), 'plan-packages');
  }

  /** 中文文件名必须按 RFC 5987 编码，否则老浏览器会把 UTF-8 当 Latin-1 存成乱码 */
  private contentDisposition(name: string): string {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  /**
   * 打包三件套：PPTX（前端生成）+ 图片包（服务端取原图）+ 完整讲稿。
   * 返回签名直链所需的 token 与展示名。
   */
  async build(args: {
    tenantId: string;
    planId: string;
    userId: string;
    pptx: Buffer;
    narration: string;
  }): Promise<{ token: string; fileName: string; size: number; contents: string[] }> {
    const plan = await this.plans.detail(args.tenantId, args.planId);
    // 校对闸门：改任意一页都会 bump versionNo 并让 reviewedRevision 失效，
    // 所以「reviewedRevision === versionNo」等价于「这一版已被逐页确认过」
    if (plan.reviewedRevision === null || plan.reviewedRevision !== plan.versionNo) {
      throw new ConflictException({
        code: 'PLAN_NOT_REVIEWED',
        message: '请先逐页校对这份方案再打包交付，未校对的内容发出去无法收回',
      });
    }
    if (!args.pptx.length) throw new BadRequestException('PPTX_CONTENT_EMPTY');
    if (!args.narration.trim()) throw new BadRequestException('NARRATION_EMPTY');

    const version = plan.versionNo;
    const zip = new JSZip();

    // 1. 方案 PPTX：前端 canvas 预裁剪 + 点位合成后的成品，原样收进来
    const pptxName = `${plan.title}-V${version}-方案.pptx`;
    zip.file(pptxName, args.pptx);

    // 2. 完整讲稿：逐字稿，门店交付时对着念的那份
    const mdName = `${plan.title}-V${version}-完整讲稿.md`;
    zip.file(mdName, args.narration, { date: new Date() });

    // 3. 图片包：按空间分组放，客户能对上「这页用的是哪张图」
    const images = await this.collectImages(args.tenantId, plan);
    const folder = zip.folder('图片包')!;
    const contents = [pptxName, mdName];
    for (const img of images) {
      folder.file(img.name, img.buffer, { date: new Date() });
      contents.push(`图片包/${img.name}`);
    }

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const stored = `${args.planId}-v${version}-${Date.now()}.zip`;
    await mkdir(this.packageDir(), { recursive: true });
    await writeFile(join(this.packageDir(), stored), buf);

    const fileName = `${plan.title}-V${version}-交付三件套.zip`;
    const token = await this.jwt.signAsync(
      { sub: TOKEN_SUBJECT, planId: args.planId, tenantId: args.tenantId, versionNo: version, stored, downloadName: fileName },
      { expiresIn: TOKEN_TTL },
    );

    await this.prune(args.planId);
    return { token, fileName, size: buf.length, contents };
  }

  /** 校验签名直链并解析出落盘文件。版本对不上直接 410，不做「悄悄给新版本」 */
  async resolve(token: string): Promise<{ abs: string; downloadName: string; contentDisposition: string }> {
    let payload: PackageTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<PackageTokenPayload>(token);
    } catch {
      throw new NotFoundException('PACKAGE_LINK_INVALID');
    }
    if (payload.sub !== TOKEN_SUBJECT) throw new NotFoundException('PACKAGE_LINK_INVALID');

    const plan = await this.plans.detail(payload.tenantId, payload.planId);
    if (plan.versionNo !== payload.versionNo) {
      throw new GoneException({
        code: 'PACKAGE_VERSION_STALE',
        message: `这份交付包对应的是 V${payload.versionNo} 版，方案已更新到 V${plan.versionNo} 版，请重新打包`,
      });
    }

    const abs = join(this.packageDir(), basename(payload.stored));
    try {
      await stat(abs);
    } catch {
      throw new NotFoundException('PACKAGE_EXPIRED');
    }
    return { abs, downloadName: payload.downloadName, contentDisposition: this.contentDisposition(payload.downloadName) };
  }

  /**
   * 收集方案用到的全部原图：户型图主图 + 额外户型图 + 精装修效果图 + 装修效果图。
   * 取不到的单张跳过而不是整体失败 —— 少一张图不该让整包交不出去。
   *
   * 参数类型刻意写松：Prisma 的 JSON 列在 SDK 里是 `JsonValue`，
   * 强转成结构化类型只会逼出一串 `as`，真正的形状校验放在运行时取值处。
   */
  private async collectImages(
    tenantId: string,
    plan: {
      floorplanAssetId?: string | null;
      extraFloorplanAssetIds?: string[] | null;
      renderedFloorplanAssetId?: string | null;
      renderAssetIds?: string[] | null;
      renderAssetMeta?: unknown;
    },
  ): Promise<{ name: string; buffer: Buffer }[]> {
    const ids: { id: string; label: string }[] = [];
    if (plan.floorplanAssetId) ids.push({ id: plan.floorplanAssetId, label: '户型图-主图' });
    (plan.extraFloorplanAssetIds ?? []).forEach((id, i) => ids.push({ id, label: `户型图-附图${i + 1}` }));
    if (plan.renderedFloorplanAssetId) ids.push({ id: plan.renderedFloorplanAssetId, label: '精装修效果图' });
    const meta = Array.isArray(plan.renderAssetMeta) ? (plan.renderAssetMeta as { fileName?: string }[]) : [];
    (plan.renderAssetIds ?? []).forEach((id, i) => {
      const name = meta[i]?.fileName;
      ids.push({ id, label: name ? `效果图-${name.replace(/[/\\]/g, '_')}` : `效果图-${i + 1}` });
    });

    const out: { name: string; buffer: Buffer }[] = [];
    const used = new Set<string>();
    for (const item of ids) {
      try {
        const asset = await this.media.get(tenantId, item.id);
        const buffer = await readFile(this.media.resolveSafe(asset.filePath));
        // 同名文件在 zip 里会互相覆盖，客户解压后只剩最后一张
        let name = `${item.label}${extname(asset.filePath) || '.png'}`;
        let n = 2;
        while (used.has(name)) {
          name = `${item.label}-${n}${extname(asset.filePath) || '.png'}`;
          n += 1;
        }
        used.add(name);
        out.push({ name, buffer });
      } catch {
        // 单张缺失不阻断整包
      }
    }
    return out;
  }

  /** 只留最近 KEEP_PACKAGES 份，超出的按时间从旧到新删 */
  private async prune(planId: string): Promise<void> {
    const dir = this.packageDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const mine = names.filter((n) => n.startsWith(`${planId}-v`));
    if (mine.length <= KEEP_PACKAGES) return;
    const withTime = await Promise.all(
      mine.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })),
    );
    withTime.sort((a, b) => a.t - b.t);
    for (const { n } of withTime.slice(0, withTime.length - KEEP_PACKAGES)) {
      await unlink(join(dir, n)).catch(() => undefined);
    }
  }

  /**
   * 删除某个方案的全部交付包（方案被删时调用）。
   *
   * **为什么必须删**：交付包是**纯文件、不入库**的（zip 落盘，库里没有对应行），
   * `prune` 只管「同一方案打包多次时留最新 KEEP_PACKAGES 份」，管不到「方案本身被删」——
   * 方案一删，包就成了没人认领的孤儿，永久留在卷里。
   * 实测单个包 3-20MB，几十个方案就能吃掉几百 MB，正是「无错误数据挤爆硬盘」的典型来源。
   *
   * 返回删掉的数量，便于调用方观测。
   */
  async removeByPlan(planId: string): Promise<number> {
    const dir = this.packageDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const n of names.filter((x) => x.startsWith(`${planId}-v`))) {
      try {
        await unlink(join(dir, n));
        removed += 1;
      } catch {
        // 文件已不存在（或被并发删掉）就跳过，不能因为清理失败而让删除方案整体失败
      }
    }
    return removed;
  }
}
