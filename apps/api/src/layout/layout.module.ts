import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { LayoutController } from './layout.controller.js';
import { LayoutService } from './layout.service.js';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [LayoutController],
  providers: [LayoutService],
})
export class LayoutModule {}
