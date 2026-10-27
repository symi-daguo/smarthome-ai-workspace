import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { createMemberSchema, updateMemberSchema, type CreateMemberDto, type UpdateMemberDto } from './team.schemas.js';
import { createRoleSchema, updateRoleSchema, type CreateRoleDto, type UpdateRoleDto } from './role.schemas.js';
import { TeamService } from './team.service.js';

/**
 * 团队成员与角色模板（0.1.54）
 *
 * 基线门槛是 `tenant:member:manage`（租户管理员自带），与「发 API Key」同一档 ——
 * 能给人开账号的人，也就能给人开机器账号，这两件事的风险级别本来就一样。
 *
 * 涉及**角色分配**的端点（建成员指定角色、改成员角色、建/改/删自定义角色）
 * 额外要 `tenant:role:assign`：守卫是「全都要」的关系，所以两项并列写。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@RequirePermissions('tenant:member:manage')
@Controller('team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  /** 角色清单：系统模板 + 本租户自定义角色，界面照着它渲染可点选的卡片 */
  @Get('role-templates')
  roleTemplates(@CurrentUser() user: AuthProfile): Promise<unknown> {
    return this.team.roleTemplates(user.activeTenantId as string);
  }

  /**
   * 新建自定义角色（勾选权限组合）。
   * 防提权：只能授予自己已经拥有的权限，规则在 service 里，不靠前端拦。
   *
   * 为什么要额外要 tenant:role:assign：角色目录就是「谁能干什么」的那份清单，
   * 它和「给成员分配角色」是同一件事的两半。以前整个控制器只有类级的
   * tenant:member:manage，tenant:role:assign 只是个勾了没用的选项 ——
   * 现在显式挂上，勾了它才真的有效果。
   *
   * 守卫是「全都要」的关系（PermissionsGuard 用 every 判定），
   * 所以这里同时列出两项：既不放松原有的成员管理要求，又让角色分配权真的生效。
   */
  @RequirePermissions('tenant:member:manage', 'tenant:role:assign')
  @Post('roles')
  createRole(
    @CurrentUser() user: AuthProfile,
    @Body(new ZodValidationPipe(createRoleSchema)) dto: CreateRoleDto,
  ): Promise<unknown> {
    return this.team.createRole(
      user.activeTenantId as string,
      { id: user.id, permissions: this.ownPermissions(user) },
      dto,
    );
  }

  @RequirePermissions('tenant:member:manage', 'tenant:role:assign')
  @Patch('roles/:id')
  updateRole(
    @CurrentUser() user: AuthProfile,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) dto: UpdateRoleDto,
  ): Promise<unknown> {
    return this.team.updateRole(
      user.activeTenantId as string, id,
      { id: user.id, permissions: this.ownPermissions(user) },
      dto,
    );
  }

  @RequirePermissions('tenant:member:manage', 'tenant:role:assign')
  @Delete('roles/:id')
  removeRole(@CurrentUser() user: AuthProfile, @Param('id') id: string): Promise<unknown> {
    return this.team.removeRole(user.activeTenantId as string, id);
  }

  /** 当前用户在本租户拥有的权限，防提权校验要用 */
  private ownPermissions(user: AuthProfile): string[] {
    return user.memberships.find((m) => m.tenantId === user.activeTenantId)?.permissions ?? [];
  }

  @Get('members')
  members(@CurrentUser() user: AuthProfile): Promise<unknown> {
    return this.team.members(user.activeTenantId as string);
  }

  /**
   * 新建成员。
   *
   * 为什么要额外要 tenant:role:assign：建成员时可以指定角色模板，
   * 这本身就是「分配角色」动作 —— 与下面 PATCH /members/:userId 是同一件事。
   * 以前这里只有类级的 tenant:member:manage，于是持成员管理权的角色
   * 能直接建出一个 super_admin 成员（提权），而改角色那条却要 tenant:role:assign，
   * 同一件事两套门槛。现在两条对齐。
   */
  @RequirePermissions('tenant:member:manage', 'tenant:role:assign')
  @Post('members')
  createMember(
    @CurrentUser() user: AuthProfile,
    @Body(new ZodValidationPipe(createMemberSchema)) dto: CreateMemberDto,
  ): Promise<unknown> {
    return this.team.createMember(user.activeTenantId as string, dto, user.id);
  }

  /** 改成员的角色 —— 这就是「分配角色」动作本身，tenant:role:assign 在这里生效 */
  @RequirePermissions('tenant:member:manage', 'tenant:role:assign')
  @Patch('members/:userId')
  updateMember(
    @CurrentUser() user: AuthProfile,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) dto: UpdateMemberDto,
  ): Promise<unknown> {
    return this.team.updateMemberRole(user.activeTenantId as string, userId, dto.roleKey, user.id);
  }

  @Delete('members/:userId')
  removeMember(@CurrentUser() user: AuthProfile, @Param('userId') userId: string): Promise<unknown> {
    return this.team.removeMember(user.activeTenantId as string, userId, user.id);
  }

  /** 机器账号（与人类成员分开，避免误删） */
  @Get('service-accounts')
  serviceAccounts(@CurrentUser() user: AuthProfile): Promise<unknown> {
    return this.team.serviceAccounts(user.activeTenantId as string);
  }

  /** 删除机器账号：连带吊销其全部 API Key */
  @Delete('service-accounts/:userId')
  removeServiceAccount(@CurrentUser() user: AuthProfile, @Param('userId') userId: string): Promise<unknown> {
    return this.team.removeServiceAccount(user.activeTenantId as string, userId);
  }
}