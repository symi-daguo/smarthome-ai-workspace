-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SnapshotTrigger" AS ENUM ('MANUAL', 'AUTO');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorKind" "ActorKind" NOT NULL DEFAULT 'USER',
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "method" TEXT,
ADD COLUMN     "ok" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "path" TEXT,
ADD COLUMN     "payloadDigest" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "snapshotId" TEXT,
ADD COLUMN     "statusCode" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isServiceAccount" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditLogId" TEXT,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT,
    "label" TEXT NOT NULL,
    "trigger" "SnapshotTrigger" NOT NULL DEFAULT 'MANUAL',
    "data" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditLogId" TEXT,

    CONSTRAINT "ChangeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

-- CreateIndex
CREATE INDEX "ChangeSnapshot_tenantId_createdAt_idx" ON "ChangeSnapshot"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");

-- CreateIndex
CREATE INDEX "AuditLog_actorKind_createdAt_idx" ON "AuditLog"("actorKind", "createdAt");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "AuditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeSnapshot" ADD CONSTRAINT "ChangeSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeSnapshot" ADD CONSTRAINT "ChangeSnapshot_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "AuditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
