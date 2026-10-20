-- 方案绑定场景视频（分享页内联播放用）
ALTER TABLE "PlanProject" ADD COLUMN "videoAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
