/**
 * 品牌官网 → 我们的产品格式 → 落库。
 *
 * 这一层负责「翻译」：官网的分类名（灯控系统 / 调光系统…）和产品名
 * 怎么对应到我们的品类字典与产品字段。
 *
 * 翻译用 LLM 而不是写死映射表，原因：
 * - 品牌官网的分类名千差万别（灯控系统 / 开关面板 / 智能照明…），写死映射表
 *   就只能支持一家品牌；用户要的是「任意品牌都能导」；
 * - 我们的品类字典有 39 类且租户可自定义，写死必然对不上；
 * - LLM 这件事本来就擅长：给它品类字典 + 产品清单，它能判断「磁吸轨道灯」属于哪一类。
 *
 * 但**不把 LLM 的输出直接写进库**：先落到「待确认」的结构里，
 * 由调用方（人或 Agent）选择「直接导入」还是「先看看」——
 * 抓 100 个产品让模型瞎分类后直接入库，是会污染产品库的。
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import { LlmService } from '../llm/llm.service.js';
import { BrandSiteService, type RawBrandProduct } from './brand-site.service.js';
import { ProductTransferService, type ImportRowResult, type ProductRow } from './product-transfer.service.js';

/** 抓取并转换后的产品行（已映射到我们的品类字典） */
export interface MappedProductRow extends ProductRow {
  /** 官网原始分类名（便于人工核对映射对不对） */
  sourceCategory?: string;
  /** 官网详情页（留个出处，方便回查） */
  sourceUrl?: string;
}

export interface BrandImportResult {
  brand: string;
  siteName: string;
  /** 官网上的分类（原文） */
  sourceCategories: string[];
  /** 我们的品类字典里用到的 key */
  usedCategories: string[];
  products: MappedProductRow[];
  created: number;
  updated: number;
  failed: number;
  results: ImportRowResult[];
  notes: string[];
  /** 兜底统计：有多少条字段不是模型抽的 */
  fallbackStats: BrandFallbackStats;
}

/** 映射过程的统计（用于把「哪些是模型抽的、哪些是兜底的」如实告诉用户） */
interface MapStats {
  /** 品类由关键词兜底判定（模型没给或给的不是字典内的 key）的产品数 */
  categoryFallback: number;
  /** 规格摘要取自官网产品名（官网页面没提供规格参数）的产品数 */
  specFallback: number;
  /** 型号从产品名里正则提取的产品数 */
  modelFallback: number;
}

/** 对外暴露的兜底统计（结构化，界面和自动检查都能直接用） */
export interface BrandFallbackStats {
  categoryFallback: number;
  specFallback: number;
  modelFallback: number;
  /** 参与本次映射的产品数 */
  total: number;
}

/** 字段抽取的批大小（比品类映射小：每项要回 model/spec/unit 三个字段，输出更长） */
const FIELD_BATCH = 15;
/** 品类映射的批大小（每项只回一个 category，输出短） */
const CATEGORY_BATCH = 30;
/** 降批重试的最小粒度：再小就放弃这一小段，走确定性兜底 */
const MIN_BATCH = 4;
/** 同时最多几个模型请求在飞 */
const LLM_CONCURRENCY = 4;

/**
 * 批量抽取用的高频模型。
 *
 * **为什么不是默认的推理模型**（实测 2026-10-21，真实 SYMI 产品名单、4 批 × 15 个并发）：
 * | 模型 | 4 批总耗时 | 输出 |
 * |---|---|---|
 * | MiniMax-M3 | 34.9s | 4/4 成功 |
 * | MiniMax-M2.7-highspeed | **8.7s** | 4/4 成功，样例逐字相同 |
 * | MiniMax-M3.1-Flash | 18.2s | 4/4 成功 |
 *
 * 这个任务是「给产品挑品类 / 抽三个字段」的**轻量结构化活**，
 * 推理模型的长思考在这里纯属浪费（还容易把输出挤到截断、导致 JSON 不完整）。
 * 用户在「模型配置」里指定了别的模型时，**以用户的为准**（见 `chat()` 的取值顺序）。
 */
const BATCH_MODEL = 'MiniMax-M2.7-highspeed';

