-- AlterTable
ALTER TABLE "PlanProject" ADD COLUMN     "renderAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "renderAssetMeta" JSONB NOT NULL DEFAULT '[]';
