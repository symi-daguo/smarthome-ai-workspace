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

  /**
   * 改工作台设置：名称与安装调试费率。
   * 只有租户管理员能动（能改报价口径 = 能管这个团队的对外报价）。
   *
   * installRate 不传就不动它 —— 改名的人不该顺带把费率重置回默认。
   */
  async update(
    tenantId: string,
    name?: string,
    installRate?: number,
  ): Promise<{ id: string; name: string; installRate: number }> {
    // 两项都可选：只改费率时不能把名字写成空串（Prisma 的 update 会照写）
    const data: { name?: string; installRate?: number } = {};
    if (name !== undefined) data.name = name;
    if (installRate !== undefined) data.installRate = installRate;
    const t = await this.prisma.tenant.update({
      where: { id: tenantId },
      data,
      select: { id: true, name: true, installRate: true },
    });
    return t;
  }

  /**
   * 当前租户的工作台设置。
   *
   * 为什么单独查一次租户表：AuthProfile 里的 membership 是登录时缓存的快照，
   * 不含 installRate（改了费率后不必重新登录就能读到新值）。
   */
  async settings(tenantId: string): Promise<{ id: string; name: string; installRate: number } | null> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, installRate: true },
    });
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
