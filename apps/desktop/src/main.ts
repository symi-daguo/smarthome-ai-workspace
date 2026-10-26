/**
 * 桌面端主进程：把「内嵌 PostgreSQL + 本地 API + 前端产物」编排成一个可双击运行的 App。
 *
 * 启动顺序（每一步失败都要能给出可读原因，而不是白屏）：
 *   1. 准备数据目录（pgdata / uploads / 配置 / 日志）
 *   2. 启动内嵌 PostgreSQL（首次自动 initdb + 建库）
 *   3. 跑迁移 + 种子（首次初始化数据；升级时只跑新增迁移）
 *   4. 拉起本地 API 进程（NestJS，跑编译产物）
 *   5. 起本地静态服务（前端产物 + /api 反代）
 *   6. 开窗口
 *
 * 数据全部落在用户目录（app.getPath('userData')），**应用升级只换程序不换数据**。
 */
import { BrowserWindow, app, dialog, shell } from 'electron';
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findFreePort, dataPaths, ensureDirs, loadConfig, saveConfig, type DesktopConfig } from './config';
import { startPostgres, type PostgresHandle } from './pg';
import { adminExists, runMigrations, runSeed } from './migrate';
import { startApi, type ApiHandle } from './api';
import { startServer } from './server';

/** 桌面端默认管理员凭据：与容器端 seed 的默认值一致，装完即能用 */
const DEFAULT_ADMIN_PHONE = '13800000000';
const DEFAULT_ADMIN_PASSWORD = 'Admin@123456';

/** 运行时资源目录：开发态在 apps/desktop/runtime，打包态在 app bundle 的 Resources */
function runtimeDir(): { pg: string; api: string; web: string; prismaCli: string; seedCli: string; manifestFile: string } {
  const base = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, '..', 'runtime');
  const apiDir = join(base, 'api');
  return {
    pg: join(base, 'pg'),
    api: apiDir,
    web: join(base, 'web'),
    // 运行时清单（prepare-runtime 产出）：记着 schema engine 的位置。
    // 引擎要复制到 bundle 之外再给 Prisma CLI 用，否则 CLI 会把它「恢复」成原始副本，
    // 破坏已签名 bundle 的封印（详见 src/migrate.ts 的说明）。
    manifestFile: join(base, 'manifest.json'),
    // Prisma CLI 入口（跟着 api 运行时一起部署（api 的 dependencies 里有 prisma），
    // 这样 prisma.config.ts 的 `import 'prisma/config'` 才解析得到 ——
    // 分成两棵 node_modules 会让配置加载失败。
    prismaCli: join(apiDir, 'node_modules', 'prisma', 'build', 'index.js'),
    seedCli: join(apiDir, 'dist', 'src', 'seed', 'cli.js'),
  };
}

let logFile = '';
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      /* 日志写失败不能影响主流程 */
    }
  }
}

let pg: PostgresHandle | null = null;
let api: ApiHandle | null = null;
let server: { port: number; close: () => Promise<void> } | null = null;
let mainWindow: BrowserWindow | null = null;

/** 超过这个大小就轮转（只保留上一代） */
const LOG_MAX_BYTES = 1024 * 1024;

/**
 * 日志轮转：超阈值就把当前日志改名成 desktop.log.1，只留一代。
 *
 * 为什么**不**每次启动都清空日志：崩溃现场是最有价值的日志。
 * 用户「反馈一下就重启一次」很常见，每次启动清空等于让支持流程无从下手。
 * 现在跨会话追加（每次会话以「桌面端启动」分隔），超过 1MB 轮转一代。
 */
