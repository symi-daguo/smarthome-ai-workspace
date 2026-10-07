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

    const headerTenantId = request.headers['x-tenant-id'];
    const membership = headerTenantId
      ? user.memberships.find((m) => m.tenantId === headerTenantId)
      : user.memberships[0];
    if (!membership) throw new ForbiddenException('TENANT_ACCESS_DENIED');

    request.user = { ...user, activeTenantId: membership.tenantId };
    return true;
  }
}
