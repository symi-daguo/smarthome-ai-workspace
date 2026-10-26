import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { isDesktopMode } from './desktop-config-file.js';

/**
 * 桌面单机模式闸门：非桌面端部署下，这些端点**不存在**。
 *
 * 为什么是 404 而不是 403：
 * - 云服务器部署里根本没有「桌面端设置」这回事，端点不存在就该像不存在一样；
 * - 用 403 等于告诉外部访客「这里有一组桌面端专属接口」，反而是信息泄露。
 *
 * 为什么放在**鉴权守卫之前**：守卫按声明顺序执行，
 * 排在最前面才能保证「未登录的外部访客」拿到的也是 404 而不是 401 ——
 * 否则等于用 401 确认了端点的存在。
 */
@Injectable()
export class DesktopOnlyGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isDesktopMode()) throw new NotFoundException('DESKTOP_CONFIG_NOT_FOUND');
    return true;
  }
}
