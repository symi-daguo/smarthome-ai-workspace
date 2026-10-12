import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.module.js';
import { AuthService, type AuthProfile } from './auth.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('JWT_SECRET', 'dev-secret'),
    });
  }

  /** 每请求实时比对令牌版本：改密后 tokenVersion 自增，所有旧 JWT 立即失效 */
  async validate(payload: { sub: string; phone: string; tv?: number }): Promise<AuthProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true },
    });
    if (!user) throw new UnauthorizedException('USER_NOT_FOUND');
    // 0.1.32 前签发的历史 token 无 tv 字段，在首个用户改密（tv 自增为 1）后自然失效
    if (payload.tv !== user.tokenVersion) throw new UnauthorizedException('TOKEN_REVOKED');
    return this.auth.profile(payload.sub);
  }
}
