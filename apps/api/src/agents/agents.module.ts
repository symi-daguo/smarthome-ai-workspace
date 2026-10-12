import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';

@Module({
  imports: [RbacModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}