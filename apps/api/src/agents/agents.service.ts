import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import type { CreateAgentDto, UpdateAgentDto } from './agents.schemas.js';

/** Prisma 唯一约束冲突错误码：命中 CustomAgent 的 @@unique([tenantId, name]) */
const UNIQUE_VIOLATION = 'P2002';

/** 判断是否唯一约束冲突：避免把原始数据库错误抛给前端 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * 定制智能体服务：租户内的人设/系统提示词管理。
 * 定制智能体对所有登录成员开放（权限 content:generate），数据按 activeTenantId 隔离。
 */
@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  private async mustGet(tenantId: string, id: string) {
    const agent = await this.prisma.customAgent.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!agent) throw new NotFoundException('AGENT_NOT_FOUND');
    return agent;
  }

  list(tenantId: string) {
    return this.prisma.customAgent.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  async create(tenantId: string, userId: string, dto: CreateAgentDto) {
    // 先查一次再插：撞唯一约束时 Postgres 一定会打一条 ERROR 日志，
    // 应用层虽然转成了 409，但日志里已经留下 ERROR（用户要求「运行日志无报错」）。
    // 唯一约束继续留着兜并发，真正的防线是它；预检只是让常规路径安静下来。
    const dup = await this.prisma.customAgent.findFirst({ where: { tenantId, name: dto.name.trim() }, select: { id: true } });
    if (dup) throw new ConflictException('AGENT_NAME_EXISTS');
    try {
      return await this.prisma.customAgent.create({
        data: {
          tenantId,
          userId,
          name: dto.name.trim(),
          description: dto.description?.trim() ?? '',
          systemPrompt: dto.systemPrompt.trim(),
          ...(dto.avatarColor ? { avatarColor: dto.avatarColor } : {}),
        },
      });
    } catch (error) {
      // 租户内重名：转 409，而不是把原始数据库错误抛给前端
      if (isUniqueViolation(error)) throw new ConflictException('AGENT_NAME_EXISTS');
      throw error;
    }
  }

  async update(tenantId: string, id: string, dto: UpdateAgentDto) {
    const owned = await this.mustGet(tenantId, id);
    if (dto.name !== undefined) {
      const dup = await this.prisma.customAgent.findFirst({
        where: { tenantId, name: dto.name.trim(), NOT: { id } },
        select: { id: true },
      });
      if (dup) throw new ConflictException('AGENT_NAME_EXISTS');
    }
    try {
      return await this.prisma.customAgent.update({
        where: { id: owned.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description.trim() } : {}),
          ...(dto.systemPrompt !== undefined ? { systemPrompt: dto.systemPrompt.trim() } : {}),
          ...(dto.avatarColor !== undefined ? { avatarColor: dto.avatarColor } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('AGENT_NAME_EXISTS');
      throw error;
    }
  }

  async remove(tenantId: string, id: string) {
    const owned = await this.mustGet(tenantId, id);
    return this.prisma.customAgent.delete({ where: { id: owned.id } });
  }
}