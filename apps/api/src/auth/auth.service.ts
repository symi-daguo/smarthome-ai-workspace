import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.module.js';
import type { LoginDto, RegisterDto } from './auth.schemas.js';

// 新注册租户默认额度：入门版点数 80,000 按 1:1 折算为 token
const DEFAULT_TENANT_TOKENS = 80_000;

/** Prisma 唯一约束冲突错误码：命中 User.phone 的 @unique */
const UNIQUE_VIOLATION = 'P2002';

/** 判断是否唯一约束冲突：避免把原始数据库错误抛给前端 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<{ token: string; user: AuthProfile }> {
    const existing = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (existing) throw new ConflictException('PHONE_EXISTS');

    const role = await this.prisma.role.findUnique({ where: { key: 'tenant_admin' } });
    if (!role) throw new ConflictException('RBAC_NOT_SEEDED');

    const passwordHash = await argon2.hash(dto.password);
    const slug = `t-${Date.now().toString(36)}`;
    const user = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.tenantName ?? `${dto.displayName}的团队`,
          slug,
          tokenBalance: DEFAULT_TENANT_TOKENS,
        },
      });
      const created = await tx.user.create({
        data: { phone: dto.phone, passwordHash, displayName: dto.displayName },
      });
      await tx.membership.create({
        data: { userId: created.id, tenantId: tenant.id, roleId: role.id },
      });
      await tx.tokenLedger.create({
        data: {
          tenantId: tenant.id,
          userId: created.id,
          delta: DEFAULT_TENANT_TOKENS,
          reason: 'GRANT',
          meta: { source: 'register' },
        },
      });
      return created;
    });

    return { token: await this.sign(user.id, user.phone, user.tokenVersion), user: await this.profile(user.id) };
  }

  async login(dto: LoginDto): Promise<{ token: string; user: AuthProfile }> {
    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user) throw new UnauthorizedException('INVALID_CREDENTIALS');
    const ok = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!ok) throw new UnauthorizedException('INVALID_CREDENTIALS');
    return { token: await this.sign(user.id, user.phone, user.tokenVersion), user: await this.profile(user.id) };
  }

  async profile(userId: string): Promise<AuthProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            tenant: { select: { id: true, name: true, plan: true } },
            role: {
              include: { rolePermissions: { include: { permission: { select: { action: true } } } } },
            },
          },
        },
      },
    });
    if (!user) throw new UnauthorizedException('USER_NOT_FOUND');
    return {
      id: user.id,
      phone: user.phone,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
      avatarUrl: user.avatarUrl,
      // 审计要能区分「人点的」与「Agent 跑的」，机器账号没有可用密码，标记只能来自库里
      isServiceAccount: user.isServiceAccount,
      memberships: user.memberships.map((m) => ({
        tenantId: m.tenant.id,
        tenantName: m.tenant.name,
        plan: m.tenant.plan,
        roleKey: m.role.key,
        permissions: m.role.rolePermissions.map((rp) => rp.permission.action),
      })),
    };
  }

  /**
   * 刷新 JWT：携带有效旧 token 换新 token（延长有效期），避免过期后被迫重新登录。
   * 新 token 始终携带数据库当前 tokenVersion；改密后旧 token 在 JwtStrategy 即被拒，无法刷新。
   */
  async refresh(userId: string): Promise<{ token: string; user: AuthProfile }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('USER_NOT_FOUND');
    return { token: await this.sign(user.id, user.phone, user.tokenVersion), user: await this.profile(user.id) };
  }

  async changePassword(userId: string, dto: { oldPassword: string; newPassword: string }): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('USER_NOT_FOUND');
    const ok = await argon2.verify(user.passwordHash, dto.oldPassword).catch(() => false);
    if (!ok) throw new UnauthorizedException('INVALID_CREDENTIALS');
    // 自增 tokenVersion：所有已签发的旧 JWT（含其他设备）在 JwtStrategy 比对时即刻失效
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(dto.newPassword), tokenVersion: { increment: 1 } },
    });
    return { ok: true };
  }

  /**
   * 修改登录手机号（本人操作，不校验旧密码）。
   *
   * 手机号在 User 表是**全局唯一**，租户归属在 Membership 表 —— 同一个人可以属于多个租户，
   * 所以这里必须全局查重，不能按租户查。
   *
   * 不要求旧密码：改手机号的典型场景正是「默认号码是别人的、我不拥有它」，
   * 要求旧密码等于把人堵死。安全边界是「已登录 + 本人操作」。
   *
   * 改完自增 tokenVersion：与改密同一条机制，所有旧 JWT（含其他设备）立即失效，
   * 强制用新手机号重新登录 —— 否则旧 token 还能继续用，等于换号没换身份。
   *
   * 返回值里的 `changed` 告诉调用方「号码到底有没有变」：
   * 填回自己当前的号码是幂等操作，什么都不改、会话也不该失效。
   * 前端必须按这个标志决定要不要让用户重新登录 —— 否则用户只是确认了一下号码，
   * 却被莫名其妙踢下线。
   */
  async changePhone(userId: string, phone: string): Promise<{ ok: true; changed: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('USER_NOT_FOUND');
    // 机器账号的号码位是 svc_ 前缀的占位符，只经 API Key 访问，没有「本人手机号」可改
    if (user.isServiceAccount) throw new BadRequestException('SERVICE_ACCOUNT_PHONE_IMMUTABLE');
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    // 填回自己当前的号码：按无变化处理（幂等），不该报「已被占用」也不该作废自己的会话
    if (existing?.id === userId) return { ok: true, changed: false };
    if (existing) throw new ConflictException('PHONE_EXISTS');
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { phone, tokenVersion: { increment: 1 } },
      });
    } catch (e) {
      // 竞态兜底：两个用户同时改成同一个新号时，后到的那一个会撞 User.phone 的唯一索引。
      // 不兜住就是 500，兜住才与前置查重给出的 409 一致。
      if (isUniqueViolation(e)) throw new ConflictException('PHONE_EXISTS');
      throw e;
    }
    return { ok: true, changed: true };
  }

  /** 个人设置：更新显示名 / 头像底色 */
  async updateProfile(userId: string, dto: { displayName?: string; avatarColor?: string; avatarUrl?: string }): Promise<AuthProfile> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.avatarColor !== undefined ? { avatarColor: dto.avatarColor } : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
      },
    });
    return this.profile(userId);
  }

  // JwtModule.registerAsync 已注入 secret/expiresIn, signAsync 无需重复传参；tv=令牌版本
  private sign(userId: string, phone: string, tokenVersion: number): Promise<string> {
    return this.jwt.signAsync({ sub: userId, phone, tv: tokenVersion });
  }
}

export interface AuthProfile {
  id: string;
  phone: string;
  displayName: string;
  avatarColor?: string | null;
  /** 头像图片 URL；空串=回退到 avatarColor 底色 */
  avatarUrl?: string;
  /** 机器账号：只经 API Key 访问。审计据此把操作归类为 AGENT 而非 USER */
  isServiceAccount?: boolean;
  /** 由 JwtStrategy 写入：这枚 API Key 归属的租户。TenantGuard 用它拒绝「拿 A 的 Key 访问 B」 */
  apiKeyTenantId?: string;
  /** 由 TenantGuard 写入：当前生效租户 */
  activeTenantId?: string;
  memberships: {
    tenantId: string;
    tenantName: string;
    plan: string;
    roleKey: string;
    permissions: string[];
  }[];
}
