-- AlterTable
ALTER TABLE "PlanProject" ADD COLUMN     "floorplanAssetId" TEXT,
ADD COLUMN     "layoutPoints" JSONB;

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priceMin" INTEGER NOT NULL DEFAULT 0,
    "priceMax" INTEGER NOT NULL DEFAULT 0,
    "perRoom" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorplanLayout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "points" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorplanLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_name_key" ON "Product"("name");

-- CreateIndex
CREATE INDEX "Product_category_sortOrder_idx" ON "Product"("category", "sortOrder");

-- CreateIndex
CREATE INDEX "FloorplanLayout_tenantId_createdAt_idx" ON "FloorplanLayout"("tenantId", "createdAt");
