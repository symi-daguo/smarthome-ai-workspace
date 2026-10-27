import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 桌面端设置（/api/desktop/config）的断言。
 *
 * 为什么单独成文件：smoke.ts 里还有其他并行任务在加断言，
 * 同一个文件同时编辑会互相覆盖。拆成独立模块，由 smoke.ts 一行 import + 一行调用挂接。
 *
 * **绝不碰真实用户目录**：配置文件都建在系统临时目录里，跑完即删。
 * 真实用户目录里那份 desktop-config.json 存着 jwtSecret ——
 * 冒烟要是把它覆盖了，用户的桌面端下次启动就得重建密钥（被登出）。
 */
export interface DesktopConfigSmokeContext {
  /** 与 smoke.ts 的 check() 同签名：登记一条断言并计入总条数 */
  check: (name: string, ok: boolean, detail?: string) => void;
  /** 与 smoke.ts 的 request() 同签名 */
  request: <T>(base: string, path: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
  /** 被测服务地址 */
  base: string;
  /** 管理员鉴权头（该端点要 platform:billing:manage） */
  auth: { headers: { Authorization: string } };
  /** 可选：只读成员的鉴权头。给了才验「越权被拒」，没给就跳过那一条 */
  roAuth?: { headers: { Authorization: string } };
}

/** 桌面端设置端点的响应形状 */
interface DesktopConfigBody {
  brandName?: string;
  brandLogoUrl?: string;
  narrationTtsUrl?: string;
  narrationTtsTokenConfigured?: boolean;
  desktop?: boolean;
  message?: string;
}

/**
 * 跑桌面端设置相关的断言。
 *
 * 覆盖两条主线：
 * 1. **非桌面端模式下端点不存在**（404）—— 云服务器部署里不该有这组接口；
 * 2. **桌面端模式下读写正常**，且写配置**绝不破坏**桌面端自己的字段
 *    （jwtSecret / dbPort / apiPort —— 那些一丢，桌面端下次启动就得重建）。
 *    旧版本配置里的迁移标记也算在内：API 不认识它，也**不能**把它删掉。
 */
export async function assertDesktopConfigAssertions(ctx: DesktopConfigSmokeContext): Promise<void> {
  const { check, request, base, auth, roAuth } = ctx;

  // 临时目录：桌面端配置文件的替身（绝不写真实用户目录）
  const dir = mkdtempSync(join(tmpdir(), 'aisaas-desktop-cfg-'));
  const cfgPath = join(dir, 'desktop-config.json');
  const brokenPath = join(dir, 'broken.json');
  const SECRET = 'smoke-jwt-secret';
  const TOKEN = 'smoke-tts-token-1234';

  // 一份「桌面端真实长什么样」的配置文件：私有字段（密钥/端口/旧版迁移标记）必须原样活下来
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        jwtSecret: SECRET,
        dbPort: 55432,
        apiPort: 30800,
        dbInitialized: true,
        migrated: true,
        adminPasswordChanged: false,
        brandName: '冒烟桌面品牌',
        brandLogoUrl: '',
      },
      null,
      2,
    ),
    'utf8',
  );

  const prevMode = process.env.DESKTOP_MODE;
  const prevPath = process.env.DESKTOP_CONFIG_PATH;
  try {
    // ---------- 1. 非桌面端模式：端点根本不存在 ----------
    process.env.DESKTOP_MODE = '0';
    delete process.env.DESKTOP_CONFIG_PATH;
    {
      const missing = await request<DesktopConfigBody>(base, '/api/desktop/config', auth);
      check(
        '非桌面端模式下桌面端设置端点不存在（404，不是 403）',
        missing.status === 404,
        `实际 ${missing.status}`,
      );
      const publicBranding = await request<{ desktop?: boolean }>(base, '/api/public/branding');
      check(
        '非桌面端模式下公开品牌端点声明 desktop=false（前端据此隐藏入口）',
        publicBranding.status === 200 && publicBranding.body?.desktop === false,
        `实际 ${publicBranding.status} / desktop=${String(publicBranding.body?.desktop)}`,
      );
    }

    // ---------- 2. 桌面端模式：读 ----------
    process.env.DESKTOP_MODE = '1';
    process.env.DESKTOP_CONFIG_PATH = cfgPath;
    {
      const got = await request<DesktopConfigBody>(base, '/api/desktop/config', auth);
      check(
        '桌面端模式下可读到桌面端设置（品牌名来自配置文件）',
        got.status === 200 && got.body?.desktop === true && got.body?.brandName === '冒烟桌面品牌',
        `实际 ${got.status} / ${JSON.stringify(got.body)}`,
      );
      check(
        '令牌只回显「是否已配置」，绝不回传明文',
        got.body?.narrationTtsTokenConfigured === false && !JSON.stringify(got.body).includes(TOKEN),
        JSON.stringify(got.body),
      );
    }

    // ---------- 3. 写：只改请求里出现的字段 ----------
    {
      const put = await request<DesktopConfigBody>(base, '/api/desktop/config', {
        method: 'PUT',
        ...auth,
        body: JSON.stringify({ brandName: '冒烟新品牌', narrationTtsToken: TOKEN }),
      });
      check(
        '桌面端设置可保存',
        put.status === 200 && put.body?.brandName === '冒烟新品牌',
        `实际 ${put.status} / ${JSON.stringify(put.body)}`,
      );
      const after = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      check(
        '保存只改请求里的字段：桌面端私有字段（jwtSecret/端口/旧版迁移标记）一个都没丢',
        after.jwtSecret === SECRET &&
          after.dbPort === 55432 &&
          after.apiPort === 30800 &&
          after.migrated === true &&
          after.dbInitialized === true,
        JSON.stringify(after),
      );
      check(
        '品牌名与令牌写进了配置文件',
        after.brandName === '冒烟新品牌' && after.narrationTtsToken === TOKEN,
        JSON.stringify(after),
      );
    }

    // ---------- 4. 令牌语义：空串 = 不改动，__CLEAR__ = 清除 ----------
    {
      await request<DesktopConfigBody>(base, '/api/desktop/config', {
        method: 'PUT',
        ...auth,
        body: JSON.stringify({ brandName: '冒烟新品牌二号', narrationTtsToken: '' }),
      });
      const afterKeep = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      check(
        '令牌传空串 = 不改动（前端不回显明文，无法区分「没改」与「想清除」）',
        afterKeep.narrationTtsToken === TOKEN && afterKeep.brandName === '冒烟新品牌二号',
        JSON.stringify(afterKeep),
      );

      await request<DesktopConfigBody>(base, '/api/desktop/config', {
        method: 'PUT',
        ...auth,
        body: JSON.stringify({ narrationTtsToken: '__CLEAR__' }),
      });
      const afterClear = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      check(
        '令牌传 __CLEAR__ = 真的清掉了已保存的令牌',
        afterClear.narrationTtsToken === '',
        JSON.stringify(afterClear),
      );
    }

    // ---------- 5. 品牌立即生效（不必重启应用） ----------
    {
      const branding = await request<{ name?: string; desktop?: boolean }>(base, '/api/public/branding');
      check(
        '桌面端品牌每次现读配置文件（保存后立即生效，不需重启）',
        branding.status === 200 && branding.body?.desktop === true && branding.body?.name === '冒烟新品牌二号',
        `实际 ${branding.status} / ${JSON.stringify(branding.body)}`,
      );
      const got = await request<DesktopConfigBody>(base, '/api/desktop/config', auth);
      check(
        '读取接口仍然不回显令牌明文',
        got.body?.narrationTtsTokenConfigured === false && !JSON.stringify(got.body).includes(TOKEN),
        JSON.stringify(got.body),
      );
    }

    // ---------- 6. 鉴权：未登录被拒、只读成员被拒 ----------
    {
      const anon = await request<DesktopConfigBody>(base, '/api/desktop/config', {
        method: 'PUT',
        body: JSON.stringify({ brandName: 'x' }),
      });
      check('未登录不能改桌面端设置', anon.status === 401, `实际 ${anon.status}`);
      if (roAuth) {
        const ro = await request<DesktopConfigBody>(base, '/api/desktop/config', roAuth);
        check('只读成员不能读桌面端设置（需 platform:billing:manage）', ro.status === 403, `实际 ${ro.status}`);
      }
    }

    // ---------- 7. 配置文件坏了必须拒绝覆盖 ----------
    {
      writeFileSync(brokenPath, '{ 这不是合法 JSON', 'utf8');
      process.env.DESKTOP_CONFIG_PATH = brokenPath;
      const broken = await request<DesktopConfigBody>(base, '/api/desktop/config', {
        method: 'PUT',
        ...auth,
        body: JSON.stringify({ brandName: '不该被写进去' }),
      });
      check(
        '配置文件损坏时拒绝写入（绝不拿空配置覆盖原文件）',
        broken.status >= 400 && readFileSync(brokenPath, 'utf8') === '{ 这不是合法 JSON',
        `实际 ${broken.status} / ${readFileSync(brokenPath, 'utf8')}`,
      );
    }
  } finally {
    // 还原环境变量：这条断言跑完之后，后面的冒烟还得按原来的部署形态跑
    if (prevMode === undefined) delete process.env.DESKTOP_MODE;
    else process.env.DESKTOP_MODE = prevMode;
    if (prevPath === undefined) delete process.env.DESKTOP_CONFIG_PATH;
    else process.env.DESKTOP_CONFIG_PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
}
