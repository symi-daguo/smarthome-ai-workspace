import { Controller, Get, Module } from '@nestjs/common';
import { configString, desktopConfigPath, isDesktopMode, readDesktopConfigFile } from '../desktop/desktop-config-file.js';

/**
 * 部署级品牌信息（公开只读）。
 *
 * **为什么要这个端点**：产品名与图标此前是写死的（登录页、浏览器标题、
 * 侧栏品牌行、PPTX 作者名、分享页落款），部署者想换成自己的品牌改不掉。
 * 而品牌信息必须在**登录前**就拿到 —— 登录页正是要显示它的地方 ——
 * 所以只能由后端给，不能走登录后的租户接口。
 *
 * **取值口径**：
 * - 容器/脚本部署：`BRAND_NAME` 环境变量，留空用默认「智能家居 AI 工作台」；
 *   `BRAND_LOGO_URL` 图标地址（URL 或站内路径），**留空则沿用界面自带的标识**。
 * - 桌面单机版：品牌存在 `desktop-config.json` 里（用户可在界面里改），
 *   **每次请求现读** —— 这样保存后品牌立刻生效，不必重启应用。
 *
 * 这个端点不返回任何租户数据，不需要鉴权；被访问也只是读一个很小的配置文件。
 */
/**
 * 默认产品名。
 *
 * 兜底字符串只该有一处 —— 散落多处必然漂移，
 * 而且改产品名时会漏掉其中一处（那正是「产品名改不掉」的另一半原因）。
 */
const DEFAULT_BRAND_NAME = '智能家居 AI 工作台';

/**
 * 部署级产品名：`BRAND_NAME` 优先，留空用默认。
 *
 * 单独导出来给后端别处复用（技能包模板、反馈工单落款、Swagger 标题）。
 */
export function brandName(): string {
  return (process.env.BRAND_NAME ?? '').trim() || DEFAULT_BRAND_NAME;
}

@Controller('public/branding')
class BrandingController {
  /**
   * 品牌信息 + 「是不是桌面单机版」。
   *
   * **`desktop` 这个字段是给前端看的**：桌面端才显示「桌面端设置」入口，
   * 公开部署里那个入口**完全看不到**。前端据此判断，不靠猜用户从哪儿访问的。
   */
  @Get()
  get(): { name: string; logoUrl: string; desktop: boolean } {
    const desktop = isDesktopMode();
    const path = desktopConfigPath();
    if (desktop && path) {
      // 桌面端：配置文件是唯一事实来源。
      // 为什么不回落环境变量：桌面端主进程启动时把 BRAND_NAME 注入成配置里的值，
      // 用户在界面里把品牌名清空后，环境变量还是旧值 —— 回落它等于「保存了却不生效」。
      // 配置文件读不出来（路径没配/文件坏了）时按全空处理 → 用默认名、不换图标。
      const cfg = readDesktopConfigFile(path);
      return {
        name: configString(cfg.brandName) || DEFAULT_BRAND_NAME,
        logoUrl: configString(cfg.brandLogoUrl),
        desktop: true,
      };
    }
    return {
      name: brandName(),
      logoUrl: (process.env.BRAND_LOGO_URL ?? '').trim(),
      desktop,
    };
  }
}

@Module({ controllers: [BrandingController] })
export class BrandingModule {}