function rotateLog(file: string): void {
  try {
    if (statSync(file).size < LOG_MAX_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
    // 文件不存在（或读不到）：直接从空日志开始，不用管
  }
}

async function bootstrap(): Promise<void> {
  const paths = dataPaths();
  // 先建目录再写日志：首次启动时 logs/ 还不存在，直接写会 ENOENT
  ensureDirs();
  logFile = join(paths.logs, 'desktop.log');
  rotateLog(logFile);
  log('桌面端启动');

  const rt = runtimeDir();
  for (const [name, dir] of Object.entries({ pg: rt.pg, api: rt.api, web: rt.web })) {
    if (!existsSync(dir)) {
      throw new Error(`运行时资源缺失：${name}（${dir}）。请先执行 pnpm --filter @app/desktop prepare:runtime`);
    }
  }
  if (!existsSync(rt.manifestFile)) {
    throw new Error(`运行时清单缺失：${rt.manifestFile}。请先执行 pnpm --filter @app/desktop prepare:runtime`);
  }

  const cfg: DesktopConfig = loadConfig();
  const dbPort = cfg.dbPort || (await findFreePort());
  const apiPort = cfg.apiPort || (await findFreePort());
  saveConfig({ ...cfg, dbPort, apiPort });

  // 1) 数据库
  pg = await startPostgres({
    apiDir: rt.api,
    binDir: join(rt.pg, 'bin'),
    libDir: join(rt.pg, 'lib'),
    pgdata: paths.pgdata,
    port: dbPort,
    logFile: join(paths.logs, 'postgres.log'),
    database: 'smarthome',
    user: 'smarthome',
  });
  log(`PostgreSQL 已就绪（端口 ${dbPort}${pg.initialized ? '，首次初始化' : ''}）`);

  const databaseUrl = `postgresql://smarthome:smarthome@127.0.0.1:${dbPort}/smarthome`;

  // 2) 迁移 + 种子
  await runMigrations({
    prismaCli: rt.prismaCli,
    apiDir: rt.api,
    databaseUrl,
    manifestFile: rt.manifestFile,
    workDir: paths.root,
    log,
  });
  // 判据落在**数据**上：库里没有管理员才需要跑种子。
  // 之前看的是配置里的 `migrated` 标记 —— 标记与库的实际状态可能对不上
  // （pgdata 被重建、种子中途失败、异常退出），对不上时种子会被永远跳过，
  // 用户装完打开应用，库里一个用户都没有，根本登不进去。
  let hasAdmin = false;
  try {
    hasAdmin = await adminExists({ apiDir: rt.api, databaseUrl, phone: DEFAULT_ADMIN_PHONE });
  } catch (e) {
    // 查不到就按「没有」处理：宁可重跑一次幂等种子，也不能漏掉管理员。
    log(`检查管理员失败（按不存在处理，将重跑种子）：${(e as Error).message}`);
  }
  if (hasAdmin) {
    log('管理员已存在，跳过种子（幂等）');
  } else {
    await runSeed({
      apiDir: rt.api,
      seedCli: rt.seedCli,
      databaseUrl,
      adminPhone: DEFAULT_ADMIN_PHONE,
      adminPassword: DEFAULT_ADMIN_PASSWORD,
      log,
    });
  }
  saveConfig({ ...loadConfig(), dbPort, apiPort, migrated: true });

  // 3) API
  api = await startApi({
    entry: join(rt.api, 'dist', 'src', 'main.js'),
    cwd: rt.api,
    port: apiPort,
    databaseUrl,
    jwtSecret: cfg.jwtSecret,
    adminPhone: DEFAULT_ADMIN_PHONE,
    adminPassword: DEFAULT_ADMIN_PASSWORD,
    uploadDir: paths.uploads,
    brandName: cfg.brandName ?? '',
    brandLogoUrl: cfg.brandLogoUrl ?? '',
    narrationTtsUrl: cfg.narrationTtsUrl ?? '',
    narrationTtsToken: cfg.narrationTtsToken ?? '',
    configFile: paths.configFile,
    log,
  });
  log(`本地 API 已就绪（端口 ${apiPort}）`);

  // 4) 前端静态服务
  server = await startServer({ webDir: join(rt.web, 'dist'), apiPort });
  log(`本地页面已就绪（端口 ${server.port}）`);

  // 5) 窗口
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: '智能家居 AI 工作台',
    backgroundColor: '#F6F3EE',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程完全沙箱化：不加载 preload、不给 Node 能力。
      // 页面里是用户上传的户型图、客户资料与模型配置，拿到 Node 就等于拿到任意文件读写。
      // 需要「打开外部链接」这类能力时，主进程用 setWindowOpenHandler 处理即可。
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // 外部链接走系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${server.port}/`);

  /**
   * 预置的管理员凭据还能不能用？
   *
   * 用默认手机号 + 默认密码试登一次（登录不消耗额度）：
   * - 登进去 = 用户还在用写在文档里的公开示例值 → 提醒去个人中心改掉
   * - 登不进去 = 手机号或密码已经被改过 → 记下来，以后不再打扰
   *
   * 为什么不用「用户点过按钮」这种标记：改密码是在网页界面里操作的，
   * 主进程没有事件源，只能靠「默认凭据是否还有效」这个真实事实来判断。
   */
  const defaultCredsStillWork = await (async (): Promise<boolean> => {
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: DEFAULT_ADMIN_PHONE, password: DEFAULT_ADMIN_PASSWORD }),
      });
      return r.ok;
    } catch {
      // 连不上就当「还用默认」：宁可多提醒一次，也不要让公开凭据悄悄留着。
      return true;
    }
  })();

  if (defaultCredsStillWork) {
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '管理员账号还是预置的，请改成你自己的',
      message: '当前登录用的还是预置管理员账号',
      detail: `管理员手机号：${DEFAULT_ADMIN_PHONE}\n管理员密码：${DEFAULT_ADMIN_PASSWORD}\n\n`
        + '这两个值是写在公开文档里的示例值，任何拿到这个应用的人都能用它们登录。\n'
        + '登录后请到「个人中心」把手机号和密码都改成你自己的：手机号决定你能用什么账号登录，'
        + '密码决定别人能不能进来。改完当前会话会立即失效，用新凭据重新登录即可。\n\n'
        + 'AI 功能需要你自己填模型 API Key（设置 → 模型配置），本应用不内置任何第三方额度。',
      buttons: ['知道了'],
      defaultId: 0,
    });
  } else if (!cfg.adminPasswordChanged) {
    // 凭据已失效，把状态落盘，之后不再做这次试登。
    saveConfig({ ...cfg, adminPasswordChanged: true });
  }
}

