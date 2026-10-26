/**
 * 品牌官网产品抓取器。
 *
 * 用途：让 Agent 能从品牌官方站点把产品列表抓下来，转换成我们的产品库格式。
 * 设计取舍（决策阶梯：YAGNI → 代码库复用 → 标准库 → 原生能力）：
 *
 * - **不引入 headless 浏览器依赖**。产品中心的列表是服务端渲染进 HTML 的，
 *   抓取只需要「取 HTML → 正则抽结构」，用 Node 原生 fetch + 正则就够。
 *   引入 playwright 会让后端镜像大几百 MB，而这里根本用不到 JS 渲染。
 * - **抓取与「转成我们的格式」分开**：本文件只负责拿到「原始条目」
 *   （名称 / 分类 / 图片 / 详情页），格式转换交给 LLM 那一层（见 brand-import.service.ts）。
 *   这样格式规则变了不用改抓取器。
 * - **有超时**：外部站点不可控，fetch 必须带 signal（见 common/upstream-timeout.ts 的同类做法）。
 *
 * 站点适配：目前支持「建站平台的通用产品中心结构」，
 * 其余站点返回 SITE_NOT_SUPPORTED —— 宁可明确说不支持，也不要瞎猜出一个错格式。
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { fetchUpstream, describeUpstreamError, UPSTREAM_TIMEOUT_MS } from '../common/upstream-timeout.js';

/** 抓到的原始条目（还没转成我们的产品格式） */
export interface RawBrandProduct {
  /** 官网上的产品名 */
  name: string;
  /** 官网上的分类名（灯控系统 / 调光系统…） */
  categoryName: string;
  /** 产品主图（官网绝对地址） */
  imageUrl: string;
  /** 官网详情页地址 */
  detailUrl: string;
}

export interface BrandFetchResult {
  brand: string;
  siteName: string;
  categories: string[];
  products: RawBrandProduct[];
  /** 抓取过程中的提示（跳过的页数、截断说明等） */
  notes: string[];
}

/** 官网常见的 UA：默认 fetch 的 UA 会被风控直接拦（实测返回「可疑请求拦截通知」） */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 30_000;

/** 站点适配器：一个站点怎么找到「分类」和「产品」 */
interface SiteAdapter {
  /** 从首页 HTML 里取出各分类的模块 id（分页参数要用） */
  categories(html: string): { label: string; moduleId: string }[];
  /** 从某页 HTML 里取出该分类下的产品条目 */
  products(html: string, moduleId: string): RawBrandProduct[];
  /** 该分类还有下一页吗 */
  hasNextPage(html: string, moduleId: string): boolean;
}

/**
 * 建站平台通用产品中心适配器。
 *
 * 这类站点的产品中心结构（实测 2026-10-21 于某品牌官网）：
 * - 分类：`<span class="tabButtonText">灯控系统</span>`
 * - 产品图 + id：`<tr id="module{MOD}product{PID}">`（`PID` 就是详情页的数字 id）
 * - 产品名：同一张卡里的 `<a class="fk-productName" ...>名称</a>`
 * - 主图：`img[data-original]`
 * - 详情页：`/sys-pd/{PID}.html`
 * - 分页：`<div id="pagenation{MOD}">` 里有 `m{MOD}pageno%22%3A{N}` 形式的链接
 *
 * **关键坑（实测踩出来的）**：服务端返回的 HTML 属性用的是**单引号**
 * （`class='fk-productName'`），而浏览器里 JS 处理过之后是双引号。
 * 只按双引号写正则 → 后端抓取一个产品都解析不出来（前端浏览器抓却正常）。
 * 所以下面的正则**两种引号都认**。
 *
 * 用正则而不是 DOM 解析器：Node 没有内置 DOM；正则只取稳定的结构标记，
 * 且**解析失败时宁可少取也不要取错**（错数据会污染产品库）。
 */
