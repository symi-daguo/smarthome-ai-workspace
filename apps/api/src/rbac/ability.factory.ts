import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';
import { Injectable } from '@nestjs/common';
import type { AuthProfile } from '../auth/auth.service.js';

export type AppAbility = MongoAbility<[string, string]>;

@Injectable()
export class AbilityFactory {
  createForUser(user: AuthProfile): AppAbility {
    const membership =
      user.memberships.find((m) => m.tenantId === user.activeTenantId) ?? user.memberships[0];
    const { can, rules } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const permission of membership?.permissions ?? []) {
      can(permission, 'all');
    }
    return createMongoAbility(rules);
  }
}
