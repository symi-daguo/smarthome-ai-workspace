/**
 * 产品库导入导出。
 *
 * 目的：让产品库能进也能出 ——
 * - **导出**：把「我的产品库」导出成标准文件（CSV 给 Excel 改价用，JSON 给程序用）。
 * - **导入**：把这个文件再导回来（或从品牌官网抓下来转好后导进来）。
 *
 * 关键设计（决策阶梯：YAGNI → 代码库复用 → 标准库 → 原生能力 → 最少可工作代码）：
 *
 * - **不引入 xlsx 依赖**。CSV 用一行代码拼，Excel 双击就能开、也能再存回 CSV。
 *   引入 xlsx 库只为「多 sheet」是不划算的（本项目的导出就是一张表）。
 * - **CSV 的读写用标准库**：`TextEncoder`/`TextDecoder` 处理 UTF-8，
 *   BOM 让 Excel 正确识别中文（不加 BOM 的话 Excel 会把中文显示成乱码 —— 这坑很常见）。
 * - **导入按「名称 + 品牌」幂等**：同名同品牌视为同一条，走更新而不是插入，
 *   这样「导出 → 改价 → 导回」不会产生一堆重复行。
 * - **导入严格校验**：品类必须在字典里、价格非负、必填项齐全。
 *   校验失败**整批不落库**并逐行报出原因 —— 半截数据比不导入更糟。
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import type { Prisma } from '@prisma/client';

/** 导入/导出的产品行（对外格式） */
export interface ProductRow {
  name: string;
  category: string;
  brand?: string;
  model?: string;
  unit?: string;
  sku?: string;
  barcode?: string;
  snRule?: string;
  spec?: string;
  warranty?: number;
  priceRetail?: number;
  priceDealer?: number;
  priceProject?: number;
  rebateL1?: number;
  rebateL2?: number;
  rebateDesigner?: number;
  pricingMode?: 'per_unit' | 'per_order';
  perRoom?: string;
  imageUrl?: string;
  iconKey?: string;
}

/** CSV 列顺序（导出与导入共用，保证往返一致） */
export const PRODUCT_CSV_COLUMNS = [
  'name',
  'category',
  'brand',
  'model',
  'unit',
  'sku',
  'barcode',
  'snRule',
  'spec',
  'warranty',
  'priceRetail',
  'priceDealer',
  'priceProject',
  'rebateL1',
  'rebateL2',
  'rebateDesigner',
  'pricingMode',
  'perRoom',
  'imageUrl',
  'iconKey',
] as const;

/** CSV 的 UTF-8 BOM（Excel 靠它识别中文；不加就乱码） */
const CSV_BOM = '\uFEFF';

/**
 * 导入格式契约：**每一个字段的机器可读定义**。
 *
 * 这份定义是导入校验的**唯一事实源** —— 界面上给客户看的说明、
 * 客户自己的 Agent 要填的字段清单、下载的模板表头，全部来自这里，
 * 所以不会出现「文档写的和实际校验对不上」的情况。
 *
 * 约定：字段顺序 = CSV 列顺序 = 导出顺序 = 导入顺序。
 */
export interface ProductFieldSpec {
  /** 字段名（CSV 表头 / JSON 键名） */
  name: string;
  /** 是否必填 */
  required: boolean;
  /** 值类型 */
  type: 'string' | 'number' | 'enum';
  /** 中文说明 */
  desc: string;
  /** 留空时的默认值 */
  default?: string | number;
  /** 取值范围或枚举值 */
  range?: string;
  /** 示例值 */
  example?: string | number;
}