const productCenterAdapter: SiteAdapter = {
  categories(html) {
    const labels = [...html.matchAll(/<span class=['"]tabButtonText['"]>([^<]+)<\/span>/g)].map((m) =>
      decodeEntities(m[1].trim()),
    );
    // 分类 → moduleId：每个分类有一个产品列表容器 productList{MOD}，
    // 容器里的产品是 module{MOD}product{PID}，分页是 pagenation{MOD}。
    // **靠容器反查而不是靠分页链接反查** —— 有些分类没有分页（产品不到一页），
    // 只看分页链接会漏掉它们，导致「分类名与 moduleId 错位」。
    //
    // **分类名与 moduleId 之间在页面上唯一的关联信号就是顺序**：
    // 实测 SYMI 官网页面里 10 个分类名连续出现、10 个 productList 容器
    // 也按同样顺序连续出现，两者一一对应（灯控=426、调光=430、遮阳=434…）。
    // 页面没有给出「分类名 ↔ moduleId」的直接标记，所以只能按顺序配对；
    // 数量对不上时多出来的分类拿不到容器（下面会记提示并跳过），
    // **绝不允许退化成「抓页面上所有产品」** —— 那样会把别的分类的产品算错。
    const listIds = [...new Set([...html.matchAll(/id=['"]productList(\d+)['"]/g)].map((m) => m[1]))];
    const moduleIds = labels.map((_, i) => listIds[i] ?? '');
    return labels.map((label, i) => ({ label, moduleId: moduleIds[i] }));
  },
  products(html, moduleId) {
    // 只取属于该分类模块的 tr：module{MOD}product{PID}
    //
    // **moduleId 为空时必须一个都不取**：
    // 早期版本这里用 `\d+` 通配，结果是「某个分类没匹配到容器」时
    // 把**页面上所有分类的产品**都算到这个分类名下（既是重复，
    // 又会把别的分类的产品错记分类）。宁可少取，也不要取错。
    if (!moduleId) return [];
    const mod = moduleId;
    const re = new RegExp(
      `<tr id=['"]module${mod}product(\\d+)['"][\\s\\S]{0,2000}?</tr>`,
      'g',
    );
    const out: RawBrandProduct[] = [];
    for (const m of html.matchAll(re)) {
      const pid = m[1];
      const block = m[0];
      const name =
        /<a[^>]*class=['"]fk-productName['"][^>]*>([^<]+)<\/a>/.exec(block)?.[1]
        ?? /<img[^>]*alt=['"]([^'"]+)['"]/.exec(block)?.[1]
        ?? '';
      const img = /<img[^>]*data-original=['"]([^'"]+)['"]/.exec(block)?.[1] ?? '';
      const clean = decodeEntities(name).trim();
      if (!clean) continue;
      out.push({
        name: clean,
        categoryName: '', // 分类在调用侧按 moduleId 填
        imageUrl: img ? absolute(img) : '',
        detailUrl: `/sys-pd/${pid}.html`,
      });
    }
    return out;
  },
  hasNextPage(html, moduleId) {
    // 分页容器 pagenation{MOD} 里还有 pageno 链接 = 还有下一页
    if (!moduleId) return false;
    const p = html.match(
      new RegExp(`id=['"]pagenation${moduleId}['"][\\s\\S]{0,6000}?(?=<div id=['"]pagenation|</div>\\s*<div id=['"]pagenation|$)`, 'i'),
    );
    const scope = p?.[0] ?? html;
    return new RegExp(`m${moduleId}pageno`).test(scope);
  },
};


/** HTML 实体解码（官网里 &amp; &nbsp; &#39; 等） */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
}

/** 协议相对地址（//host/path）补全成 https */
function absolute(u: string): string {
  if (!u) return '';
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('http')) return u;
  return u;
}

@Injectable()
export class BrandSiteService {
  private readonly logger = new Logger(BrandSiteService.name);

  /**
   * 抓取品牌官网的产品列表。
   *
   * @param siteUrl 品牌官网的产品中心地址
   * @param brand   品牌名（写进产品行的 brand 字段）
   */
  async fetch(siteUrl: string, brand: string): Promise<BrandFetchResult> {
    const base = normalizeSite(siteUrl);
    const html = await this.get(base.href);
    const adapter = this.pickAdapter(html);
    if (!adapter) {
      throw new BadRequestException({
        code: 'SITE_NOT_SUPPORTED',
        message: '这个地址上没找到产品列表。'
          + '请填品牌官网「产品中心」页面的地址（不是网站首页），'
          + '或改用「导入」按格式模板把产品填进来。',
      });
    }

    const notes: string[] = [];
    const cats = adapter.categories(html);
    if (!cats.length) {
      throw new BadRequestException({
        code: 'SITE_NOT_SUPPORTED',
        message: '这个页面上没找到产品分类。'
          + '多半是填了网站首页而不是「产品中心」页；'
          + '也可能是站点结构变了或需要登录才能看产品。',
      });
    }

    const products: RawBrandProduct[] = [];
    const seen = new Set<string>();

    for (const cat of cats) {
      // 分类没匹配到产品容器：跳过并说明，**不要退化成抓页面上所有产品**
      // （那会把别的分类的产品算到这个分类名下，分类错乱且无法察觉）。
      if (!cat.moduleId) {
        notes.push(`「${cat.label}」在官网页面上没有找到对应的产品列表，已跳过`);
        continue;
      }

      let page = 1;
      // 上限 50 页：防止站点分页参数异常导致死循环
      while (page <= 50) {
        const pageHtml = page === 1 ? html : await this.get(this.pageUrl(base, cat.moduleId, page));
        const list = adapter.products(pageHtml, cat.moduleId);
        let added = 0;
        for (const p of list) {
          const item = { ...p, categoryName: cat.label };
          if (seen.has(item.name)) continue;
          seen.add(item.name);
          products.push(item);
          added += 1;
        }
        if (added === 0) break; // 这一页没有新东西 = 到头了
        if (!adapter.hasNextPage(pageHtml, cat.moduleId)) break;
        page += 1;
      }
      if (page > 50) notes.push(`「${cat.label}」分页超过 50 页，已截断`);
    }

    return {
      brand,
      siteName: base.host,
      categories: cats.map((c) => c.label),
      products,
      notes,
    };
  }

  /** 取 HTML（带超时与常见响应头） */
  private async get(url: string): Promise<string> {
    try {
      const res = await fetchUpstream(
        url,
        {
          method: 'GET',
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
        },
        FETCH_TIMEOUT_MS,
        'LLM',
        '品牌官网',
        {
          invalidUrl: '这不是一个有效的网址，请填完整的地址（例如 http://example.com/products）',
          tls: '这个网址的 https 证书有问题（不少品牌官网的证书会过期），请改用 http:// 再试',
          unreachable: '这个网址连不上，请检查地址是否写对（是否漏了 www 或产品中心页路径）',
        },
      );
      const text = await res.text();
      // 风控拦截页：标题就是「可疑请求拦截通知」
      if (/可疑请求拦截|访问受限|安全验证/.test(text.slice(0, 4000))) {
        throw new BadRequestException({
          code: 'SITE_BLOCKED',
          message: '品牌官网拒绝了这次访问（触发了站点的风控），请稍后重试。',
        });
      }
      return text;
    } catch (e) {
      // 已经是带错误码的异常（超时/连不上/风控）时，原样抛出
      const msg = e instanceof Error ? e.message : String(e);
      if (/SITE_BLOCKED:/.test(msg) || e instanceof BadRequestException) throw e;
      const described = describeUpstreamError(e, 'LLM', '品牌官网', FETCH_TIMEOUT_MS, {
        invalidUrl: '这不是一个有效的网址，请填完整的地址（例如 http://example.com/products）',
        tls: '这个网址的 https 证书有问题（不少品牌官网的证书会过期），请改用 http:// 再试',
        unreachable: '这个网址连不上，请检查地址是否写对（是否漏了 www 或产品中心页路径）',
      });
      throw new BadRequestException({
        code: described?.code ?? 'SITE_FETCH_FAILED',
        message: described
          ? `品牌官网抓取失败：${described.message}`
          : `品牌官网抓取失败：${msg}`,
      });
    }
  }

  /**
   * 挑适配器：按站点特征判断。
   *
   * 特征就是「产品中心有分类切换条」—— 没有它就不是这类站点，
   * 宁可明确说不支持，也不要瞎猜出一个错格式。
   */
  private pickAdapter(html: string): SiteAdapter | null {
    return /tabButtonText/.test(html) ? productCenterAdapter : null;
  }

  /** 分页 URL：沿用建站平台的 _reqArgs 约定 */
  private pageUrl(base: URL, moduleId: string, page: number): string {
    const args = { args: { [`m${moduleId}pageno`]: page, id: '103' }, type: 11 };
    const u = new URL(base.href);
    u.searchParams.set('_reqArgs', JSON.stringify(args));
    return u.toString();
  }}

/** 规整站点地址：补 https、去尾斜杠 */
function normalizeSite(input: string): URL {
  let s = input.trim();
  if (!s) {
    throw new BadRequestException({ code: 'SITE_URL_REQUIRED', message: '请提供品牌官网地址' });
  }
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    // 地址根本不是 URL（例如漏了域名、填了中文）——
    // 不包一下的话这里是 TypeError，接口会回 500，用户只看到「服务器错误」
    throw new BadRequestException({
      code: 'SITE_URL_INVALID',
      message: '这个地址不是有效的网址，请填完整的官网地址（例如 https://example.com/products）',
    });
  }
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u;
}