/**
 * 关闭所有子组件：API 子进程 → 本地静态服务 → 内嵌 PostgreSQL。
 *
 * 做成**幂等**的：window-all-closed 与 before-quit 都会调它，
 * 而 Electron 的退出流程会重复触发这两个事件。
 */
let shuttingDown: Promise<void> | null = null;
function shutdown(): Promise<void> {
  if (!shuttingDown) {
    shuttingDown = (async () => {
      try {
        // 顺序要紧：先断 API（它持有数据库连接），再断服务，最后停库
        await api?.stop();
        await server?.close();
        await pg?.stop();
      } catch {
        /* 退出阶段尽力而为 */
      }
    })();
  }
  return shuttingDown;
}

// 单实例：多开会同时抢数据库端口与同一份数据目录
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((e: Error) => {
    log(`启动失败：${e.message}\n${e.stack ?? ''}`);
    dialog.showErrorBox('启动失败', `${e.message}\n\n日志：${logFile}`);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  /**
   * 退出时必须**等子进程真的死**再让主进程结束。
   *
   * 实测过的坑：原来这里是 `void shutdown()`（不 await），主进程立刻退出，
   * `utilityProcess.kill()` 发的 SIGTERM 子进程还没收到就失去了父进程 ——
   * 结果留下一个 PPID=1 的孤儿 `node dist/src/main.js`，带着内嵌 PostgreSQL
   * 跑了 4 小时 50 分钟，占着内存、端口和数据库锁。退出桌面应用等于留一台后台服务器。
   *
   * 所以这里用 preventDefault 拦住退出，等 shutdown 真正完成（子进程已死）后再放行。
   */
  let quitAllowed = false;
  app.on('before-quit', (event) => {
    if (quitAllowed) return; // 第二次进来 = 我们主动放行
    event.preventDefault();
    void shutdown().finally(() => {
      quitAllowed = true;
      app.quit();
    });
  });

  /**
   * 兜底：主进程被强杀（SIGKILL / 崩溃）时上面的等待根本没机会跑。
   * 这里同步给子进程发 SIGKILL —— 至少别让它带着数据库继续跑。
   */
  process.on('exit', () => {
    try {
      const pid = api?.process?.pid;
      if (typeof pid === 'number') process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  });
}
