import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';
import { Injectable } from '@nestjs/common';
import type { AuthProfile } from '../auth/auth.service.js';
import { WRITE_IMPLIES_READ } from './permissions.js';

export type AppAbility = MongoAbility<[string, string]>;

@Injectable()
export class AbilityFactory {
  createForUser(user: AuthProfile): AppAbility {
    const membership =
      user.memberships.find((m) => m.tenantId === user.activeTenantId) ?? user.memberships[0];
    const { can, rules } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const permission of membership?.permissions ?? []) {
      can(permission, 'all');
      // 写权限隐含读权限：没有这条，角色定义得为每个资源重复写两遍 read，
      // 而且会出现「能改却看不到」这种反直觉的权限组合。
      // 规则只有这一处定义（permissions.ts 的 WRITE_IMPLIES_READ），不要散落到别处。
      const implied = WRITE_IMPLIES_READ[permission];
      if (implied) can(implied, 'all');
    }
    return createMongoAbility(rules);
  }
}