export const PRODUCT_FIELD_SPECS: ProductFieldSpec[] = [
  { name: 'name', required: true, type: 'string', desc: '产品名称', range: '不超过 60 字', example: '智能开关 Z7 二键' },
  { name: 'category', required: true, type: 'string', desc: '品类 key（取 categories 列表里的值，不能自己编）', example: 'switch' },
  { name: 'brand', required: false, type: 'string', desc: '品牌名', default: '', example: 'SYMI亖米' },
  { name: 'model', required: false, type: 'string', desc: '型号 / 规格代号', default: '', range: '超过 40 字会被截断', example: 'Z7' },
  { name: 'unit', required: false, type: 'string', desc: '计量单位', default: '台', range: '超过 10 字会被截断', example: '台' },
  { name: 'sku', required: false, type: 'string', desc: '内部编码', default: '', example: 'SW-Z7-2K' },
  { name: 'barcode', required: false, type: 'string', desc: '条码', default: '', example: '6971234567890' },
  { name: 'snRule', required: false, type: 'string', desc: '序列号规则', default: '', example: 'Z7-{序号:4}' },
  { name: 'spec', required: false, type: 'string', desc: '规格摘要（一句话）', default: '', range: '超过 120 字会被截断', example: '单火｜86 型底盒｜每路 1000W' },
  { name: 'warranty', required: false, type: 'number', desc: '质保期（月）', default: 12, range: '0 ~ 600 的整数', example: 24 },
  { name: 'priceRetail', required: false, type: 'number', desc: '指导价（元）', default: 0, range: '0 ~ 10000000 的整数', example: 268 },
  { name: 'priceDealer', required: false, type: 'number', desc: '渠道价（元）', default: 0, range: '0 ~ 10000000 的整数', example: 210 },
  { name: 'priceProject', required: false, type: 'number', desc: '工程价（元）', default: 0, range: '0 ~ 10000000 的整数', example: 188 },
  { name: 'rebateL1', required: false, type: 'number', desc: '一级返点（%）', default: 0, range: '0 ~ 100 的整数', example: 5 },
  { name: 'rebateL2', required: false, type: 'number', desc: '二级返点（%）', default: 0, range: '0 ~ 100 的整数', example: 3 },
  { name: 'rebateDesigner', required: false, type: 'number', desc: '设计师返点（%）', default: 0, range: '0 ~ 100 的整数', example: 2 },
  { name: 'pricingMode', required: false, type: 'enum', desc: '计价方式', default: 'per_unit', range: 'per_unit（按数量） / per_order（按单总价）', example: 'per_unit' },
  { name: 'perRoom', required: false, type: 'string', desc: '每房间用量说明', default: '', example: '每房间 1 个' },
  { name: 'imageUrl', required: false, type: 'string', desc: '产品主图地址（品牌官网上的图直接用原地址）', default: '', example: 'https://example.com/img/z7.jpg' },
  { name: 'iconKey', required: false, type: 'string', desc: '没有主图时用的品类图标 key', default: '', example: 'switch' },
];

/** 单行导入的校验结果 */
export interface ImportRowResult {
  index: number;
  name: string;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  id?: string;
  message?: string;
}

