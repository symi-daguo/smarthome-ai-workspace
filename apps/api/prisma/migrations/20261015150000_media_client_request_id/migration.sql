-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "clientRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_clientRequestId_key" ON "MediaAsset"("clientRequestId");
