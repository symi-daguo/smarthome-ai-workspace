-- CreateTable
CREATE TABLE "PlanProject" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "customer" TEXT NOT NULL DEFAULT '',
    "area" TEXT NOT NULL DEFAULT '',
    "budget" TEXT NOT NULL DEFAULT '',
    "ecosystem" TEXT NOT NULL DEFAULT '',
    "store" TEXT NOT NULL DEFAULT '',
    "highlights" TEXT NOT NULL DEFAULT '',
    "style" TEXT NOT NULL DEFAULT 'A',
    "edition" TEXT NOT NULL DEFAULT 'standard',
    "pages" JSONB NOT NULL,
    "versionNo" INTEGER NOT NULL DEFAULT 0,
    "shareToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanProject_shareToken_key" ON "PlanProject"("shareToken");

-- CreateIndex
CREATE INDEX "PlanProject_tenantId_createdAt_idx" ON "PlanProject"("tenantId", "createdAt");
