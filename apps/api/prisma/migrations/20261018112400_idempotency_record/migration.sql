-- 提交幂等记录表：保证同一 clientRequestId 只真正执行一次（不重复扣额度）
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- 并发防线的真身：第二个同键并发请求会撞这条唯一约束
CREATE UNIQUE INDEX "idempotency_tenant_key" ON "IdempotencyRecord"("tenantId", "key");

CREATE INDEX "IdempotencyRecord_tenantId_kind_idx" ON "IdempotencyRecord"("tenantId", "kind");
