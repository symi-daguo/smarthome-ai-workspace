import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import { LlmService } from '../llm/llm.service.js';
import { KnowledgeDocService } from '../knowledge/knowledge-doc.service.js';
import { BenchmarkService } from './benchmark.service.js';
import { BENCHMARK_RETENTION_DAYS } from './benchmark-fields.js';
import type { AnalyzeDto } from './benchmark.schemas.js';

/** 分析结果的结构化形态（模型输出经白名单过滤后的样子） */
export type BenchmarkAnalysis = {
  summary: string;
  style: {
    contentTypes: string;
    hooks: string;
    rhythm: string;
    tone: string;
    visual: string;
    topics: string;
  };
  scenes: { scene: string; ourCategory: string; evidence: string }[];
  products: { mentioned: string; ourMatch: string; covered: string }[];
  sellingPoints: string[];
  structure: { step: string; seconds: string; what: string }[];
  gaps: { title: string; why: string; action: string }[];
};

/** 模型原始输出的可能形态（宽松接收，过滤在 normalize 里做） */
type RawAnalysis = Record<string, unknown>;

const EMPTY_ANALYSIS: BenchmarkAnalysis = {
  summary: '',
  style: { contentTypes: '', hooks: '', rhythm: '', tone: '', visual: '', topics: '' },
  scenes: [],
  products: [],
  sellingPoints: [],
  structure: [],
  gaps: [],
};

