import { Injectable } from '@nestjs/common';
import type { AuthProfile } from '../auth/auth.service.js';
import { TokenService } from '../billing/token.service.js';
import { PrismaService } from '../prisma/prisma.module.js';

@Injectable()
export class TenantsService {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  mine(user: AuthProfile): { memberships: AuthProfile['memberships'] } {
    return { memberships: user.memberships };
  }

  /** 改工作台名称：只有租户管理员能动（能改名字=能管这个团队） */
  async rename(tenantId: string, name: string): Promise<{ id: string; name: string }> {
    const t = await this.prisma.tenant.update({ where: { id: tenantId }, data: { name }, select: { id: true, name: true } });
    return t;
  }

  current(user: AuthProfile): AuthProfile['memberships'][number] | null {
    return user.memberships.find((m) => m.tenantId === user.activeTenantId) ?? user.memberships[0] ?? null;
  }

  tokenBalance(tenantId: string) {
    return this.tokens.balance(tenantId);
  }

  tokenLedger(tenantId: string) {
    return this.tokens.ledger(tenantId);
  }

  grantTokens(tenantId: string, amount: number, note: string | undefined, userId: string) {
    return this.tokens.grant(tenantId, amount, note, userId);
  }
}
