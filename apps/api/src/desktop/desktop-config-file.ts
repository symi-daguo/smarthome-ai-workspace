import { Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * 桌面端配置文件（desktop-config.json）的读写。
 *
 * **为什么这个文件归后端管**：桌面端用户不该去手改 JSON ——
 * 手改意味着「改错一个逗号，桌面端下次启动直接起不来」，
 * 而这套配置（品牌名/图标、语音合成接入）恰恰是**装机后最常要改**的东西。
 * 于是后端提供读写接口，桌面端主进程只负责把路径告诉后端（DESKTOP_CONFIG_PATH）。
 *
 * **这个文件里还有什么**：jwtSecret / dbPort / apiPort / migrated 等桌面端自己的字段。
 * 所以写入必须是「**只改本次请求提到的字段，其余原样保留**」，
 * 而且读不出来时**绝不能拿空配置覆盖原文件**（那等于把桌面端的密钥与端口全清掉，
 * 桌面端下次启动只能重建配置 → 密钥变了 → 用户被登出）。
 *
 * 本文件是**纯函数**（不依赖 Nest 的 DI），这样 branding 模块也能直接用它，
 * 两个模块之间不会形成循环依赖。
 */
const logger = new Logger('DesktopConfigFile');

/**
 * 桌面单机模式判定。
 *
 * **唯一依据**：桌面端主进程注入的 `DESKTOP_MODE=1`（apps/desktop/src/api.ts）。
 * 云服务器部署路径永远不会设它 —— 这条判据同时决定「桌面端设置」入口显不显示」。
 */
export function isDesktopMode(): boolean {
  return process.env.DESKTOP_MODE === '1';
}

/**
 * 桌面端配置文件的**绝对路径**（桌面端主进程注入）。
 * 没注入就是空串 —— 空串意味着「读不到配置文件」，按全空处理，绝不猜路径。
 */
export function desktopConfigPath(): string {
  return (process.env.DESKTOP_CONFIG_PATH ?? '').trim();
}

/** 取配置里的字符串字段（非字符串一律当空串） */
export function configString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 读原始文本：文件不存在返回 null（区分「没有」与「坏了」） */
function readRaw(path: string): string | null {
  if (!path) return null;
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/**
 * 读配置文件（**宽容**）：读不到 / 解析失败都当成「空配置」，只告警不抛。
 *
 * 为什么宽容：读配置的路径之一是「登录页要显示品牌名」——
 * 配置文件坏了一次，不该让整个界面白屏；品牌名退回默认即可。
 */
export function readDesktopConfigFile(path: string = desktopConfigPath()): Record<string, unknown> {
  const raw = readRaw(path);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn(`桌面端配置文件顶层不是 JSON 对象，按空配置处理：${path}`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    logger.warn(`桌面端配置文件解析失败，按空配置处理：${path}（${e instanceof Error ? e.message : String(e)}）`);
    return {};
  }
}

/**
 * 读配置文件（**严格**）：解析失败直接抛错。
 *
 * 只在**写入前**用。拿空配置去覆盖原文件，会把 jwtSecret / dbPort / apiPort 一并抹掉 ——
 * 桌面端下次启动读不到密钥就得重建，用户被登出，数据（pgdata）虽然还在，
 * 但「配置损坏」这件事必须由人来修，不能由一次保存操作静默造成。
 */
export function readDesktopConfigFileStrict(path: string): Record<string, unknown> {
  const raw = readRaw(path);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层不是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `桌面端配置文件已损坏，已拒绝覆盖：${path}（${e instanceof Error ? e.message : String(e)}）`,
    );
  }
}

/**
 * **原子写**：先写同目录临时文件，再 rename 覆盖。
 *
 * 为什么必须原子：直接覆盖写到一半崩盘（断电/杀进程）会留下半截 JSON，
 * 桌面端下次启动读到坏文件只能重建配置（密钥变 → 用户被登出）。
 * rename 在同一文件系统内是原子操作：结果要么是旧文件、要么是新文件，不会是半个。
 * 临时文件必须与目标**同目录** —— 跨文件系统 rename 会退化成「复制+删除」，原子性就没了。
 */
export function writeDesktopConfigFile(path: string, data: Record<string, unknown>): void {
  if (!path) throw new Error('未配置桌面端配置文件路径（DESKTOP_CONFIG_PATH）');
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    // 临时文件删不掉不该把主流程变成「保存失败」——真正的原因在上面的异常里
    try {
      unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    throw e;
  }
}
