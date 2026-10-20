import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import type { CreateFeedbackDto, UpdateFeedbackDto } from './feedback.schemas.js';

/**
 * 工单状态机（正向单向流转）。
 * resolved 只能从 open/processing 进入，closed 只能从 resolved 进入。
 * 非法流转（open→closed、closed→resolved、resolved→open 等）直接 400 拒绝，
 * 不做「静默原样返回」——否则调用方无法区分成功与被忽略，只能自己回读比对。
 */
const TRANSITIONS: Record<string, string[]> = {
  open: ['processing', 'resolved'],
  processing: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

/** 计算状态流转：目标等于当前视为幂等不变；合法则前进；否则抛 400 */
function resolveStatus(current: string, next: string): string {
  if (next === current) return next;
  if ((TRANSITIONS[current] ?? []).includes(next)) return next;
  throw new BadRequestException(`INVALID_STATUS_TRANSITION:${current}->${next}`);
}

/**
 * 问题反馈服务：租户内的问题/需求工单。
 * 提交与查看对所有登录成员开放（content:generate）；状态推进与回复仅管理员（platform:billing:manage）；
 * 删除仅提交者本人可操作。数据按 activeTenantId 隔离。
 */
@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  private async mustGet(tenantId: string, id: string) {
    const ticket = await this.prisma.feedbackTicket.findFirst({ where: { id, tenantId } });
    if (!ticket) throw new NotFoundException('FEEDBACK_NOT_FOUND');
    return ticket;
  }

  list(tenantId: string) {
    return this.prisma.feedbackTicket.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  detail(tenantId: string, id: string) {
    return this.mustGet(tenantId, id);
  }

  /** 提交工单：userId 取当前登录用户，不接受请求体传入 */
  create(tenantId: string, userId: string, dto: CreateFeedbackDto) {
    return this.prisma.feedbackTicket.create({
      data: {
        tenantId,
        userId,
        category: dto.category,
        title: dto.title.trim(),
        detail: dto.detail?.trim() ?? '',
      },
    });
  }

  /** 处理工单（管理员）：推进状态 + 写入官方回复 */
  async update(tenantId: string, id: string, operatorId: string, dto: UpdateFeedbackDto) {
    const ticket = await this.mustGet(tenantId, id);
    return this.prisma.feedbackTicket.update({
      where: { id: ticket.id },
      data: {
        ...(dto.status !== undefined ? { status: resolveStatus(ticket.status, dto.status) } : {}),
        ...(dto.reply !== undefined ? { reply: dto.reply.trim(), repliedBy: operatorId } : {}),
      },
    });
  }

  /** 删除工单：仅提交者本人可删，非本人 403 */
  async remove(tenantId: string, id: string, userId: string) {
    const ticket = await this.prisma.feedbackTicket.findFirst({
      where: { id, tenantId },
      select: { id: true, userId: true },
    });
    if (!ticket) throw new NotFoundException('FEEDBACK_NOT_FOUND');
    if (ticket.userId !== userId) throw new ForbiddenException('FEEDBACK_NOT_OWNER');
    return this.prisma.feedbackTicket.delete({ where: { id: ticket.id } });
  }
}