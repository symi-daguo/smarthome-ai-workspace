import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { AgentService } from '../agent/agent.service.js';

/**
 * 团队成员与角色模板（0.1.54）
 *
 * 为什么要「模板」而不是让管理员逐项勾权限：本项目的权限 action 有 15 个
 * （platform:tenant:manage、quote:manage、content:generate……），
 * 让不懂技术的门店老板逐项勾，既容易配错也没人配得下去。
 * 所以界面只给**角色模板**（超级管理员 / 租户管理员 / 设计师 / 运营 / 只读成员），
 * 权限明细只作为模板的说明展示，不可逐项编辑 —— 这样权限模型有单一事实来源
 * （prisma/seed.ts 的 ROLE_DEFS），不会出现「界面上配出来一套、后端判的是另一套」。
 *
 * 范式参考（2026-10-14 联网查证，许可证逐个核实过）：
 *   - **Appwrite（BSD-3-Clause）** `app/config/roles.php`：固定档位角色模板 + 每档一个扁平权限串清单，
 *     角色继承用集合合并表达（`ROLE_OWNER = merge($member, $admins)`）而非重复枚举。
 *     本项目「新增权限只改 seed 一处」就是照这个思路。
 *   - **Casbin（Apache-2.0）** RBAC with domains：`g = _, _, _` 的第三位即租户，
 *     与我们 `Membership(userId, tenantId, roleId)` 复合唯一键等价。
 *   - **Appwrite 把非人类主体单列一个角色**（`Applications`），比我们在 User 表上挂
 *     `isServiceAccount` 布尔位更干净 —— 本轮暂不改数据模型，记在下方待办。
 *
 * **首期刻意不做自定义角色**：自定义角色要额外解决三件事 ——
 * 自定义角色被删时成员怎么办、租户管理员能否创建比自己权限更大的角色（提权）、
 * 模板升级时如何与用户自定义合并。这三件事在 Appwrite / Casdoor 里都需要额外代码，
 * 而 Appwrite 与 Cal.com 这类成熟项目**目前也都只提供固定档位**，说明这不是保守而是共识。
 *
 * ⚠️ **不能借鉴的项目**（许可证已逐个核实）：Zitadel、Plane、AppFlowy 是 AGPL-3.0；
 * Directus 已从 GPL 改为 MSCL-1.0-GPL；NocoDB、Outline、Twenty 为非 OSI 的 Sustainable Use License。
 * 本项目规约禁止 GPL/AGPL，这些的**代码与文案一律不碰**，只借鉴 MIT/Apache/BSD 项目。
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
  ) {}

  /** 角色模板：带每个模板能干什么的人话说明，供界面点选 */
  async roleTemplates(tenantId: string): Promise<{
    key: string; id: string; name: string; scope: string; permissions: string[];
    description: string; isSystem: boolean; permissionCount: number;
  }[]> {
    const roles = await this.prisma.role.findMany({
      where: { OR: [{ isSystem: true }, { tenantId }] },
      include: { rolePermissions: { include: { permission: { select: { action: true } } } } },
    });
    const copy = ROLE_TEMPLATE_COPY;
    // 系统模板按权限从高到低排（按 key 字母排会显示成
    // 「设计师 / 运营 / 超级管理员 …」这种毫无层次的顺序）；自定义角色排在模板之后
    const ordered = [...roles].sort((a, b) => {
      const ai = a.isSystem ? TEMPLATE_ORDER.indexOf(a.key) : 900;
      const bi = b.isSystem ? TEMPLATE_ORDER.indexOf(b.key) : 900;
      return (ai < 0 ? 800 : ai) - (bi < 0 ? 800 : bi);
    });
    return ordered.map((r) => {
      const permissions = r.rolePermissions.map((rp) => rp.permission.action).sort();
      return {
        key: r.key,
        id: r.id,
        name: r.name,
        scope: r.scope,
        permissions,
        description: r.description ?? copy[r.key]?.summary ?? '',
        isSystem: r.isSystem,
        permissionCount: permissions.length,
      };
    });
  }

  /**
   * 新建自定义角色。
   *
   * ⚠️ **防提权**是这里唯一不能省的一步：没有它，任意「能管成员」的角色都能造一个
   * 含 platform:* 全权限的角色塞给自己，等于把权限体系整个击穿。
   * 规则：**只能授予自己已经拥有的权限** —— 你能给出去的，永远不会比你手上的多。
   */
  async createRole(
    tenantId: string,
    actor: { id: string; permissions: string[] },
    dto: { name: string; description?: string; permissions: string[] },
  ): Promise<{ id: string; name: string; permissions: string[] }> {
    this.assertNoEscalation(actor.permissions, dto.permissions);
    const key = `c-${tenantId.slice(0, 8)}-${randomBytes(6).toString('hex')}`;
    const perms = await this.prisma.permission.findMany({ where: { action: { in: dto.permissions } } });
    const role = await this.prisma.role.create({
      data: {
        key, name: dto.name, scope: 'TENANT', isSystem: false, tenantId,
        description: dto.description ?? null,
        rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) },
      },
    });
    return { id: role.id, name: role.name, permissions: perms.map((p) => p.action) };
  }

  async updateRole(
    tenantId: string,
    roleId: string,
    actor: { id: string; permissions: string[] },
    dto: { name?: string; description?: string; permissions?: string[] },
  ): Promise<{ id: string; name: string; permissions: string[] }> {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId, isSystem: false } });
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND_OR_NOT_EDITABLE');
    if (dto.permissions) this.assertNoEscalation(actor.permissions, dto.permissions);
    if (dto.permissions) {
      const perms = await this.prisma.permission.findMany({ where: { action: { in: dto.permissions } } });
      await this.prisma.$transaction([
        this.prisma.rolePermission.deleteMany({ where: { roleId } }),
        this.prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) }),
      ]);
    }
    const updated = await this.prisma.role.update({
      where: { id: roleId },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description || null } : {}),
      },
    });
    const perms = await this.prisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } });
    return { id: updated.id, name: updated.name, permissions: perms.map((p) => p.permission.action) };
  }

  async removeRole(tenantId: string, roleId: string): Promise<{ ok: true }> {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId, isSystem: false } });
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND_OR_NOT_EDITABLE');
    // 还有人在用的角色不能删：删了这些 Membership 就成了悬空引用
    const used = await this.prisma.membership.count({ where: { tenantId, roleId } });
    if (used > 0) {
      throw new BadRequestException(`ROLE_IN_USE: 还有 ${used} 名成员在用这个角色，请先把他们改到别的角色`);
    }
    await this.prisma.role.delete({ where: { id: roleId } });
    return { ok: true };
  }

  /** 你能给出去的，永远不会比你手上的多 */
  private assertNoEscalation(own: string[], grant: string[]): void {
    const extra = grant.filter((p) => !own.includes(p));
    if (extra.length > 0) {
      throw new ForbiddenException(
        `PRIVILEGE_ESCALATION: 不能授予自己没有的权限（${extra.join('、')}）。你当前的权限里没有这几项。`,
      );
    }
  }

  /** 本租户成员列表（含角色与权限，便于界面直接显示「他能做什么」） */
  async members(tenantId: string): Promise<{
    id: string; phone: string; displayName: string; roleKey: string; roleName: string;
    permissions: string[]; isServiceAccount: boolean; joinedAt: string;
  }[]> {
    const rows = await this.prisma.membership.findMany({
      where: { tenantId },
      include: {
        user: true,
        role: { include: { rolePermissions: { include: { permission: { select: { action: true } } } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.user.id,
      phone: m.user.phone,
      displayName: m.user.displayName,
      roleKey: m.role.key,
      roleName: m.role.name,
      permissions: m.role.rolePermissions.map((rp) => rp.permission.action).sort(),
      isServiceAccount: m.user.isServiceAccount,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /** 管理员建成员：手机号 + 姓名 + 角色模板。密码线下告知本人，首次登录后自行修改 */
  async createMember(
    tenantId: string,
    dto: { phone: string; displayName: string; roleKey: string; password: string },
    operatorId: string,
  ): Promise<{ id: string; phone: string; displayName: string; roleKey: string }> {
    const role = await this.findRole(tenantId, dto.roleKey);
    // 手机号是 User 表的全局唯一键：同一个人可以加入多个租户，所以「已存在」不等于「已在本租户」
    const existing = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (existing) {
      const already = await this.prisma.membership.findUnique({
        where: { userId_tenantId: { userId: existing.id, tenantId } },
      });
      if (already) throw new ConflictException('MEMBER_ALREADY_IN_TENANT');
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = existing
      ? existing
      : await this.prisma.user.create({
          data: { phone: dto.phone, passwordHash, displayName: dto.displayName },
        });

    // 已有全局账号但密码未知（可能是从别处注册的），这时才设置新密码；
    // 否则会覆盖掉本人自己的密码
    if (existing) await this.prisma.user.update({ where: { id: existing.id }, data: { displayName: dto.displayName } });

    await this.prisma.membership.create({ data: { userId: user.id, tenantId, roleId: role.id } });
    void this.prisma.auditLog.create({
      data: { tenantId, actorId: operatorId, actorKind: 'USER', action: 'POST /api/team/members', target: user.id },
    }).catch(() => undefined);
    return { id: user.id, phone: user.phone, displayName: user.displayName, roleKey: role.key };
  }

  async updateMemberRole(
    tenantId: string,
    userId: string,
    roleKey: string,
    operatorId: string,
  ): Promise<{ id: string; roleKey: string; roleId: string }> {
    const role = await this.findRole(tenantId, roleKey);
    const membership = await this.prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    if (!membership) throw new NotFoundException('MEMBER_NOT_FOUND');

    // 防止把最后一个管理员降级——降完之后这个租户就再也没有人能管成员了
    if (membership.roleId !== role.id && role.key !== 'tenant_admin' && role.key !== 'super_admin') {
      const admins = await this.prisma.membership.count({
        where: {
          tenantId,
          role: { key: { in: ['tenant_admin', 'super_admin'] } },
        },
      });
      const selfIsAdmin = membership.roleId
        ? (await this.prisma.role.findUnique({ where: { id: membership.roleId } }))?.key
        : null;
      if (admins <= 1 && selfIsAdmin && ['tenant_admin', 'super_admin'].includes(selfIsAdmin)) {
        throw new ForbiddenException('CANNOT_DEMOTE_LAST_ADMIN: 这是最后一个管理员，降级后没人能再管理成员');
      }
    }

    await this.prisma.membership.update({ where: { id: membership.id }, data: { roleId: role.id } });
    void this.prisma.auditLog.create({
      data: {
        tenantId, actorId: operatorId, actorKind: 'USER',
        action: 'PATCH /api/team/members', target: userId,
        payloadDigest: null, ok: true,
      },
    }).catch(() => undefined);
    // 自定义角色对外用 id 引用，但 key 也一并返回 —— 否则调用方无从判断该存哪个
    return { id: userId, roleKey: role.key, roleId: role.id };
  }

  /**
   * 移除成员。
   * 注意：**只删成员关系，不删 User 全局账号** —— 一个人可能还属于其他租户，
   * 删掉全局账号会连带影响他访问别处。同时一并吊销其在本租户签发的 API Key。
   */
  async removeMember(tenantId: string, userId: string, operatorId: string): Promise<{ ok: true }> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    if (!membership) throw new NotFoundException('MEMBER_NOT_FOUND');
    if (userId === operatorId) throw new ForbiddenException('CANNOT_REMOVE_SELF');

    const role = await this.prisma.role.findUnique({ where: { id: membership.roleId } });
    if (role && ['tenant_admin', 'super_admin'].includes(role.key)) {
      const admins = await this.prisma.membership.count({
        where: { tenantId, role: { key: { in: ['tenant_admin', 'super_admin'] } } },
      });
      if (admins <= 1) throw new ForbiddenException('CANNOT_REMOVE_LAST_ADMIN: 这是最后一个管理员');
    }

    // 离开租户后其 Key 不该继续可用
    await this.prisma.apiKey.updateMany({ where: { tenantId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.membership.delete({ where: { id: membership.id } });
    void this.prisma.auditLog.create({
      data: { tenantId, actorId: operatorId, actorKind: 'USER', action: 'DELETE /api/team/members', target: userId },
    }).catch(() => undefined);
    return { ok: true };
  }

  /** 自定义角色用 uuid 作为标识；系统模板用可读 key。两者都能被「改成员角色」接受 */
  private async findRole(tenantId: string, keyOrId: string): Promise<{ id: string; key: string }> {
    const role = /^[0-9a-f-]{36}$/i.test(keyOrId)
      ? await this.prisma.role.findFirst({ where: { id: keyOrId, tenantId, isSystem: false } })
      : await this.prisma.role.findFirst({ where: { key: keyOrId, isSystem: true } });
    if (!role) throw new BadRequestException(`ROLE_NOT_FOUND: ${keyOrId}`);
    return role;
  }

  /**
   * 删除机器账号。
   *
   * 流程上必须**先吊销全部 Key 再删账号**：凭证校验只在 JwtStrategy 里按 id 查库，
   * 账号行一删，Key 行若还留着就成了一枚查不到归属的孤儿凭证。
   * 删 Membership 而不是删 User 全局账号的理由与 removeMember 相同：
   * 同一个人可能还属于别的租户，机器账号虽无此可能，但保持同一条删除路径更不容易出错。
   */
  async removeServiceAccount(tenantId: string, userId: string): Promise<{ ok: true }> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('SERVICE_ACCOUNT_NOT_FOUND');
    if (!membership.user.isServiceAccount) {
      throw new BadRequestException('NOT_A_SERVICE_ACCOUNT: 人类成员请用「移出团队」，那会保留其全局账号');
    }
    await this.prisma.apiKey.updateMany({ where: { tenantId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.membership.delete({ where: { id: membership.id } });
    // 机器账号没有密码也不该留在成员表里占位置；确认无其他租户关系后一并清掉
    const others = await this.prisma.membership.count({ where: { userId } });
    if (others === 0) {
      await this.prisma.apiKey.deleteMany({ where: { userId } });
      await this.prisma.user.delete({ where: { id: userId } });
    }
    void this.prisma.auditLog.create({
      data: { tenantId, actorId: userId, actorKind: 'USER', action: 'DELETE /api/team/service-accounts', target: userId },
    }).catch(() => undefined);
    return { ok: true };
  }

  /** 机器账号与人类成员分开列出，避免管理员把机器人当同事删掉 */
  async serviceAccounts(tenantId: string): Promise<{ id: string; name: string; phone: string; roleKey: string }[]> {
    return this.agent.listServiceAccounts(tenantId);
  }
}

/** 界面与下拉的展示顺序：从最高权限到最低。别按 key 字母排，读起来没有层次 */
const TEMPLATE_ORDER = ['super_admin', 'tenant_admin', 'sales', 'designer', 'delivery', 'finance', 'purchase', 'marketing', 'service', 'viewer'];

/** 角色模板的人话说明。写在服务端而不是前端，是为了让 Agent 读清单时也能拿到 */
const ROLE_TEMPLATE_COPY: Record<string, { summary: string; suitable: string }> = {
  super_admin: { summary: '平台级最高权限，可跨租户', suitable: '开源自部署的部署者本人，一般只留一个' },
  tenant_admin: {
    summary: '本团队全部操作权：报价、接单、方案、成员管理、模型配置、数据备份',
    suitable: '店长 / 门店负责人',
  },
  designer: {
    summary: '做方案与出图，不碰客户报价与成员管理',
    suitable: '设计师、方案专员',
  },
  operator: {
    summary: '跑接待与报价的日常动作，不改团队设置',
    suitable: '销售、门店导购',
  },
  viewer: {
    summary: '只看不能改，但可以提反馈与查知识库',
    suitable: '临时查看的人',
  },
};

export { PERMISSIONS };
