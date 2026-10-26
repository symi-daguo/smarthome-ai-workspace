import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { DesktopOnlyGuard } from './desktop-only.guard.js';
import { DesktopConfigService, type DesktopConfigView } from './desktop-config.service.js';
import { desktopConfigSchema, type DesktopConfigDto } from './desktop-config.schemas.js';

/**
 * 桌面端设置（**仅桌面单机版存在**）。
 *
 * 桌面端（Electron 全内嵌版）的部署配置原先只能手改 `desktop-config.json` ——
 * 那是「改错一个逗号，桌面端下次启动起不来」的手艺活。
 * 这里把它变成界面上的四个输入框：品牌名、品牌图标、语音合成服务地址、语音合成服务令牌。
 *
 * **鉴权口径**：`platform:billing:manage`。
 * 这不是一个新权限位，而是沿用「部署级配置」既有的那一位 ——
 * 模型配置中心（`/api/admin/model-config`）与数据备份（`/api/admin/backup`）用的都是它。
 * 桌面端预置管理员是 super_admin（持有全部权限），租户管理员也持有这一位，
 * 所以「桌面端默认管理员能改桌面端设置」这条要求天然成立，不必新建 action。
 *
 * **为什么令牌只进不出**：任何读取接口都不回传令牌明文，只给「是否已配置」。
 * 配置文件本身是明文（它必须能被桌面端主进程读出来注入环境变量），
 * 但它躺在用户自己的磁盘上，且从不上传 —— 服务端不回显是这条链路的底线。
 */
@UseGuards(DesktopOnlyGuard, AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('desktop/config')
export class DesktopConfigController {
  constructor(private readonly config: DesktopConfigService) {}

  /** 读当前设置（令牌只给「是否已配置」） */
  @RequirePermissions('platform:billing:manage')
  @Get()
  read(): DesktopConfigView {
    return this.config.read();
  }

  /** 保存设置：只改请求里出现的字段，其余原样保留 */
  @RequirePermissions('platform:billing:manage')
  @Put()
  save(@Body(new ZodValidationPipe(desktopConfigSchema)) dto: DesktopConfigDto): DesktopConfigView {
    return this.config.save(dto);
  }
}
