import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module.js';
import { LightingController } from './lighting.controller.js';
import { LightingService } from './lighting.service.js';

@Module({
  imports: [RbacModule],
  controllers: [LightingController],
  providers: [LightingService],
})
export class LightingModule {}