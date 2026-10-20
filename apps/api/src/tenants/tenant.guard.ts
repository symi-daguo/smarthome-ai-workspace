import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthProfile } from '../auth/auth.service.js';

/** 解析 X-Tenant-Id（缺省取首个成员关系），拦截跨租户访问 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user: AuthProfile;
      headers: Record<string, string | undefined>;
    }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('UNAUTHENTICATED');

    // 机器凭证只能操作它自己那个租户：拿 A 的 Key 带 X-Tenant-Id 指向 B 必须被拒。
    // 这一层比「只看 memberships 是否匹配」更早、更明确 —— 后者要等到找不到成员才失败。
    if (user.apiKeyTenantId && request.headers['x-tenant-id'] && request.headers['x-tenant-id'] !== user.apiKeyTenantId) {
      throw new ForbiddenException('API_KEY_TENANT_MISMATCH');
    }

    const headerTenantId = request.headers['x-tenant-id'];
    const membership = headerTenantId
      ? user.memberships.find((m) => m.tenantId === headerTenantId)
      : user.memberships[0];
    if (!membership) throw new ForbiddenException('TENANT_ACCESS_DENIED');

    request.user = { ...user, activeTenantId: membership.tenantId };
    return true;
  }
}
