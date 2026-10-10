-- 标准产品主数据：编码标识 / 规格质保 / 三级价格 / 多级返利
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sku" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "barcode" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "snRule" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "spec" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "warranty" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "priceRetail" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priceDealer" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priceProject" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rebateL1" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rebateL2" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rebateDesigner" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Product_sku_idx" ON "Product"("sku");
