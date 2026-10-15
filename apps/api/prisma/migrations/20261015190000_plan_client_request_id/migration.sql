-- AlterTable
ALTER TABLE "PlanProject" ADD COLUMN     "clientRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PlanProject_clientRequestId_key" ON "PlanProject"("clientRequestId");
