import { Injectable, NotFoundException } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { LlmService } from '../llm/llm.service.js';
import { TokenService } from '../billing/token.service.js';
import type { CreateSceneDto, UpdateSceneDto } from './lighting.schemas.js';

/**
 * 智能灯光场景服务：灯具编排 + 手工时间轴 + 出片产物挂接。
 * 对所有登录成员开放（content:generate），数据按 activeTenantId 隔离。
 * 列表不返回 fixtures/timeline 大字段（列表页只需标题/画幅/状态），详情才返回全量。
 */
@Injectable()
export class LightingService {
  constructor(private readonly prisma: PrismaService) {}

  private async mustGet(tenantId: string, id: string) {
    const scene = await this.prisma.lightingScene.findFirst({ where: { id, tenantId } });
    if (!scene) throw new NotFoundException('SCENE_NOT_FOUND');
    return scene;
  }

  list(tenantId: string) {
    return this.prisma.lightingScene.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      // 列表页不回传 fixtures/timeline（灯具与时间轴是大对象，列表无需携带）
      select: { id: true, title: true, ratio: true, status: true, createdAt: true, videoAssetId: true },
    });
  }

  detail(tenantId: string, id: string) {
    return this.mustGet(tenantId, id);
  }

  create(tenantId: string, userId: string, dto: CreateSceneDto) {
    return this.prisma.lightingScene.create({
      data: {
        tenantId,
        userId,
        title: dto.title.trim(),
        ...(dto.sourceAssetId !== undefined ? { sourceAssetId: dto.sourceAssetId } : {}),
        ...(dto.ratio !== undefined ? { ratio: dto.ratio } : {}),
        fixtures: dto.fixtures,
        timeline: dto.timeline,
        ...(dto.videoAssetId !== undefined ? { videoAssetId: dto.videoAssetId } : {}),
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateSceneDto) {
    const owned = await this.mustGet(tenantId, id);
    return this.prisma.lightingScene.update({
      where: { id: owned.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.sourceAssetId !== undefined ? { sourceAssetId: dto.sourceAssetId } : {}),
        ...(dto.ratio !== undefined ? { ratio: dto.ratio } : {}),
        ...(dto.fixtures !== undefined ? { fixtures: dto.fixtures } : {}),
        ...(dto.timeline !== undefined ? { timeline: dto.timeline } : {}),
        ...(dto.videoAssetId !== undefined ? { videoAssetId: dto.videoAssetId } : {}),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const owned = await this.mustGet(tenantId, id);
    return this.prisma.lightingScene.delete({ where: { id: owned.id } });
  }
}
/**
 * 灯光问诊任务定义（五项 × 3 题）。
 *
 * 放在后端而不是前端，是为了让「问题与选项」只有一份：前端调
 * `GET /api/lighting/diagnose/modes` 拿这份定义来渲染，问答时才不会出现
 * "界面显示的选项和后端理解的选项对不上"。
 *
 * 文案照抄参考站 `lighting-master.js` 的 MODES（2026-10-16 REA 复核）：
 * 门店的提问路径本来就是这样，改了会让用户认不出这是不是他们熟悉的那个工具。
 */
export const DIAGNOSIS_MODES = [
  {
    id: 'from-zero', icon: '✦', title: '从零设计灯光', description: '从空间开始，逐步生成方案',
    questions: [
      { id: 'projectType', text: '1. 这次设计的项目类型是什么？', options: ['普通住宅', '别墅 / 大平层', '办公室 / 展厅', '门店 / 商业空间'] },
      { id: 'furniture', text: '2. 家具位置是否已经确定？', options: ['已经定稿', '还在调整', '只有户型图', '暂不确定'] },
      { id: 'priority', text: '3. 你最看重哪种灯光体验？', options: ['舒适防眩', '明暗层次', '智能场景', '性价比'] },
    ],
  },
  {
    id: 'from-drawing', icon: '▦', title: '上传图纸找问题', description: '上传图纸，AI 识别并找问题',
    questions: [
      { id: 'drawingType', text: '1. 这张图是什么？', options: ['户型平面图', '水电施工图', '现场照片', '已有灯位布置图'] },
      { id: 'knownIssue', text: '2. 目前最困扰的是？', options: ['局部过暗', '眩光刺眼', '色温混乱', '控制不便'] },
      { id: 'stage', text: '3. 装修进行到哪一步？', options: ['尚未开工', '水电施工中', '软装进场后', '已入住'] },
    ],
  },
  {
    id: 'optimize', icon: '↗', title: '优化现有灯光方案', description: '优化已有方案，提升体验',
    questions: [
      { id: 'currentSetup', text: '1. 现在的灯光是怎么控制的？', options: ['全部智能', '部分智能', '传统开关', '混合但没配好'] },
      { id: 'complaint', text: '2. 客户最常抱怨什么？', options: ['不够亮', '太亮刺眼', '场景太少', '操作太复杂'] },
      { id: 'budget', text: '3. 改造预算范围？', options: ['几千元内', '万元级', '数万元', '暂未确定'] },
    ],
  },
  {
    id: 'scenes', icon: '☾', title: '规划智能灯光场景', description: '设计场景联动与氛围',
    questions: [
      { id: 'sceneCount', text: '1. 希望做几个场景？', options: ['2-3 个基础', '4-6 个', '7-10 个', '全屋联动'] },
      { id: 'moods', text: '2. 主要想要哪些氛围？', options: ['回家放松', '观影专注', '起夜不刺眼', '待客体面'] },
      { id: 'controlWay', text: '3. 用什么方式触发？', options: ['手机 App', '墙面面板', '语音音箱', '人体/门磁传感'] },
    ],
  },
  {
    id: 'check', icon: '✓', title: '检查施工和灯具参数', description: '检查施工与灯具参数合规',
    questions: [
      { id: 'checkScope', text: '1. 想检查什么？', options: ['照度是否达标', '色温配比', '眩光与显色', '功率与线路'] },
      { id: 'hasSpec', text: '2. 手上有灯具参数表吗？', options: ['有完整参数', '只有型号', '没有', '不确定'] },
      { id: 'phase', text: '3. 项目处于什么阶段？', options: ['方案阶段', '施工图阶段', '施工中', '已完工验收'] },
    ],
  },
] as const;

/** AI 输出的边界声明：写进结果页，防止门店把建议当施工依据 */
export const DIAGNOSIS_BOUNDARY =
  '本工具提供灯光思路、问题判断和大致灯位建议，不输出毫米级放线或精确灯具参数。需要落地时再由设计或施工人员现场确认。';

export interface DiagnosisResult {
  /** 问题分级：A 优先处理 / B 建议优化 / pending 待核对现场 */
  issues: { level: 'A' | 'B' | 'pending'; text: string }[];
  /** 全屋灯组建议 */
  circuits: { group: string; usage: string; control: string }[];
  /** 智能场景建议 */
  scenes: { name: string; lights: string; feeling: string }[];
  /** 大致灯位建议（相对位置描述，不是坐标） */
  placement: string[];
  summary: string;
  boundary: string;
}

/** 扣额度档位：一次问诊比一次普通对话贵（输出结构化建议），但不该按多次对话计 */
const DIAGNOSE_TOKENS = 60;

@Injectable()
export class LightingDiagnosisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tokens: TokenService,
    private readonly idem: IdempotencyService,
  ) {}

  private buildPrompt(modeId: string, answers: Record<string, string>): string {
    const mode = DIAGNOSIS_MODES.find((m) => m.id === modeId) ?? DIAGNOSIS_MODES[0];
    const qs = mode.questions
      .map((q) => `- ${q.text} 客户选择：${answers[q.id] ?? '未作答'}`)
      .join('\n');
    return [
      '你是一位资深智能照明设计师，正在为一家智能家居门店做灯光方案问诊。',
      `本次任务：${mode.title}（${mode.description}）`,
      '客户的回答：',
      qs,
      '',
      '请只输出一个 JSON 对象，不要任何解释文字或 Markdown 代码块。结构：',
      '{',
      '  "summary": "一句话总体判断",',
      '  "issues": [{"level":"A|B|pending","text":"具体问题"}],',
      '  "circuits": [{"group":"灯组名","usage":"用途","control":"控制建议"}],',
      '  "scenes": [{"name":"场景名","lights":"主要灯光","feeling":"感觉"}],',
      '  "placement": ["大致灯位建议，用相对位置描述，如『客餐厅主灯居中、两侧加辅助光』"]',
      '}',
      '',
      '要求：',
      '- issues 至少 3 条，A 级表示"必须优先处理"的硬伤，B 级是"建议优化"，pending 是"需现场核对"',
      '- circuits 3-6 条，scenes 3-6 条，placement 3-6 条',
      '- 全部用简体中文，不要出现英文术语',
      '- **不得给出毫米级尺寸、灯带米数、回路电流等施工参数**，只给思路与大致位置',
      '- 不确定的地方放进 pending，不要编造具体数值',
    ].join('\n');
  }

  /**
   * 灯光问诊。
   *
   * 模型不听话是常态（会包 Markdown 代码块、夹带解释、字段名写错），
   * 所以解析要**逐层兜底**：先剥代码块 → 再截取最外层 JSON → 仍失败就退化成纯文本建议。
   * 宁可给一段没有分级的文字，也不要给用户一个报错页。
   */
  async run(
    tenantId: string,
    userId: string,
    dto: { modeId: string; answers: Record<string, string>; clientRequestId?: string },
  ): Promise<DiagnosisResult> {
    // 幂等：弱网重试不该让用户为同一次问诊付两次钱
    const claim = await this.idem.claim(tenantId, dto.clientRequestId, 'lighting-diagnose');
    if (!claim.fresh) {
      return (claim.previous as DiagnosisResult | null) ?? {
        issues: [], circuits: [], scenes: [], placement: [],
        summary: '这次问诊已经提交过了，结果正在生成或已被处理过；如需重新诊断请刷新页面',
        boundary: DIAGNOSIS_BOUNDARY,
      };
    }
    try {
      await this.tokens.consume(tenantId, DIAGNOSE_TOKENS, 'CONSUME', { kind: 'lighting-diagnose', title: dto.modeId }, userId);
      const prompt = this.buildPrompt(dto.modeId, dto.answers);
      const res = await this.llm.chat({ model: '', prompt, maxTokens: 1200, systemPrompt: DIAGNOSIS_BOUNDARY });
      const out = this.parse(res.reply);
      await this.idem.complete(tenantId, dto.clientRequestId, 'lighting-diagnose', out);
      return out;
    } catch (e) {
      // 失败要能重试：否则用户第一次失败后就再也提交不了
      await this.idem.release(tenantId, dto.clientRequestId);
      throw e;
    }
  }

  private parse(raw: string): DiagnosisResult {
    const fallback: DiagnosisResult = {
      issues: [],
      circuits: [],
      scenes: [],
      placement: [],
      summary: raw.replace(/```[a-z]*|[{}]/g, '').trim().slice(0, 600),
      boundary: DIAGNOSIS_BOUNDARY,
    };
    const text = raw.replace(/```[a-z]*\s*([\s\S]*?)```/i, '$1').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return fallback;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return fallback;
    }
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
      summary: str(obj.summary) || fallback.summary,
      issues: arr<{ level?: string; text?: string }>(obj.issues)
        .map((i) => ({
          level: (['A', 'B', 'pending'].includes(String(i.level)) ? String(i.level) : 'pending') as 'A' | 'B' | 'pending',
          text: str(i.text),
        }))
        .filter((i) => i.text),
      circuits: arr<{ group?: string; usage?: string; control?: string }>(obj.circuits).map((c) => ({
        group: str(c.group), usage: str(c.usage), control: str(c.control),
      })).filter((c) => c.group),
      scenes: arr<{ name?: string; lights?: string; feeling?: string }>(obj.scenes).map((s) => ({
        name: str(s.name), lights: str(s.lights), feeling: str(s.feeling),
      })).filter((s) => s.name),
      placement: arr<unknown>(obj.placement).map(str).filter(Boolean),
      boundary: DIAGNOSIS_BOUNDARY,
    };
  }
}
