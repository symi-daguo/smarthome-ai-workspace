import { Module } from '@nestjs/common';
import { TeamController } from './team.controller.js';
import { TeamService } from './team.service.js';
import { AgentModule } from '../agent/agent.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';

/** 团队成员与角色模板（0.1.54）：Rbac/Tenants 提供守卫依赖，AgentModule 提供机器账号读取 */
@Module({
  imports: [RbacModule, TenantsModule, AgentModule],
  controllers: [TeamController],
  providers: [TeamService],
})
export class TeamModule {}
