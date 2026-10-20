import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

/**
 * 支持 query token 的 JWT 守卫：
 * <img>/<video>/下载链接无法携带 Authorization 头，本地单机部署下允许 ?token=<jwt> 认证
 */
@Injectable()
export class JwtQueryGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext): Request {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.headers.authorization && typeof request.query.token === 'string') {
      request.headers.authorization = `Bearer ${request.query.token}`;
    }
    return request;
  }
}
