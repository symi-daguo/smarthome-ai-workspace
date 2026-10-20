import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import { parseUploadedFile } from '../content/extractors/p1-upload.js';

/** 单份资料字数上限：与参考站同量级（它约 8 万字），超了截断而不是拒绝 */
const MAX_CHARS = 80_000;

/** 切段目标长度：太小丢上下文，太大命中后噪声多。500 字约等于一屏可读量 */
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 80;

/** 与 knowledge-adapter 的 KnowledgeChunk 同形，两条召回通路共用 formatKnowledgeContext */
export type KnowledgeChunk = {
  title: string;
  content: string;
  score: number;
  source: string;
};


/**
 * 切块 + 打分（**纯函数，不依赖 Prisma**）。
 *
 * 抽出来有两个原因：
 * 1. `KnowledgeModule` 已经 import `LlmModule`，反向注入会循环依赖；
 *    LlmService 直接 import 这个函数就能用本地资料库兜底。
 * 2. 检索质量必须能脱离数据库单独验证——门店资料检索错了，AI 就会答错。
 */
export function rankLocalChunks(
  docs: { title: string; content: string }[],
  query: string,
  limit = 6,
): KnowledgeChunk[] {
  const grams = bigrams(query);
  if (!grams.length) return [];

  const scored: KnowledgeChunk[] = [];
  for (const doc of docs) {
    const chunks = [...chunkText(doc.content)];
    // 标题必须参与检索：标题常是「报价规则 / 品牌话术 / 产品资料」这类主题词，
    // 而正文未必重复出现这些词。只索引正文时，用户问「价格的规则是什么」会命中不到
    // 标题就叫「报价规则」的文档（实测复现），召回率直接漏一档。
    // 标题命中时返回该文档首段而不是标题本身——注入给模型的是可读内容，不是标题串。
    const units = chunks.length
      ? [{ text: doc.title, content: chunks[0] }, ...chunks.map((c) => ({ text: c, content: c }))]
      : [{ text: doc.title, content: doc.title }];
    for (const unit of units) {
      const bag = new Set(bigrams(unit.text));
      let hits = 0;
      for (const g of grams) if (bag.has(g)) hits += 1;
      if (hits === 0) continue;
      const coverage = hits / grams.length;
      scored.push({
        title: doc.title,
        content: unit.content,
        // 覆盖率为主要权重，命中数为次要权重（同样覆盖率时命中多的更相关）
        score: coverage * 10 + Math.min(hits, 20) * 0.1,
        source: '本地资料库',
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * 中文二元切分。
 *
 * 为什么不用整句匹配：中文没有空格，「上门安装费多少钱」是一个整串，
 * 而资料里写的是「上门安装费 200 元」——整串匹配永远命中不了，
 * 召回率直接归零。而中文检索的成熟做法就是**二元组**（bigram）：
 * 把「上门安装费多少钱」切成 上门/门安/安装/装费/费多/多少，
 * 不需要词典、不需要装分词器，召回率就够用。
 * 低召回风险由「覆盖率 + 命中数」的打分和 `limit` 截断兜住。
 */
function bigrams(text: string): string[] {
  const clean = text.replace(/[\s,，。；;、！!？?（）()【】\[\]"“”'：:、.．/\\|-]+/gu, '');
  // 单字（长度 1）没有二元组，直接作为整字返回，避免"查 网 "这种查询全被丢弃
  if (clean.length < 2) return clean ? [clean] : [];
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i += 1) out.push(clean.slice(i, i + 2));
  return out;
}

/** 按长度切段，段间留重叠避免答案被切在边界上 */
function* chunkText(text: string): Generator<string> {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return;
  if (clean.length <= CHUNK_SIZE) {
    yield clean;
    return;
  }
  for (let i = 0; i < clean.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    const piece = clean.slice(i, i + CHUNK_SIZE).trim();
    if (piece) yield piece;
    if (i + CHUNK_SIZE >= clean.length) break;
  }
}

/**
 * 账号级本地资料库：上传一次，所有 AI 对话按需召回参考。
 *
 * ## 为什么不用向量检索
 * 门店的资料量是几十份文档、几十万字量级，而且要**开箱即用**：
 * 向量检索要么需要 embedding API（要钱、要联网、门店伙伴未必配 key），
 * 要么需要额外跑一个模型服务（要内存、要部署）。这里用**段落切块 + 关键词命中**：
 * 数据量下完全够用，零依赖、零成本、离线可用。
 * 资料量真的涨到百万字级、且检索质量成为瓶颈时，再换 pgvector（镜像已自带扩展）不迟。
 *
 * ## 与外部知识库引擎的关系
 * `knowledgeConfig` 的 provider 指向 WeKnora/Obsidian 时走**外部召回**（能力更强、需自行部署）；
 * provider 为 `local` 时走这里。两条路互不干扰，前端只暴露一个「资料库」入口。
 */
@Injectable()
export class KnowledgeDocService {
  constructor(private readonly prisma: PrismaService) {}

  /** 上传并解析入库。解析复用内容提取的现成实现，不重复造解析器。 */
  async upload(tenantId: string, file: { buffer: Buffer; originalName: string; mimeType: string }) {
    let parsed: Awaited<ReturnType<typeof parseUploadedFile>>;
    try {
      parsed = await parseUploadedFile({
        buffer: file.buffer,
        originalName: file.originalName,
        mimeType: file.mimeType,
      });
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : '文件解析失败');
    }
    // 同名文件视为更新而不是重复入库：用户重传改过的版本不该多出一条
    const existed = await this.prisma.knowledgeDoc.findFirst({
      where: { tenantId, fileName: file.originalName },
    });
    const content = parsed.content.slice(0, MAX_CHARS);
    const data = {
      title: parsed.title,
      content,
      chars: content.length,
      fileType: parsed.meta?.fileType ?? '',
    };
    const doc = existed
      ? await this.prisma.knowledgeDoc.update({ where: { id: existed.id }, data })
      : await this.prisma.knowledgeDoc.create({
          data: { tenantId, fileName: file.originalName, ...data },
        });
    return {
      id: doc.id,
      title: doc.title,
      fileName: doc.fileName,
      chars: doc.chars,
      truncated: parsed.content.length > MAX_CHARS,
    };
  }

  async list(tenantId: string) {
    const docs = await this.prisma.knowledgeDoc.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, fileName: true, fileType: true, chars: true, enabled: true, createdAt: true },
    });
    // 生效量 / 累计量分开展示：用户要知道「现在真正被 AI 参考了多少」
    const activeChars = docs.filter((d) => d.enabled).reduce((s, d) => s + d.chars, 0);
    const totalChars = docs.reduce((s, d) => s + d.chars, 0);
    return { docs, activeChars, totalChars };
  }

  async toggle(tenantId: string, id: string, enabled: boolean) {
    await this.mustGet(tenantId, id);
    return this.prisma.knowledgeDoc.update({ where: { id }, data: { enabled } });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.mustGet(tenantId, id);
    await this.prisma.knowledgeDoc.delete({ where: { id } });
  }

  private async mustGet(tenantId: string, id: string) {
    const doc = await this.prisma.knowledgeDoc.findFirst({ where: { id, tenantId } });
    if (!doc) throw new NotFoundException('KNOWLEDGE_DOC_NOT_FOUND');
    return doc;
  }

  /** 关键词召回：切块后逐段打分，返回最相关的若干段 */
  async search(tenantId: string, query: string, limit = 6): Promise<KnowledgeChunk[]> {
    const docs = await this.prisma.knowledgeDoc.findMany({
      where: { tenantId, enabled: true },
      select: { title: true, content: true },
    });
    return rankLocalChunks(docs, query, limit);
  }

}
