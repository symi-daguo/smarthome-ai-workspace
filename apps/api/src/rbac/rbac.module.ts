import { Module } from '@nestjs/common';
import { AbilityFactory } from './ability.factory.js';
import { PermissionsGuard } from './permissions.guard.js';

@Module({
  providers: [AbilityFactory, PermissionsGuard],
  exports: [AbilityFactory, PermissionsGuard],
})
export class RbacModule {}
