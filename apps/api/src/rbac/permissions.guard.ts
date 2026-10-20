import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthProfile } from '../auth/auth.service.js';
import { AbilityFactory } from './ability.factory.js';
import { REQUIRED_PERMISSIONS_KEY } from './require-permissions.decorator.js';
import type { PermissionAction } from './permissions.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: AbilityFactory,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionAction[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user: AuthProfile }>();
    const ability = this.abilityFactory.createForUser(request.user);
    const allowed = required.every((action) => ability.can(action, 'all'));
    if (!allowed) throw new ForbiddenException('PERMISSION_DENIED');
    return true;
  }
}
