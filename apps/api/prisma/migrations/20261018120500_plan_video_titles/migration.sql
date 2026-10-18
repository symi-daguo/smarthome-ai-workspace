-- 视频标题：分享页播放器下方显示门店给视频起的名
ALTER TABLE "PlanProject" ADD COLUMN "videoTitles" TEXT[] DEFAULT ARRAY[]::TEXT[];