@Injectable()
export class ProductTransferService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 导出「我的产品库」。
   * @param scope mine=我的产品库（默认）| all=公共库+我的库
   */
  async exportRows(tenantId: string, scope: 'mine' | 'all' = 'mine'): Promise<ProductRow[]> {
    const rows = await this.prisma.product.findMany({
      where:
        scope === 'all'
          ? { active: true, OR: [{ tenantId: null }, { tenantId }] }
          : { tenantId, active: true },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => ({
      name: r.name,
      category: r.category,
      brand: r.brand,
      model: r.model,
      unit: r.unit,
      sku: r.sku,
      barcode: r.barcode,
      snRule: r.snRule,
      spec: r.spec,
      warranty: r.warranty,
      priceRetail: r.priceRetail,
      priceDealer: r.priceDealer,
      priceProject: r.priceProject,
      rebateL1: r.rebateL1,
      rebateL2: r.rebateL2,
      rebateDesigner: r.rebateDesigner,
      pricingMode: (r.pricingMode === 'per_order' ? 'per_order' : 'per_unit') as 'per_unit' | 'per_order',
      perRoom: r.perRoom,
      imageUrl: r.imageUrl,
      iconKey: r.iconKey,
    }));
  }

  /** 导出为 CSV（带 UTF-8 BOM，Excel 打开中文不乱码） */
  toCsv(rows: ProductRow[]): string {
    const lines = [PRODUCT_CSV_COLUMNS.join(',')];
    for (const r of rows) {
      lines.push(
        PRODUCT_CSV_COLUMNS.map((c) => csvCell(r[c] as string | number | undefined)).join(','),
      );
    }
    // BOM 用显式的 \uFEFF 写，不在源码里放不可见字符：
    // 源码里的裸 BOM 字面量经过各种编辑器/传输可能被改写，
    // 结果就是「看着有 BOM、实际字节里没有」——Excel 直接把中文显示成乱码。
    return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
  }

  /** 导出为 JSON（给程序用） */
  toJson(rows: ProductRow[]): string {
    return JSON.stringify({ version: 1, products: rows }, null, 2);
  }

  /**
   * 解析 CSV 文本为产品行。
   *
   * 解析规则（都是实测踩出来的）：
   * - 允许带 UTF-8 BOM（Excel 导出的 CSV 一定有）
   * - 支持双引号包裹、字段内逗号与换行、`""` 转义成引号
   * - 空行跳过
   */
  parseCsv(text: string): string[][] {
    const clean = text.replace(/^\uFEFF/, '');
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuote = false;
    for (let i = 0; i < clean.length; i += 1) {
      const ch = clean[i];
      if (inQuote) {
        if (ch === '"') {
          if (clean[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuote = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        inQuote = true;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        continue;
      }
      if (ch === '\r') continue;
      if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        continue;
      }
      field += ch;
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  /** CSV 文本 → 产品行（首行是表头） */
  csvToRows(text: string): ProductRow[] {
    const table = this.parseCsv(text);
    if (!table.length) return [];
    const header = table[0].map((h) => h.trim());
    const out: ProductRow[] = [];
    for (const line of table.slice(1)) {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => {
        obj[h] = (line[i] ?? '').trim();
      });
      out.push(this.coerceRow(obj as unknown as ProductRow));
    }
    return out;
  }

  /**
   * 导入格式契约：客户（或客户自己的 Agent）照着这份定义填数据。
   *
   * 一次请求就能拿到：字段清单与约束、当前可用的品类字典、CSV 模板表头、JSON 示例。
   * **不需要登录界面、不需要开浏览器** —— 客户的 Agent 可以直接调这个接口拿规范。
   */
  async importFormat(tenantId: string) {
    const cats = await this.prisma.categoryDef.findMany({
      where: { active: true, OR: [{ tenantId: null }, { tenantId }] },
      select: { key: true, label: true },
      orderBy: { sortOrder: 'asc' },
    });
    const example: ProductRow = {
      name: '智能开关 Z7 二键',
      category: cats[0]?.key ?? 'switch',
      brand: 'SYMI亖米',
      model: 'Z7',
      unit: '台',
      spec: '单火｜86 型底盒｜每路 1000W',
      warranty: 24,
      priceRetail: 268,
      priceDealer: 210,
      priceProject: 188,
      rebateL1: 5,
      rebateL2: 3,
      rebateDesigner: 2,
      pricingMode: 'per_unit',
      perRoom: '每房间 1 个',
      imageUrl: 'https://example.com/img/z7.jpg',
    };
    return {
      version: 1,
      /** 字段定义（顺序即 CSV 列顺序） */
      fields: PRODUCT_FIELD_SPECS,
      /** 当前可用的品类字典：category 必须填这里的 key */
      categories: cats.map((c) => ({ key: c.key, label: c.label })),
      /** CSV 表头（下载模板、拼文件都直接用这一行） */
      csvHeader: PRODUCT_CSV_COLUMNS.join(','),
      /** CSV 模板（只有表头，填了就能导） */
      csvTemplate: `${CSV_BOM}${PRODUCT_CSV_COLUMNS.join(',')}\r\n`,
      /** JSON 导入格式示例 */
      jsonExample: { version: 1, products: [example] },
      /** 导入规则（Agent 必读） */
      rules: [
        '必填字段只有两个：name（产品名称）、category（品类 key）',
        'category 必须取 categories 里的 key，不能自己编；填了字典外的值整批会被拒绝',
        '导入是「名称 + 品牌」幂等：同名同品牌视为同一条，走更新而不是新增',
        '整批原子：任何一行不合法就整批不落库，并逐行说明是哪一行的什么问题',
        '单次最多 2000 行',
        '价格与返点必须是整数；返点取值 0~100（百分数），价格 0~10000000',
        '不填的价格与返点按 0 处理；质保期默认 12 个月',
        'imageUrl 可以直接填品牌官网上的图片地址',
      ],
    };
  }

  /**
   * CSV 里所有值都是字符串，这里把数值字段转回数字。
   *
   * 踩过的坑：不转的话，导出的文件再导回来时 `priceRetail` 是字符串 "0"，
   * 校验会报「必须是 0~10000000 的整数」—— 明明是自己导出的文件，却导不回来。
   * 空串按「没填」处理（用 undefined，而不是 0），这样「留空」与「填 0」能区分开。
   */
  private coerceRow(r: ProductRow): ProductRow {
    const out: ProductRow = { ...r };
    const num = (v: unknown): number | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : (v as number); // 非数字就原样留着，交给校验报错
    };
    out.warranty = num(r.warranty);
    out.priceRetail = num(r.priceRetail);
    out.priceDealer = num(r.priceDealer);
    out.priceProject = num(r.priceProject);
    out.rebateL1 = num(r.rebateL1);
    out.rebateL2 = num(r.rebateL2);
    out.rebateDesigner = num(r.rebateDesigner);
    // 空串的 pricingMode 视为「没填」（CSV 里留空）
    if (r.pricingMode === ('' as unknown)) out.pricingMode = undefined;
    return out;
  }

  /**
   * 导入产品行到「我的产品库」。
   *
   * 幂等：同「名称 + 品牌」视为同一条 → 更新（可只带要改的字段）。
   * 整批事务：任何一行校验不过就整批不落库。
   */
  async importRows(
    tenantId: string,
    rows: ProductRow[],
    opts: { updateExisting?: boolean } = {},
  ): Promise<{ results: ImportRowResult[]; created: number; updated: number; failed: number }> {
    const updateExisting = opts.updateExisting ?? true;
    if (!rows.length) {
      throw new BadRequestException({ code: 'IMPORT_EMPTY', message: '没有可导入的产品行' });
    }
    if (rows.length > 2000) {
      throw new BadRequestException({ code: 'IMPORT_TOO_MANY', message: '单次最多导入 2000 行，请分批导入' });
    }

    // 品类白名单（公共 + 本租户自定义）
    const catKeys = new Set(
      (await this.prisma.categoryDef.findMany({
        where: { active: true, OR: [{ tenantId: null }, { tenantId }] },
        select: { key: true },
      })).map((c) => c.key),
    );

    // 逐行校验：先全部过一遍，有错就整批不落库
    const errors: string[] = [];
    const normalized: (ProductRow & { __name: string })[] = [];
    rows.forEach((raw, i) => {
      const line = i + 1;
      const name = (raw.name ?? '').trim();
      if (!name) {
        errors.push(`第 ${line} 行：产品名称为空`);
        return;
      }
      if (name.length > 60) {
        errors.push(`第 ${line} 行：产品名称超过 60 字`);
        return;
      }
      const category = (raw.category ?? '').trim();
      if (!category) {
        errors.push(`第 ${line} 行「${name}」：品类为空`);
        return;
      }
      if (!catKeys.has(category)) {
        errors.push(`第 ${line} 行「${name}」：品类「${category}」不在品类字典里，请先创建该分类或改用字典内的品类`);
        return;
      }
      const bad = checkNumbers(raw, name, line);
      if (bad) {
        errors.push(bad);
        return;
      }
      normalized.push({ ...raw, name, category, __name: name });
    });

    if (errors.length) {
      throw new BadRequestException({
        code: 'IMPORT_INVALID',
        message: `导入未执行：${errors.length} 行有问题。整批未落库，请修正后重试`,
        details: errors.slice(0, 50),
      });
    }

    // 落库：同「名称 + 品牌」视为同一条
    const results: ImportRowResult[] = [];
    let created = 0;
    let updated = 0;
    let failed = 0;
    for (const r of normalized) {
      const brand = (r.brand ?? '').trim();
      try {
        const existing = await this.prisma.product.findFirst({
          where: { tenantId, name: r.name, brand },
        });
        if (existing) {
          if (!updateExisting) {
            results.push({ index: results.length + 1, name: r.name, status: 'skipped', id: existing.id, message: '已存在，按「不覆盖」跳过' });
            continue;
          }
          const data = rowToDb(r);
          await this.prisma.product.update({ where: { id: existing.id }, data });
          updated += 1;
          results.push({ index: results.length + 1, name: r.name, status: 'updated', id: existing.id });
          continue;
        }
        const max = await this.prisma.product.findFirst({
          where: { tenantId },
          orderBy: { sortOrder: 'desc' },
        });
        const data = rowToDb(r);
        const created0 = await this.prisma.product.create({
          data: { ...data, tenantId, sortOrder: (max?.sortOrder ?? 0) + 1 } as never,
        });
        created += 1;
        results.push({ index: results.length + 1, name: r.name, status: 'created', id: created0.id });
      } catch (e) {
        failed += 1;
        results.push({
          index: results.length + 1,
          name: r.name,
          status: 'failed',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { results, created, updated, failed };
  }
}

/** 行 → 数据库字段（价格同步旧参考价区间，兼容点位清单/旧报价口径） */
function rowToDb(r: ProductRow): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: r.name,
    category: r.category,
    brand: (r.brand ?? '').trim(),
    model: (r.model ?? '').trim(),
    unit: (r.unit ?? '').trim() || '台',
    sku: (r.sku ?? '').trim(),
    barcode: (r.barcode ?? '').trim(),
    snRule: (r.snRule ?? '').trim(),
    spec: (r.spec ?? '').trim(),
    warranty: r.warranty ?? 12,
    priceRetail: r.priceRetail ?? 0,
    priceDealer: r.priceDealer ?? 0,
    priceProject: r.priceProject ?? 0,
    rebateL1: r.rebateL1 ?? 0,
    rebateL2: r.rebateL2 ?? 0,
    rebateDesigner: r.rebateDesigner ?? 0,
    pricingMode: r.pricingMode === 'per_order' ? 'per_order' : 'per_unit',
    perRoom: (r.perRoom ?? '').trim(),
    imageUrl: (r.imageUrl ?? '').trim(),
    iconKey: (r.iconKey ?? '').trim(),
  };
  // 旧参考价区间：min=工程价，max=指导价（与单个新增产品时保持一致）
  data.priceMin = r.priceProject ?? 0;
  data.priceMax = r.priceRetail ?? 0;
  return data;
}

/** 数值字段校验（返回第一条错误信息） */
function checkNumbers(r: ProductRow, name: string, line: number): string | null {
  // 数值字段在进入校验前已被转成 number|undefined（CSV 路径走 coerceRow，JSON 路径本来就是 number）
  const priceKeys = ['priceRetail', 'priceDealer', 'priceProject'] as const;
  for (const k of priceKeys) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10_000_000) {
      return `第 ${line} 行「${name}」：${k} 必须是 0~10000000 的整数`;
    }
  }
  const rebateKeys = ['rebateL1', 'rebateL2', 'rebateDesigner'] as const;
  for (const k of rebateKeys) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) {
      return `第 ${line} 行「${name}」：${k} 返点必须是 0~100 的整数`;
    }
  }
  if (r.warranty !== undefined && r.warranty !== null) {
    if (typeof r.warranty !== 'number' || !Number.isInteger(r.warranty) || r.warranty < 0 || r.warranty > 600) {
      return `第 ${line} 行「${name}」：质保期必须是 0~600 的整数（月）`;
    }
  }
  if (r.pricingMode !== undefined && !['per_unit', 'per_order'].includes(r.pricingMode)) {
    return `第 ${line} 行「${name}」：计价方式只能是 per_unit 或 per_order`;
  }
  return null;
}

/** CSV 单元格转义 */
function csvCell(v: string | number | undefined): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Prisma 类型（供外部引用） */
export type ProductDb = Prisma.ProductGetPayload<Record<string, never>>;
