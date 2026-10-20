import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma, TokenReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module.js';

export interface TokenBalance {
  tenantId: string;
  tokenBalance: number;
}

/** token 计量与账本：全部写操作在数据库事务内完成 */

// tokenBalance 列为 int4；余额恒不超过该上限，故请求额超过上限时等价于余额不足，
// 提前挡掉以避免数据库范围错误（ponytail: 单租户余额突破 21.5 亿 token 时再迁移 BigInt）
const MAX_TOKEN_BALANCE = 2_147_483_647;

@Injectable()
export class TokenService {
  constructor(private readonly prisma: PrismaService) {}

  async balance(tenantId: string): Promise<TokenBalance> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tokenBalance: true },
    });
    if (!tenant) throw new ForbiddenException('TENANT_NOT_FOUND');
    return { tenantId, tokenBalance: tenant.tokenBalance };
  }

  /** 事务内扣减；余额不足抛 TOKEN_INSUFFICIENT 并回滚 */
  async consume(
    tenantId: string,
    amount: number,
    reason: TokenReason = 'CONSUME',
    meta?: Prisma.InputJsonValue,
    userId?: string,
  ): Promise<TokenBalance> {
    this.assertPositive(amount);
    if (amount > MAX_TOKEN_BALANCE) throw new ForbiddenException('TOKEN_INSUFFICIENT');
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.tenant.updateMany({
        where: { id: tenantId, tokenBalance: { gte: amount } },
        data: { tokenBalance: { decrement: amount } },
      });
      if (result.count === 0) throw new ForbiddenException('TOKEN_INSUFFICIENT');
      await tx.tokenLedger.create({ data: { tenantId, userId, delta: -amount, reason, meta } });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { tokenBalance: true },
      });
      return { tenantId, tokenBalance: tenant.tokenBalance };
    });
  }

  async grant(tenantId: string, amount: number, note?: string, userId?: string): Promise<TokenBalance> {
    this.assertPositive(amount);
    return this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { tokenBalance: { increment: amount } } });
      await tx.tokenLedger.create({
        data: { tenantId, userId, delta: amount, reason: 'GRANT', meta: note ? { note } : undefined },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { tokenBalance: true },
      });
      return { tenantId, tokenBalance: tenant.tokenBalance };
    });
  }

  async ledger(tenantId: string, take = 50) {
    return this.prisma.tokenLedger.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  private assertPositive(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('AMOUNT_MUST_BE_POSITIVE_INTEGER');
    }
  }
}
