/**
 * 本地静态服务 + API 反代。
 *
 * 为什么不直接 `file://` 加载前端：
 * - file:// 的 origin 是 null，localStorage 在部分场景下不可靠（登录态存不住）；
 * - 前端 `api.ts` 的 base 是同源相对路径（`/api/...`），file:// 下必然失败。
 *
 * 用一个本地 HTTP 服务承载前端并把 /api 反代到 API 进程，
 * 前端**零改动**就能跑，且与容器部署（nginx 同源反代）行为一致。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export interface ServerOptions {
  /** 前端产物目录 */
  webDir: string;
  /** API 端口 */
  apiPort: number;
}

export function startServer(opts: ServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const webRoot = resolve(opts.webDir);

  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api')) {
      proxy(req, res, opts.apiPort);
      return;
    }
    serveStatic(req, res, webRoot);
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolvePromise({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** /api 反代到本地 API 进程 */
function proxy(req: IncomingMessage, res: ServerResponse, apiPort: number): void {
  // 用顶部 import 的 request，不要在函数体里写 require()：
  // 桌面端当前编译产物是 CommonJS（package.json 没有 "type": "module"），
  // require 才恰好能用；一旦哪天加上 "type": "module"，
  // 这里会在**每一个 API 请求**上抛 require is not defined —— 而 /api 是全站必经之路。
  const target = httpRequest(
    {
      host: '127.0.0.1',
      port: apiPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  target.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: `本地服务未就绪：${(e as Error).message}` }));
  });
  req.pipe(target);
}

/** 静态文件 + SPA fallback */
function serveStatic(req: IncomingMessage, res: ServerResponse, webRoot: string): void {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  // 目录穿越防护：normalize 后必须仍在 webRoot 之内
  const target = resolve(join(webRoot, normalize(urlPath)));
  let file = target;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(webRoot, 'index.html');
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端产物缺失');
    return;
  }
  const ext = extname(file).toLowerCase();
  const isIndex = file.endsWith('index.html');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // index.html 不缓存（发版后别加载到失效 chunk）；带 hash 的静态资源长期缓存
    'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}
