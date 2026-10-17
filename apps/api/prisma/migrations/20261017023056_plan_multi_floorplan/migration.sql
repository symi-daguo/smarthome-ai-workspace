-- AlterTable
ALTER TABLE "PlanProject" ADD COLUMN     "extraFloorplanAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "floorplanFloors" TEXT[] DEFAULT ARRAY[]::TEXT[];
