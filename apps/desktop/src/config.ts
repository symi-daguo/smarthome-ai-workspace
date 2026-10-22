/**
 * 桌面端数据目录与持久化配置。
 *
 * 设计约束（来自《桌面打包方案.md》路线乙「单机全内嵌」）：
 * - **数据全在用户目录**，不随应用升级/替换而丢：pgdata（数据库）、uploads（产物文件）、
 *   desktop-config.json（密钥与端口）。
 * - 应用升级只换 app bundle，用户目录不动 —— 这就是「升级不丢数据」的实现方式。
 */
import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface DesktopConfig {
  /** JWT 签名密钥：首次启动生成后持久化，重启后旧登录态仍然有效 */
  jwtSecret: string;
  /** 数据库端口（每次启动可换，连接串动态生成） */
  dbPort: number;
  /** 本地 API 端口 */
  apiPort: number;
  /** 数据库是否已初始化（决定要不要跑 initdb 与建库） */
  dbInitialized: boolean;
  /** 是否已跑过 migrate + seed */
  migrated: boolean;
  /**
   * 预置的管理员凭据是否已经失效（手机号或密码被改过）。
   * 每次启动用「默认手机号 + 默认密码」试登一次：登得进去说明还在用公开示例值，
   * 就提醒用户去个人中心改掉；登不进去说明已经改过，不再打扰。
   * 以前这个字段只写 false、从不变 true，导致「首次启动」弹窗每次启动都弹。
   */
  adminPasswordChanged: boolean;
}

const CONFIG_FILE = 'desktop-config.json';

export function userDataDir(): string {
  return app.getPath('userData');
}

export function dataPaths(): { root: string; pgdata: string; uploads: string; configFile: string; logs: string } {
  const root = userDataDir();
  return {
    root,
    pgdata: join(root, 'pgdata'),
    uploads: join(root, 'api-uploads'),
    configFile: join(root, CONFIG_FILE),
    logs: join(root, 'logs'),
  };
}

export function ensureDirs(): void {
  const p = dataPaths();
  for (const dir of [p.root, p.uploads, p.logs]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): DesktopConfig {
  const p = dataPaths();
  ensureDirs();
  if (existsSync(p.configFile)) {
    try {
      const raw = JSON.parse(readFileSync(p.configFile, 'utf8')) as Partial<DesktopConfig>;
      if (raw.jwtSecret && raw.dbPort && raw.apiPort) {
        return {
          jwtSecret: raw.jwtSecret,
          dbPort: raw.dbPort,
          apiPort: raw.apiPort,
          dbInitialized: raw.dbInitialized === true,
          migrated: raw.migrated === true,
          adminPasswordChanged: raw.adminPasswordChanged === true,
        };
      }
    } catch {
      // 配置损坏：当作首次启动重建。密钥会变，代价是旧登录态失效（用户重新登录即可），
      // 远好过因为一个坏 JSON 就起不来。
    }
  }
  const fresh: DesktopConfig = {
    jwtSecret: randomBytes(32).toString('hex'),
    dbPort: 0,
    apiPort: 0,
    dbInitialized: false,
    migrated: false,
    adminPasswordChanged: false,
  };
  saveConfig(fresh);
  return fresh;
}

export function saveConfig(cfg: DesktopConfig): void {
  const p = dataPaths();
  ensureDirs();
  writeFileSync(p.configFile, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 找一段当前空闲的 TCP 端口（只绑 127.0.0.1，拿到后立刻释放） */
export async function findFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        if (port) resolve(port);
        else reject(new Error('无法分配空闲端口'));
      });
    });
  });
}

/**
 * 从 API 运行时目录加载 pg。
 *
 * 为什么不直接 `import 'pg'`：桌面端的 asar **不带任何 node_modules**，
 * pg 属于 API 运行时那一整套（见 electron-builder.yml 的 extraResources）。
 * 之前把 pg 写成桌面端的 dependencies，electron-builder 的依赖收集会顺着
 * pnpm 的软链把整个工作区的 devDependencies 一起卷进 asar —— 实测 asar 涨到 308MB。
 * 现在 asar 只放主进程代码（约 32KB），依赖一律从运行时目录取。
 */
export function loadPg(apiDir: string): typeof import('pg') {
  const require = createRequire(join(apiDir, 'package.json'));
  return require('pg') as typeof import('pg');
}
