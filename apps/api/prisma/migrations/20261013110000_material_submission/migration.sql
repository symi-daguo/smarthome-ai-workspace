CREATE TABLE "MaterialSubmission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "desc" TEXT NOT NULL DEFAULT '',
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaterialSubmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MaterialSubmission_tenantId_createdAt_idx" ON "MaterialSubmission"("tenantId", "createdAt");
CREATE INDEX "MaterialSubmission_status_idx" ON "MaterialSubmission"("status");
