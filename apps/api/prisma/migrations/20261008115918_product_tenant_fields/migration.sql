-- DropIndex
DROP INDEX "Product_name_key";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "brand" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "imageUrl" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "model" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "tenantId" TEXT,
ADD COLUMN     "unit" TEXT NOT NULL DEFAULT '台';

-- CreateIndex
CREATE INDEX "Product_tenantId_category_idx" ON "Product"("tenantId", "category");
