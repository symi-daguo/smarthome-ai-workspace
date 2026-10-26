import { Controller, Get, Module } from '@nestjs/common';

/**
 * 部署级品牌信息（公开只读）。
 *
 * **为什么要这个端点**：产品名与图标此前是写死的（登录页、浏览器标题、
 * 侧栏品牌行、PPTX 作者名、分享页落款），部署者想换成自己的品牌改不掉。
 * 而品牌信息必须在**登录前**就拿到 —— 登录页正是要显示它的地方 ——
 * 所以只能由后端给，不能走登录后的租户接口。
 *
 * **为什么用环境变量而不是数据库**：品牌是**部署级**的（一次部署一套），
 * 不是租户级的（每个租户一套）；放进数据库会让「改一次品牌」变成一次写操作，
 * 还得考虑谁有权限改。环境变量改完重启即生效，零迁移。
 *
 * **取值口径**：
 * - `BRAND_NAME`：产品名，留空用默认「智能家居 AI 工作台」；
 * - `BRAND_LOGO_URL`：图标地址（URL 或站内路径），**留空则沿用界面自带的标识**。
 *   配了之后，登录页、侧栏品牌行与浏览器 favicon 一起换成它。
 *
 * 这个端点不返回任何租户数据，不需要鉴权；被访问也只是读两个环境变量。
 */
/**
 * 部署级产品名：`BRAND_NAME` 优先，留空用默认。
 *
 * 单独导出来给后端别处复用（技能包模板、反馈工单落款、Swagger 标题）：
 * 兜底字符串只该有一处 —— 散落多处必然漂移，
 * 而且改产品名时会漏掉其中一处（那正是「产品名改不掉」的另一半原因）。
 */
export function brandName(): string {
  return (process.env.BRAND_NAME ?? '').trim() || '智能家居 AI 工作台';
}

@Controller('public/branding')
class BrandingController {
  @Get()
  get(): { name: string; logoUrl: string } {
    return {
      name: brandName(),
      logoUrl: (process.env.BRAND_LOGO_URL ?? '').trim(),
    };
  }
}

@Module({ controllers: [BrandingController] })
export class BrandingModule {}
