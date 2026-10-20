-- AlterTable
ALTER TABLE "PlanProject" ADD COLUMN     "budgetItems" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "budgetSource" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "excludedItems" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "existingDevices" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "priorityNeeds" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "renovationStage" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "serviceContact" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "serviceEvidence" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "serviceScope" TEXT NOT NULL DEFAULT '';
