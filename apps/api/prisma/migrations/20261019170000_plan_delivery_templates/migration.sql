-- 交付模版：户型图设计样式 + 产品放置样式
--
-- 为什么单独一列而不是塞进 style：style 是 A-K 视觉主题（配色/字体），
-- 这两个字段决定的是「户型页长什么样、点位怎么标」，属于交付结构而非视觉，
-- 分开存才能在编辑器里各自独立切换而不互相覆盖。
--
-- 默认值选 annotated / numbered 而不是沿用旧行为 icon：
-- 行业对点位图的基本要求是「带图例和点位表，编号可核对」
-- （小米 MICA 数字家庭工程师课程公开讲义 + 参考站 wifi-heatmap.js 的
--   drawDevices 编号 + 标签模式，见 web/src/data/planTemplates.ts）。
-- 老数据在这两列上取默认值后即自动变成标准样式，不需要数据回填脚本。
-- 用 IF NOT EXISTS 而不是裸 ADD COLUMN：
-- 开发库可能被手工改过（或上一次部署中途失败留下半截状态），
-- 裸 ADD COLUMN 遇到列已存在会直接报错，容器启动时 migrate deploy 失败、
-- 整个 api 起不来。幂等写法让重复执行安全。
ALTER TABLE "PlanProject"
  ADD COLUMN IF NOT EXISTS "floorplanTemplate" TEXT NOT NULL DEFAULT 'annotated',
  ADD COLUMN IF NOT EXISTS "markerTemplate" TEXT NOT NULL DEFAULT 'numbered';