/** 单次模型请求的超时：60 秒。
 * 通用对话用 240 秒（要等长回答），但批量抽取必须能快速失败重试 ——
 * 实测有过批次卡满 240 秒才失败的情况，那一次导入就多等了 4 分钟。 */
const BATCH_TIMEOUT_MS = 60_000;

/** 整个批处理阶段的重试预算：90 秒。
 * 超过就放弃重试、直接走确定性兜底 —— 重试是锦上添花，
 * 不能为了「多抽到几条规格」把用户的等待时间拖成不可接受。 */
const BATCH_BUDGET_MS = 90_000;

@Injectable()
export class BrandImportService {
  private readonly logger = new Logger(BrandImportService.name);

  constructor(
    private readonly site: BrandSiteService,
    private readonly transfer: ProductTransferService,
    private readonly llm: LlmService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 抓取品牌官网并转成我们的产品格式（**不落库**）。
   *
   * 供 Agent「先看看抓到了什么」用 —— 确认无误后再调导入接口落库。
   */
  async preview(tenantId: string, siteUrl: string, brand: string) {
    const fetched = await this.site.fetch(siteUrl, brand);
    const mapped = await this.mapToOurFormat(tenantId, brand, fetched.products);
    return {
      brand,
      siteName: fetched.siteName,
      sourceCategories: fetched.categories,
      usedCategories: [...new Set(mapped.rows.map((m) => m.category))],
      products: mapped.rows,
      notes: [...fetched.notes, ...mapped.notes],
      fallbackStats: mapped.stats,
    };
  }

  /**
   * 抓取品牌官网 → 转格式 → 直接落库。
   */
  async fetchAndImport(
    tenantId: string,
    userId: string,
    siteUrl: string,
    brand: string,
    opts: { updateExisting?: boolean } = {},
  ): Promise<BrandImportResult> {
    const preview = await this.preview(tenantId, siteUrl, brand);
    const imported = await this.transfer.importRows(tenantId, preview.products, opts);
    return {
      brand: preview.brand,
      siteName: preview.siteName,
      sourceCategories: preview.sourceCategories,
      usedCategories: preview.usedCategories,
      products: preview.products,
      created: imported.created,
      updated: imported.updated,
      failed: imported.failed,
      results: imported.results,
      notes: preview.notes,
      fallbackStats: preview.fallbackStats,
    };
  }

  /**
   * 把官网条目映射成我们的产品行。
   *
   * 映射分两步：
   * ① **品类**：官网分类名 → 我们的品类 key。用 LLM 一次性给出「分类映射表」，
   *    而不是逐个产品问一次 —— 100 个产品问 100 次既慢又容易前后不一致。
   * ② **逐产品字段**：型号（从产品名里抽，如「Z7二键」）、规格摘要、布置提示。
   *
   * **两条硬纪律（实测 2026-10-21 踩出来的）**：
   *
   * 1. **模型失败不许静默丢字段**。模型批量吐 JSON 时偶发解析失败
   *    （`LLM_JSON_PARSE_FAILED`，一次 30 个产品会整批 30 个字段全空），
   *    如果只 catch 掉继续跑，用户导入 115 个产品里有 30 个规格是空的、
   *    界面上却看不出任何异常 —— 这比导入失败更糟。
   *    → 现在是**降批重试**（品类 30 → 15 → 8 → 4，字段 15 → 8 → 4），
   *    重试到最小粒度还失败才走**确定性兜底**（规格取产品名、型号用正则从产品名抽），
   *    并且**把兜底了多少条如实写进 notes 与 fallbackStats**，界面上能看到。
   * 2. **兜底必须是确定的**。同一个官网抓两次，字段结果必须一样，
   *    否则产品库的数据不可复现（今天导进去有规格、明天再导就没了）。
   */
  private async mapToOurFormat(
    tenantId: string,
    brand: string,
    raw: RawBrandProduct[],
  ): Promise<{ rows: MappedProductRow[]; notes: string[]; stats: BrandFallbackStats }> {
    if (!raw.length) {
      throw new BadRequestException({
        code: 'BRAND_NO_PRODUCTS',
        message: '这个官网页面上没有解析到任何产品，请确认地址是不是品牌官网的产品中心页',
      });
    }

    const cats = await this.prisma.categoryDef.findMany({
      where: { active: true, OR: [{ tenantId: null }, { tenantId }] },
      orderBy: { sortOrder: 'asc' },
    });
    const catList = cats.map((c) => `${c.key}=${c.label}`).join('、');
    const catKeys = new Set(cats.map((c) => c.key));

    // ① 品类映射
    //
    // **按「官网分类 + 产品名」逐个判断，而不是整类一刀切**：
    // 官网的「灯控系统」里既有智能开关（品类=开关控制）也有磁吸灯（品类=灯光照明），
    // 只按分类名映射会把 62 个产品全打成「灯光照明」——
    // 那样导入后产品库里的分类是错的，报价选品会选错。
    // 分类名只作为**参考**给模型，模型看得到具体产品名才能判对。
    const catMap = await this.mapInBatches<{ category: string }>({
      label: '品牌品类判断',
      items: raw.map((p, i) => ({ i, name: p.name, sourceCategory: p.categoryName })),
      batchSize: CATEGORY_BATCH,
      systemPrompt: `你是智能家居产品资料助理。任务：给每个产品选一个品类 key。
品类字典：${catList}
输入每项含 {i, name, sourceCategory}（sourceCategory 是官网上的大类，仅作参考）。
请按**产品本身的用途**选品类：
- 智能开关、面板、插座 → switch
- 灯、射灯、灯带、筒射灯 → light
- 窗帘电机、遮阳 → curtain
- 空调/地暖/新风/温控 → hvac 或 climate
- 中控屏、主机 → panel
- 存在/人体传感器 → presence 或 sensor
- 网关、总线控制器、继电器模块 → gateway 或 network
只输出字典里存在的 key。返回 JSON 数组，每项 {i, category}，i 与输入一致。`,
      call: async (slice, systemPrompt) => {
        const mapped = await this.llm.chatJson<{ i: number; category: string }[]>({
          systemPrompt,
          prompt: JSON.stringify(slice),
          // **不挂知识库（rag）**：这个任务是「照着产品名挑品类」，
          // 知识库里的资料对它没用。挂了反而每批都多一次检索 + 一次审计写库。
          model: BATCH_MODEL,
          maxTokens: 8192,
          timeoutMs: BATCH_TIMEOUT_MS,
        });
        const out = new Map<number, { category: string }>();
        for (const m of mapped) {
          if (typeof m?.i === 'number' && catKeys.has(m.category)) out.set(m.i, { category: m.category });
        }
        return out;
      },
    });

    // 兜底：模型没给或给的不是字典内的 key → 用官网分类名做关键词匹配
    const stats: MapStats = { categoryFallback: 0, specFallback: 0, modelFallback: 0 };
    const fallbackCategory = catKeys.has('switch')
      ? 'switch'
      : (cats[0]?.key ?? 'switch');
    for (let i = 0; i < raw.length; i += 1) {
      if (catMap.has(i)) continue;
      const guess = guessCategory(raw[i].categoryName, cats)
        ?? guessCategory(raw[i].name, cats)
        ?? fallbackCategory;
      catMap.set(i, { category: guess });
      stats.categoryFallback += 1;
    }

    // ② 逐产品字段（分批，避免一次吐太多 JSON 解析失败）
    const fieldMap = await this.mapInBatches<{ model?: string; spec?: string; unit?: string }>({
      label: '品牌产品字段抽取',
      items: raw.map((p, i) => ({
        i,
        name: p.name,
        sourceCategory: p.categoryName,
        imageUrl: p.imageUrl,
        detailUrl: p.detailUrl,
      })),
      batchSize: FIELD_BATCH,
      systemPrompt: `你是智能家居产品资料助理。为每个产品抽取：
- model：型号/规格代号（产品名里括号或连字符后的那串，如「WJ-1.2N」「Z5-MAX-W」「X30」「Z7」；没有就给空串）
- spec：一行规格摘要（如「Mesh 无线｜调光调色｜12W」；尽量从名称推断，不确定就给空串）
- unit：计量单位（台/个/套/米；不明确给「台」）
返回 JSON 数组，每项 {i, model, spec, unit}，i 与输入一致。`,
      call: async (slice, systemPrompt) => {
        const got = await this.llm.chatJson<{ i: number; model?: string; spec?: string; unit?: string }[]>({
          systemPrompt,
          prompt: JSON.stringify(slice),
          // 同上：抽取任务不需要知识库上下文
          model: BATCH_MODEL,
          maxTokens: 16384,
          timeoutMs: BATCH_TIMEOUT_MS,
        });
        const out = new Map<number, { model?: string; spec?: string; unit?: string }>();
        for (const g of got) {
          if (typeof g?.i === 'number') out.set(g.i, g);
        }
        return out;
      },
    });

    const rows = raw.map((p, i): MappedProductRow => {
      const extra = fieldMap.get(i);
      const model = (extra?.model ?? '').trim() || guessModel(p.name);
      if (!extra?.model?.trim()) stats.modelFallback += 1;
      // 规格兜底用**官网产品名**：官网页面普遍不提供规格参数（实测 SYMI 官网详情页为空），
      // 产品名是唯一拿得到的事实。用它兜底至少不是编造的数据。
      const spec = (extra?.spec ?? '').trim() || p.name;
      if (!extra?.spec?.trim()) stats.specFallback += 1;
      return {
        name: p.name,
        category: catMap.get(i)?.category ?? fallbackCategory,
        brand,
        model: model.slice(0, 40),
        spec: spec.slice(0, 120),
        unit: (extra?.unit ?? '').trim() || '台',
        warranty: 12,
        pricingMode: 'per_unit',
        // 官网主图**不落库**，产品图一律用自绘品类图标（apps/web/src/lib/product-icons.ts）。
        //
        // 为什么不用官网原图（实测 2026-10-22，SYMI 官网图托管在第三方 CDN
        // 29363083.s21i.faiusr.com）：
        // 1. **热链**——导出的 PPTX 交给客户后，客户机器直接去请求那个 CDN。
        //    对方下线或改路径，交付给客户的方案就缺图；客户 IP 也白白漏给第三方。
        // 2. **授权**——官网图是对方站点的资源，交付物里长期依赖它，
        //    等于把「有没有授权」变成一个我们无法自证的外部依赖。
        // 3. 自绘图标是 SVG，画布合成与 PPT 嵌入都无损，39 个品类全覆盖，
        //    同品类靠编号 + 名称标签区分，不需要靠图片细节辨识。
        //
        // 门店自己拍的实拍图不受影响：那是自有素材，走产品中心的图片上传接口。
        imageUrl: '',
        sourceCategory: p.categoryName,
        sourceUrl: p.detailUrl,
      };
    });

    // 把「有多少条是兜底来的」如实告诉用户，不让静默降级变成看不见的数据质量问题
    const notes: string[] = [];
    if (stats.categoryFallback) {
      notes.push(`${stats.categoryFallback} 个产品的品类由关键词规则判定（模型未给出可用品类）`);
    }
    if (stats.specFallback) {
      notes.push(`${stats.specFallback} 个产品的规格摘要取自官网产品名（官网页面未提供规格参数）`);
    }
    if (stats.modelFallback) {
      notes.push(`${stats.modelFallback} 个产品的型号从官网产品名中提取`);
    }
    return {
      rows,
      notes,
      stats: { ...stats, total: raw.length },
    };
  }

  /**
   * 分批调用模型，**批次失败自动降批重试**。
   *
   * 为什么要有降批重试：模型一次吐 30 个产品的 JSON 时偶发解析失败
   * （输出被推理过程挤掉，JSON 不完整）。实测一次失败就是**整批 30 个产品的字段全空**，
   * 而界面上完全看不出异常。所以这里把失败的小段**再拆成两半**重试，
   * 拆到 `MIN_BATCH` 还不成才放弃这一小段（走调用方的确定性兜底）。
   *
   * **并发度恒定**：拆出来的半批是丢回同一个队列的，不是就地并行 ——
   * 就地并行会让并发翻倍（4 个 worker × 2 = 8 个请求同时在飞），
   * 既容易把模型服务打到限流，又不可控。走队列就永远只有 N 个请求在飞。
   */
  private async mapInBatches<T>(opts: {
    label: string;
    items: { i: number }[];
    batchSize: number;
    systemPrompt: string;
    call: (slice: { i: number }[], systemPrompt: string) => Promise<Map<number, T>>;
  }): Promise<Map<number, T>> {
    const merged = new Map<number, T>();
    const queue: { i: number }[][] = [];
    for (let start = 0; start < opts.items.length; start += opts.batchSize) {
      queue.push(opts.items.slice(start, start + opts.batchSize));
    }
    // 总预算：超了就直接走确定性兜底，不再重试（重试是锦上添花，不能拖垮整次导入）
    const deadline = Date.now() + BATCH_BUDGET_MS;

    const worker = async (): Promise<void> => {
      for (;;) {
        const slice = queue.shift();
        if (!slice) return;
        await this.runSlice(slice, opts, merged, deadline, queue);
      }
    };
    const n = Math.min(LLM_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return merged;
  }

  /** 处理一个小段；失败就拆成两半丢回队列重试 */
  private async runSlice<T>(
    slice: { i: number }[],
    opts: {
      label: string;
      systemPrompt: string;
      call: (s: { i: number }[], systemPrompt: string) => Promise<Map<number, T>>;
    },
    merged: Map<number, T>,
    deadline: number,
    queue: { i: number }[][],
  ): Promise<void> {
    try {
      const got = await opts.call(slice, opts.systemPrompt);
      for (const [k, v] of got) merged.set(k, v);
    } catch (e) {
      if (slice.length > MIN_BATCH && Date.now() < deadline) {
        // 一段吐不下 → 拆成两半继续试（失败率随批量大小下降）
        const mid = Math.ceil(slice.length / 2);
        queue.push(slice.slice(0, mid), slice.slice(mid));
        return;
      }
      this.logger.warn(
        `${opts.label}：${slice.length} 个产品降批重试后仍失败，改用确定性兜底：`
        + `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * 从产品名里确定性提取型号。
 *
 * 官网的型号基本都写在产品名里（「Z7二键智能开关」「WJ-1.2N 智能面板」「X30 中控屏」）。
 * 用规则取比让模型随机给可靠 —— 同一个产品名永远得到同一个型号。
 *
 * 只认「字母开头 + 数字」的组合：中文数字（「二键」）不是型号，
 * 纯数字（「3 路」）也不是 —— 宁可留空让用户填，也不要把垃圾填进型号字段。
 *
 * 导出是为了让冒烟测试能直接锁住这套规则（规则一改就该测出来）。
 */
export function guessModel(name: string): string {
  const m = name.match(/[A-Za-z]{1,6}[-\s]?\d[A-Za-z0-9.\-]*/);
  return m ? m[0].trim() : '';
}

/**
 * 关键词兜底：官网分类名或产品名 → 我们的品类 key。
 *
 * 只在 LLM 不可用时用（LLM 挂了不能让整个功能不可用）。
 * 命中不了就返回 null，由调用方决定兜底到哪个。
 *
 * 规则顺序有讲究（实测 2026-10-21）：
 * 「开关」要排在「灯」前面 —— 否则「智能开关」会被「灯控系统」里的「灯」先命中，
 * 归到「灯光照明」去。开关是开关、灯是灯，报价选品时不能混。
 */
function guessCategory(
  sourceName: string,
  cats: { key: string; label: string }[],
): string | null {
  const s = sourceName;
  const rules: [RegExp, string][] = [
    [/开关|插座|面板|按键/, 'switch'],
    [/窗帘|遮阳|卷帘|百叶|电机/, 'curtain'],
    [/射灯|筒射|灯带|磁吸灯|洗墙|照明|调光/, 'light'],
    [/温控|空调|地暖|新风|暖通|冷水/, 'hvac'],
    [/温湿度|温感/, 'climate'],
    [/存在|人体|光照|传感|探测器/, 'sensor'],
    [/中控屏|智能屏|主机|中枢/, 'panel'],
    [/网关|总线|继电器|工控|模块|控制器/, 'network'],
    [/音箱|音乐|背景音|广播/, 'audio'],
    [/门锁|门禁|可视门铃/, 'lock'],
  ];
  for (const [re, key] of rules) {
    if (re.test(s) && cats.some((c) => c.key === key)) return key;
  }
  return null;
}
