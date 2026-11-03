import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { NormalizedText } from './types.js';

const MAX_CONTENT_CHARS = 200_000;

/**
 * 内网 / 回环 / 链路本地地址判定。
 *
 * 为什么需要：服务端替用户去抓页面，如果允许抓 `http://127.0.0.1:3080/api/...`
 * 或 `http://169.254.169.254/latest/meta-data/`，这条链路就成了一台**内网代理** ——
 * 攻击者能借它探内网端口、读云主机元数据。注释原来写着「防止内网探测」，
 * 但代码只校验了协议，等于承诺了没做的事。
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // IPv6：回环 / 未指定 / 唯一本地（fc00::/7）/ 链路本地（fe80::/10）
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地：云厂商元数据服务就在这一段
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** 仅允许 http/https 且必须是公网地址，防止内网探测与非 HTTP scheme 注入 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('INVALID_URL: 链接格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('INVALID_URL_SCHEME: 仅支持 http/https 链接');
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error('INVALID_URL_PRIVATE: 不能填写内网或本机地址（服务端只抓公网页面）');
  }
  return url;
}

/**
 * P2 网页抓取：服务端拉取 -> Readability 正文抽取。
 * ponytail: 本期不实现 robots.txt 缓存与分布式限流，单租户本地使用；
 * 云端部署时在网关层补频率限制与 robots 规则库。
 */
export async function parseWebPage(rawUrl: string): Promise<NormalizedText> {
  const url = assertPublicHttpUrl(rawUrl);

  const response = await fetch(url, {
    // 不跟随跳转：跳转目标不经过上面那道公网校验，
    // 一个公网地址 302 到 http://169.254.169.254/ 就能绕过它。
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SmartHomeWorkspace-Bot/0.1; +content-extraction)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '(未提供 Location)';
    throw new Error(`FETCH_REDIRECT: 该链接发生跳转（HTTP ${response.status} → ${location}），请填写最终地址`);
  }
  if (!response.ok) {
    throw new Error(`FETCH_FAILED: 目标页面返回 ${response.status}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    throw new Error('UNSUPPORTED_CONTENT_TYPE: 仅支持抓取网页（HTML），文件请使用上传入口');
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url: url.href });
  const reader = new Readability(dom.window.document, { charThreshold: 200 });
  const article = reader.parse();
  dom.window.close();

  if (!article?.textContent || article.textContent.trim().length < 40) {
    throw new Error('READABILITY_EMPTY: 未能从页面提取有效正文（可能需要登录或为 JS 渲染页面）');
  }

  const content = article.textContent.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').slice(0, MAX_CONTENT_CHARS);
  return {
    title: article.title?.trim() || url.hostname,
    content,
    baseConfidence: 90,
    meta: { url: url.href, siteName: article.siteName ?? url.hostname },
  };
}
