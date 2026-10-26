import { Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  configString,
  desktopConfigPath,
  readDesktopConfigFile,
  readDesktopConfigFileStrict,
  writeDesktopConfigFile,
} from './desktop-config-file.js';
import type { DesktopConfigDto } from './desktop-config.schemas.js';

/**
 * 清除令牌的显式值。
 *
 * **为什么需要它**：令牌**不回显明文**（前端拿不到当前值），
 * 所以「传空串」只能表示「不改动」—— 用户想清除令牌时，
 * 没有任何一个「看起来像空」的输入能表达「我要清掉」。
 * 于是给一个显式哨兵值：既不与真实令牌冲突（真令牌不会正好等于这串），
 * 又让「清除」成为一次明确的动作。
 */
export const CLEAR_TOKEN = '__CLEAR__';

/**
 * 桌面端设置的对外形状。
 *
 * **令牌绝不明文回传**：只给「是否已配置」这个布尔值，
 * 与模型配置中心对 apiKey 的处理一致（密钥只进不出）。
 */
export interface DesktopConfigView {
  /** 品牌名（当前配置值；留空表示用内置默认名） */
  brandName: string;
  /** 品牌图标地址（当前配置值；留空表示沿用界面自带标识） */
  brandLogoUrl: string;
  /** 语音合成服务地址（当前配置值；留空表示本部署不提供语音） */
  narrationTtsUrl: string;
  /** 令牌是否已配置（不回传明文） */
  narrationTtsTokenConfigured: boolean;
  /** 恒为 true：这个端点只在桌面单机版存在 */
  desktop: true;
}

@Injectable()
export class DesktopConfigService {
  private readonly logger = new Logger(DesktopConfigService.name);

  /**
   * 读当前配置。
   *
   * 读的是**桌面端配置文件**（desktop-config.json），不是环境变量 ——
   * 桌面端的配置由桌面端主进程落在这个文件里，后端只是读写它。
   * 文件不存在 / 读失败都按「全空」处理（读失败已在底层记了告警）。
   */
  read(): DesktopConfigView {
    const path = desktopConfigPath();
    return this.view(readDesktopConfigFile(path));
  }

  /**
   * 保存：**只改请求里出现的字段**，其余原样保留。
   *
   * 「其余原样保留」是硬要求：同一个文件里还有 jwtSecret / dbPort / apiPort / migrated，
   * 那些是桌面端自己的字段，一旦被覆盖抹掉，桌面端下次启动会重建配置（密钥变 → 用户被登出）。
   */
  save(dto: DesktopConfigDto): DesktopConfigView {
    const path = desktopConfigPath();
    if (!path) {
      throw new ServiceUnavailableException('DESKTOP_CONFIG_PATH_MISSING');
    }

    // 严格读：文件坏了就报错，绝不拿空配置去覆盖原文件
    let current: Record<string, unknown>;
    try {
      current = readDesktopConfigFileStrict(path);
    } catch (e) {
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }

    const next: Record<string, unknown> = { ...current };
    // 文本字段：出现即写入（空串 = 清除该项），不出现就完全不碰
    if (dto.brandName !== undefined) next.brandName = dto.brandName.trim();
    if (dto.brandLogoUrl !== undefined) next.brandLogoUrl = dto.brandLogoUrl.trim();
    if (dto.narrationTtsUrl !== undefined) next.narrationTtsUrl = dto.narrationTtsUrl.trim();
    // 令牌：空串 = 不改动（前端不回显明文，无法区分「没改」与「想清除」）；
    // 显式哨兵值 = 清除；其余 = 写入新令牌
    if (dto.narrationTtsToken !== undefined) {
      const token = dto.narrationTtsToken.trim();
      if (token === CLEAR_TOKEN) next.narrationTtsToken = '';
      else if (token) next.narrationTtsToken = token;
    }

    try {
      writeDesktopConfigFile(path, next);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.logger.error(`桌面端配置写入失败 ${path}：${detail}`);
      throw new InternalServerErrorException(`桌面端配置写入失败：${detail}`);
    }
    return this.view(next);
  }

  /** 把配置文件内容转成对外形状（令牌只给布尔值） */
  private view(config: Record<string, unknown>): DesktopConfigView {
    return {
      brandName: configString(config.brandName),
      brandLogoUrl: configString(config.brandLogoUrl),
      narrationTtsUrl: configString(config.narrationTtsUrl),
      narrationTtsTokenConfigured: configString(config.narrationTtsToken).length > 0,
      desktop: true,
    };
  }
}
