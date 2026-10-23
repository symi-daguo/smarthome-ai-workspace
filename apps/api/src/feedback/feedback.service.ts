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

/** 分类的中文名（issue 标题与正文里用） */
const CATEGORY_LABEL: Record<string, string> = {
  bug: '故障',
  feature: '需求',
  other: '其他',
};

/**
 * 作者仓库（owner/repo）。
 *
 * 用环境变量留口子：fork 或二次开发时指向自己的仓库，缺省指向本项目公开仓库。
 * 写成 owner/repo 形式，也接受完整 URL（会剥掉 https://github.com/ 前缀与 .git 后缀）。
 */
const AUTHOR_REPO = (process.env.AUTHOR_REPO ?? 'symi-daguo/smarthome-ai-workspace')
  .trim()
  .replace(/^https?:\/\/github\.com\//i, '')
  .replace(/\.git$/i, '')
  .replace(/^\/+|\/+$/g, '');

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

  /**
   * 「提交到作者仓库」的 issue 预填链接。
   *
   * 为什么要有这一步：反馈工单是**租户内**的，提交它的门店与管理员看得到，
   * 但**作者看不到** —— 每个部署都是独立租户，作者手里没有跨租户的工单视图。
   * 结果就是客户的问题在作者这边根本不存在，只能靠客户自己找到仓库开 issue。
   * 这里把工单内容预填进 GitHub 的「新建 issue」链接，作者就能在仓库里集中处理。
   *
   * 为什么用预填链接而不是服务端调 GitHub API：
   *  - 不需要配 GITHUB_TOKEN，也不需要新增依赖；
   *  - **仓库是公开的**，服务端代发等于把客户的地址、预算、家庭情况直接发到公网 ——
   *    预填链接是打开后由人确认、可以删改，敏感信息由提交者自己决定放不放。
   */
  async issueLink(tenantId: string, id: string) {
    const t = await this.mustGet(tenantId, id);
    const title = `[${CATEGORY_LABEL[t.category] ?? t.category}] ${t.title}`;
    // 正文只放摘要：issue 在公开仓库里，详情越短越不容易带出敏感信息。
    // GitHub 对 URL 长度有上限（中文编码后约 9 字符/字），摘要 300 字是安全余量。
    const summary = (t.detail || '（未填详情）').slice(0, 300);
    const body = [
      '## 客户反馈',
      '',
      `- 类型：${CATEGORY_LABEL[t.category] ?? t.category}`,
      `- 提交时间：${t.createdAt.toISOString()}`,
      `- 工单 id：${t.id}`,
      '',
      summary,
      t.detail && t.detail.length > 300 ? '\n\n（详情较长，此处为前 300 字；完整内容见系统内工单）' : '',
      '',
      '---',
      '由「智能家居 AI 工作台」的「问题反馈」生成。',
    ].join('\n');
    const url = `https://github.com/${AUTHOR_REPO}/issues/new`
      + `?title=${encodeURIComponent(title)}`
      + `&body=${encodeURIComponent(body)}`;
    return { url, repo: AUTHOR_REPO, title, body };
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