-- 视频时长（秒）：采集契约里一直有这个字段，但表里没有列，
-- Agent 按契约采回来提交成功、数据被静默丢弃。
-- 可空：契约允许「拿不到就留空」，不填不影响任何现有查询。
ALTER TABLE "BenchmarkContent" ADD COLUMN "durationSec" INTEGER;