function str(v: unknown, max = 400): string {
  if (typeof v === 'string') return v.trim().slice(0, max);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * 白名单过滤：模型输出的结构不可控，
 * 直接存库会污染界面渲染与后续解析。这里逐字段收敛到既定形态。
 */
export function normalizeAnalysis(raw: RawAnalysis): BenchmarkAnalysis {
  const style = obj(raw.style);
  return {
    summary: str(raw.summary, 200),
    style: {
      contentTypes: str(style.contentTypes, 200),
      hooks: str(style.hooks, 200),
      rhythm: str(style.rhythm, 200),
      tone: str(style.tone, 120),
      visual: str(style.visual, 200),
      topics: str(style.topics, 200),
    },
    scenes: arr(raw.scenes)
      .slice(0, 12)
      .map((x) => {
        const o = obj(x);
        return { scene: str(o.scene, 60), ourCategory: str(o.ourCategory, 60), evidence: str(o.evidence, 200) };
      })
      .filter((x) => x.scene),
    products: arr(raw.products)
      .slice(0, 15)
      .map((x) => {
        const o = obj(x);
        return {
          mentioned: str(o.mentioned, 120),
          ourMatch: str(o.ourMatch, 120),
          covered: str(o.covered, 20) || 'unknown',
        };
      })
      .filter((x) => x.mentioned),
    sellingPoints: arr(raw.sellingPoints)
      .slice(0, 12)
      .map((x) => str(x, 120))
      .filter(Boolean),
    structure: arr(raw.structure)
      .slice(0, 10)
      .map((x) => {
        const o = obj(x);
        return { step: str(o.step, 40), seconds: str(o.seconds, 20), what: str(o.what, 240) };
      })
      .filter((x) => x.step),
    gaps: arr(raw.gaps)
      .slice(0, 12)
      .map((x) => {
        const o = obj(x);
        return { title: str(o.title, 80), why: str(o.why, 240), action: str(o.action, 240) };
      })
      .filter((x) => x.title),
  };
}

/**
 * AI 映射分析：把对标账号的热门内容，映射到**我们自己的业务**上。
 *
 * 产出两样东西：
 * 1. 对标风格画像 + 内容结构 + 场景/产品/卖点映射 + 差距清单（给人看）
 * 2. 同一份结论**投影成一份知识库资料**（给智能体检索学习）
 *
 * 「我们」的基线来自两处：产品库（我们有什么品类与产品）、本地资料库（门店话术与卖点）。
 * 没有基线就只能做风格描述、给不出差距——所以这两段必须喂给模型。
 */
@Injectable()
export class BenchmarkAnalyzeService {
  private readonly logger = new Logger(BenchmarkAnalyzeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly knowledge: KnowledgeDocService,
    private readonly benchmark: BenchmarkService,
  ) {}

  /** 分析一个或全部启用的对标账号 */
  async analyze(tenantId: string, dto: AnalyzeDto) {
    const accounts = dto.accountId
      ? [await this.benchmark.mustGetAccount(tenantId, dto.accountId)]
      : await this.prisma.benchmarkAccount.findMany({ where: { tenantId, enabled: true } });
    if (accounts.length === 0) {
      throw new BadRequestException({
        code: 'BENCHMARK_NO_ACCOUNT',
        message: '还没有配置对标账号，请先在「对标账号」里添加要盯的账号',
      });
    }

    const ourProducts = await this.ourProductBrief(tenantId);
    const ourDocs = await this.ourDocBrief(tenantId);

    const results: {
      accountId: string;
      accountName: string;
      sampleSize: number;
      summary: string;
      gapCount: number;
      knowledgeDocId?: string;
      error?: string;
    }[] = [];

    for (const account of accounts) {
      const contents = await this.prisma.benchmarkContent.findMany({
        where: {
          tenantId,
          accountId: account.id,
          // 只分析保留期内的内容：超期的原文我们不再拿去做映射
          collectedAt: { gte: new Date(Date.now() - BENCHMARK_RETENTION_DAYS * 86_400_000) },
        },
        orderBy: { hotScore: 'desc' },
        take: dto.topN,
      });
      if (contents.length === 0) {
        results.push({
          accountId: account.id,
          accountName: account.accountName,
          sampleSize: 0,
          summary: '还没有采集到内容',
          gapCount: 0,
          error: 'NO_CONTENT',
        });
        continue;
      }
      try {
        const analysis = await this.analyzeOne(tenantId, account, contents, ourProducts, ourDocs);
        const insight = await this.prisma.benchmarkInsight.create({
          data: {
            tenantId,
            accountId: account.id,
            accountName: account.accountName,
            analysis: JSON.stringify(analysis),
            gaps: JSON.stringify(analysis.gaps),
            summary: analysis.summary,
            model: 'chat',
            sampleSize: contents.length,
          },
        });
        // 投影进知识库：智能体对话时就能检索到「对标账号怎么讲这类内容」
        const projection = buildProjectionText(account, analysis, contents.length);
        const doc = await this.knowledge.writeDoc(tenantId, {
          title: `对标情报 · ${account.accountName}`,
          content: projection,
          fileName: `benchmark-${account.id}.md`,
          sourceType: 'benchmark',
          sourceUrl: account.homeUrl,
        });
        results.push({
          accountId: account.id,
          accountName: account.accountName,
          sampleSize: contents.length,
          summary: analysis.summary,
          gapCount: analysis.gaps.length,
          knowledgeDocId: doc.id,
        });
        void insight;
      } catch (e) {
        const message = e instanceof Error ? e.message : '分析失败';
        this.logger.warn(`对标分析失败 ${account.accountName}: ${message}`);
        results.push({
          accountId: account.id,
          accountName: account.accountName,
          sampleSize: contents.length,
          summary: '',
          gapCount: 0,
          error: message,
        });
      }
    }
    return { results };
  }

  /** 单账号分析 */
  private async analyzeOne(
    tenantId: string,
    account: { id: string; accountName: string; platform: string; homeUrl: string },
    contents: { title: string; text: string; topics: string; sourceUrl: string }[],
    ourProducts: string,
    ourDocs: string,
  ): Promise<BenchmarkAnalysis> {
    const sample = contents
      .map((c, i) => {
        const topics = c.topics ? ` 话题：${c.topics}` : '';
        return [
          `【${i + 1}】${c.title}`,
          `文案：${c.text}`,
          topics ? topics.replace(/^ /, '') : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');

    const systemPrompt = [
      '你是一名智能家居行业的短视频内容分析师。',
      '给你一批对标账号的热门内容样本，你要分析出「它是怎么做内容的」，并映射到我们自己的业务（智能家居门店/产品）上。',
      '',
      '硬性要求：',
      '1. 只依据给出的样本，不要编造样本里没有的事实；样本不足时在 summary 里说明样本不足。',
      '2. 差距项必须可执行（action 要具体到「拍一条什么内容的脚本」「补哪个品类的讲解」），不要写「加强宣传」这种空话。',
      '3. **输出要短**：每个字段不超过 60 字；scenes 最多 8 条、products 最多 10 条、sellingPoints 最多 8 条、structure 最多 8 条、gaps 最多 8 条。宁可少而准，不要长而全。',
      '4. 只返回 JSON 对象，字段：',
      '   summary：一句话结论（不超过 60 字）',
      '   style：对象，含 contentTypes（常见内容类型）、hooks（开头钩子模式）、rhythm（结构节奏）、tone（语气人称）、visual（画面/呈现元素）、topics（常用话题方向）',
      '   scenes：数组，每项 {scene, ourCategory, evidence}，scene=对标在讲的场景，ourCategory=对应我们哪个品类，evidence=样本里的依据',
      '   products：数组，每项 {mentioned, ourMatch, covered}，mentioned=对标提到的产品或品类，ourMatch=我们对应的产品或品类，covered=yes/no/unknown',
      '   sellingPoints：字符串数组，对标反复强调的卖点',
      '   structure：数组，每项 {step, seconds, what}，拆解内容结构模板',
      '   gaps：数组，每项 {title, why, action}，我们与对标的差距',
    ].join('\n');

    const prompt = [
      `【对标账号】${account.accountName}（平台：${account.platform}）`,
      `【样本条数】${contents.length}`,
      '',
      '【对标热门内容样本】',
      sample,
      '',
      '【我们的产品库（我们有什么品类与产品）】',
      ourProducts || '（暂无产品数据）',
      '',
      '【我们的门店资料与话术（我们的卖点基线）】',
      ourDocs || '（暂无资料）',
      '',
      '请按系统提示的 JSON 结构输出分析结果。',
    ].join('\n');

    const raw = await this.llm.chatJson<RawAnalysis>({
      systemPrompt,
      prompt,
      // 预算给足：默认模型是推理模型，**思考过程也吃 max_tokens**，
      // 给小了会在正式输出中途截断 → JSON 配平失败（实测踩过：
      // 4096 预算下 12 条样本的分析必然截断，报 LLM_JSON_PARSE_FAILED）。
      maxTokens: 16_384,
      // 推理模型做这类结构化归纳又慢又贵；实测同输出下高速档快约 4 倍。
      // 用户在「模型配置」里显式设了模型时仍然以用户设置为准（chat() 里 cfg.model 优先）。
      model: 'MiniMax-M2.7-highspeed',
      timeoutMs: 180_000,
      rag: { tenantId, scene: 'benchmark-analyze' },
    });
    return normalizeAnalysis(raw);
  }

  /** 我们有的品类与产品（给模型做产品映射的基线） */
  private async ourProductBrief(tenantId: string): Promise<string> {
    const rows = await this.prisma.product.findMany({
      where: { active: true, OR: [{ tenantId: null }, { tenantId }] },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
      select: { name: true, category: true, brand: true },
      take: 200,
    });
    if (rows.length === 0) return '';
    const byCategory = new Map<string, string[]>();
    for (const r of rows) {
      const list = byCategory.get(r.category) ?? [];
      list.push(r.name);
      byCategory.set(r.category, list);
    }
    return [...byCategory.entries()]
      .map(([cat, names]) => `- ${cat}：${names.slice(0, 12).join('、')}`)
      .join('\n');
  }

  /** 我们自己上传的门店资料（卖点基线） */
  private async ourDocBrief(tenantId: string): Promise<string> {
    const docs = await this.prisma.knowledgeDoc.findMany({
      where: { tenantId, enabled: true, sourceType: 'file' },
      orderBy: { createdAt: 'desc' },
      select: { title: true, content: true },
      take: 3,
    });
    return docs.map((d) => `【${d.title}】\n${d.content.slice(0, 1200)}`).join('\n\n');
  }
}

/**
 * 把分析结论投影成一份**给智能体学的**文本。
 *
 * 为什么单独写这一段，而不是把 JSON 直接塞进知识库：
 * 知识库检索是 bigram 关键词召回（`rankLocalChunks`），
 * 覆盖率 = 命中 bigram / query bigram 总数。
 * 所以正文里塞播放量数字、JSON 符号、字段名，会**稀释命中率**——
 * 投影文本只保留叙述性结论（画像、场景、卖点、结构、差距），
 * 数字型指标留在结构化表里，不进检索语料。
 */
export function buildProjectionText(
  account: { accountName: string; platform: string },
  analysis: BenchmarkAnalysis,
  sampleSize: number,
): string {
  const lines: string[] = [];
  lines.push(`对标账号：${account.accountName}（平台：${account.platform}）`);
  lines.push(`样本：${sampleSize} 条热门内容`);
  lines.push('');
  lines.push('【风格画像】');
  if (analysis.style.contentTypes) lines.push(`常见内容类型：${analysis.style.contentTypes}`);
  if (analysis.style.hooks) lines.push(`开头钩子：${analysis.style.hooks}`);
  if (analysis.style.rhythm) lines.push(`结构节奏：${analysis.style.rhythm}`);
  if (analysis.style.tone) lines.push(`语气与人称：${analysis.style.tone}`);
  if (analysis.style.visual) lines.push(`画面呈现：${analysis.style.visual}`);
  if (analysis.style.topics) lines.push(`常用话题方向：${analysis.style.topics}`);
  lines.push('');
  if (analysis.scenes.length > 0) {
    lines.push('【场景映射到我们的品类】');
    for (const s of analysis.scenes) {
      lines.push(`- ${s.scene} → 我们的品类：${s.ourCategory || '（待定）'}；依据：${s.evidence}`);
    }
    lines.push('');
  }
  if (analysis.sellingPoints.length > 0) {
    lines.push('【它反复强调的卖点】');
    for (const p of analysis.sellingPoints) lines.push(`- ${p}`);
    lines.push('');
  }
  if (analysis.structure.length > 0) {
    lines.push('【可复用的内容结构模板】');
    analysis.structure.forEach((s, i) => {
      const sec = s.seconds ? `（${s.seconds}）` : '';
      lines.push(`${i + 1}. ${s.step}${sec}：${s.what}`);
    });
    lines.push('');
  }
  if (analysis.gaps.length > 0) {
    lines.push('【我们与它的差距与可借鉴点】');
    for (const g of analysis.gaps) {
      lines.push(`- ${g.title}：${g.why}；建议：${g.action}`);
    }
    lines.push('');
  }
  if (analysis.summary) {
    lines.push('【一句话结论】');
    lines.push(analysis.summary);
  }
  return lines.join('\n');
}

/** 分析服务需要的账号类型 */
export type BenchmarkAccountBrief = { id: string; accountName: string; platform: string; homeUrl: string };

/** 供 controller 复用的未找到异常 */
export function accountNotFound(): NotFoundException {
  return new NotFoundException('BENCHMARK_ACCOUNT_NOT_FOUND');
}
