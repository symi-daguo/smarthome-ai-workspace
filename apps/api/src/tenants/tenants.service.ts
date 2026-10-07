import { Injectable } from '@nestjs/common';
import type { AuthProfile } from '../auth/auth.service.js';
import { TokenService } from '../billing/token.service.js';

@Injectable()
export class TenantsService {
  constructor(private readonly tokens: TokenService) {}

  mine(user: AuthProfile): { memberships: AuthProfile['memberships'] } {
    return { memberships: user.memberships };
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
