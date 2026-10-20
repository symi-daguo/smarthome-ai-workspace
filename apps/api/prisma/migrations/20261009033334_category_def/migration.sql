-- CreateTable
CREATE TABLE "CategoryDef" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#888888',
    "icon" TEXT NOT NULL DEFAULT 'radar',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CategoryDef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CategoryDef_tenantId_active_idx" ON "CategoryDef"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryDef_tenantId_key_key" ON "CategoryDef"("tenantId", "key");
