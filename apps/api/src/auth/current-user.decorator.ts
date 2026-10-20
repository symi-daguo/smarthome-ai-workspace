import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthProfile } from './auth.service.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthProfile =>
    ctx.switchToHttp().getRequest<{ user: AuthProfile }>().user,
);
