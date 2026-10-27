/**
 * Prisma 唯一约束冲突的判定。
 *
 * 这段判定此前在 auth / agents / idempotency 三处各抄了一份，
 * 抄漏一处的地方就少了「重名转 409」或「幂等键撞车」的兜底 ——
 * 而且三处抄的是同一个魔法字符串 'P2002'，改 Prisma 版本时最容易漏改一处。
 * 统一放这里，要改只改一处。
 */
const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}
