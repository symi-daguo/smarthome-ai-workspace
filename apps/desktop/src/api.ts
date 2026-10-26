/**
 * 本地 API 子进程管理。
 *
 * 为什么用 Electron 的 `utilityProcess` 而不是 `child_process.fork`：
 * Electron 官方文档明确建议优先用 utilityProcess —— 它是独立的 V8 上下文，
 * 与主进程隔离，且自带 Node 运行时，不需要系统装 Node。
 *
 * API 进程需要的全部环境变量在这里集中注入（端口、数据库连接串、密钥、上传目录），
 * 这就是《桌面打包方案.md》P0「抽离启动编排层」的落点：
 * 桌面端不依赖任何 .env 文件，全部走进程环境。
 */
import { utilityProcess, type UtilityProcess } from 'electron';

export interface ApiOptions {
  /** api 编译产物入口（dist/src/main.js） */
  entry: string;
  /** api 运行时目录（含 node_modules） */
  cwd: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  adminPhone: string;
  adminPassword: string;
  uploadDir: string;
  /** 部署级品牌：产品名（留空用内置默认） */
  brandName?: string;
  /** 部署级品牌：图标地址（留空用界面自带标识） */
  brandLogoUrl?: string;
  log: (msg: string) => void;
}

export interface ApiHandle {
  port: number;
  process: UtilityProcess;
  stop: () => Promise<void>;
}

export async function startApi(opts: ApiOptions): Promise<ApiHandle> {
  const child = utilityProcess.fork(opts.entry, [], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // 桌面单机模式：放行预置默认管理员密码（云服务器部署没有这个变量，红线依旧生效）
      DESKTOP_MODE: '1',
      PORT: String(opts.port),
      HOST: '127.0.0.1',
      DATABASE_URL: opts.databaseUrl,
      JWT_SECRET: opts.jwtSecret,
      JWT_EXPIRES_IN: '30d',
      SEED_ADMIN_PHONE: opts.adminPhone,
      SEED_ADMIN_PASSWORD: opts.adminPassword,
      UPLOAD_DIR: opts.uploadDir,
      // 桌面单机场景：只监听本机，CORS 同源（前端由本地静态服务同源提供）
      CORS_ORIGIN: '*',
      // 平台级模型配置留空由用户在界面里填（客户自备 key 是本项目的开源定位）
      MiniMax_API_KEY: process.env.MiniMax_API_KEY ?? '',
      LLM_BASE_URL: process.env.LLM_BASE_URL ?? '',
      LLM_API_KEY: process.env.LLM_API_KEY ?? '',
      IMAGE_PROVIDER: process.env.IMAGE_PROVIDER ?? 'minimax',
      // 部署级品牌：配置文件的值优先，其次进程环境变量（脚本部署用），都没有就留空用内置默认
      BRAND_NAME: opts.brandName ?? process.env.BRAND_NAME ?? '',
      BRAND_LOGO_URL: opts.brandLogoUrl ?? process.env.BRAND_LOGO_URL ?? '',
      COMFYUI_BASE_URL: process.env.COMFYUI_BASE_URL ?? '',
      COMFYUI_API_KEY: process.env.COMFYUI_API_KEY ?? '',
    },
    stdio: 'pipe',
  });

  child.stdout?.on('data', (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) opts.log(`[api] ${line.trim()}`);
  });
  child.stderr?.on('data', (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) opts.log(`[api!] ${line.trim()}`);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地 API 启动超时（60 秒）')), 60_000);
    const onExit = (code: number): void => {
      clearTimeout(timer);
      reject(new Error(`本地 API 进程退出（code ${code}）`));
    };
    child.once('exit', onExit);
    const check = setInterval(() => {
      void fetch(`http://127.0.0.1:${opts.port}/api/health`)
        .then((r) => {
          if (!r.ok) return;
          clearInterval(check);
          clearTimeout(timer);
          child.off('exit', onExit);
          resolve();
        })
        .catch(() => undefined);
    }, 300);
  });

  // Electron 的 UtilityProcess **没有** exitCode / signalCode，
  // 判断「是否已退出」只能自己记一个标志。
  let alreadyExited = false;
  child.once('exit', () => {
    alreadyExited = true;
  });

  return {
    port: opts.port,
    process: child,
    /**
     * 停掉 API 子进程，**并等它真的死**。
     *
     * 为什么不能只 `child.kill()` 就返回：
     * `utilityProcess.kill()` 是异步的（发 SIGTERM）。如果主进程在 kill 发出后立刻退出，
     * 子进程会因为「父没了」而被孤儿化 —— 实测留下一个 PPID=1 的 `node dist/src/main.js`，
     * 带着内嵌 PostgreSQL 一起跑了 4 小时 50 分钟，占着内存、端口和数据库锁。
     * 所以这里必须等 'exit' 事件真的来了才算完，超时则强杀。
     */
    stop: async () => {
      if (alreadyExited) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      const gone = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ]);
      if (!gone) {
        // 还活着就强杀：绝不能把孤儿留给用户
        const pid = child.pid;
        if (typeof pid === 'number') {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* 已经没了 */
          }
        }
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    },
  };
}
