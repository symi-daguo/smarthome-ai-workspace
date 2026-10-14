import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.module.js';
import { AuthService, type AuthProfile } from './auth.service.js';
import { AgentService } from '../agent/agent.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('JWT_SECRET', 'dev-secret'),
    });
  }

  /**
   * 每请求实时比对令牌版本：改密后 tokenVersion 自增，所有旧 JWT 立即失效。
   *
   * API Key 也走这里：它就是一枚同样用 JWT_SECRET 签名的 JWT，payload 多带 `ak`=ApiKey.id。
   * 这么做的收益是**库里不存任何密钥材料**（拿不到 JWT_SECRET 就伪造不出来），
   * 且 20 多个控制器一行都不用改 —— 全部复用现成的认证 + RBAC + 租户链路。
   */
  async validate(payload: { sub: string; phone: string; tv?: number; ak?: string }): Promise<AuthProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true },
    });
    if (!user) throw new UnauthorizedException('USER_NOT_FOUND');
    // 0.1.32 前签发的历史 token 无 tv 字段，在首个用户改密（tv 自增为 1）后自然失效
    if (payload.tv !== user.tokenVersion) throw new UnauthorizedException('TOKEN_REVOKED');

    // 带 ak 说明是机器凭证：查一次吊销状态。没吊销就按普通用户走，RBAC 照常生效
    // 带 ak 说明是机器凭证。⚠️ 这里**不能**试图从 validate 的第二个参数取请求 ——
    // passport-jwt 传的是 done 回调而不是 ExecutionContext，拿它当 ctx 用会直接抛错。
    // 需要跨租户校验时，由 TenantGuard 拿 request.user.apiKeyTenantId 比对。
    if (payload.ak && !(await this.agent.verifyApiKey(payload.ak))) {
      throw new UnauthorizedException('API_KEY_REVOKED_OR_EXPIRED');
    }

    const profile = await this.auth.profile(payload.sub);
    if (payload.ak) {
      const key = await this.agent.keyTenant(payload.ak);
      return { ...profile, apiKeyTenantId: key ?? undefined };
    }
    return profile;
  }
}
