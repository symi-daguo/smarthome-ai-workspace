import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { NormalizedText } from './types.js';

const MAX_CONTENT_CHARS = 200_000;

/** 仅允许 http/https，防止内网探测与非 HTTP scheme 注入 */
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
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SmartHomeSaaS-Bot/0.1; +content-extraction)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
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
