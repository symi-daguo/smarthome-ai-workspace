-- 方案页型配图（租户级）
--
-- 背景：PPT 方案每一页的配图此前是**按页型写死的本地图片**
-- （前端 data/planThemes.ts 的 PAGE_IMAGE，形如 /images/cases/c1.jpg），
-- 门店换不了自己的案例图 —— 导出的方案里永远是那几张通用实景图。
--
-- 为什么单独一张表而不是塞进 ModelSetting：
-- 配图是**租户级**的，每家门店自己的案例图不一样；
-- ModelSetting 是**部署级**的（模型地址、密钥），放进去等于所有门店共用一张图。
--
-- 为什么 pageType 是 TEXT 而不是枚举：
-- 页型清单的唯一来源在前端 data/planThemes.ts 的 PAGE_IMAGE，
-- 后端再抄一份枚举必然与前端漂移（前端加了页型、后端就开始拒收）。
-- 这里只存字符串，取值合法性由前端保证。
--
-- 一个租户一个页型只留一条：重复配置走 upsert，不留历史垃圾行。
--
-- 用 IF NOT EXISTS：开发库可能被手工改过，裸 CREATE TABLE 遇到表已存在会直接报错，
-- 容器启动时 migrate deploy 失败、整个 api 起不来。幂等写法让重复执行安全。
CREATE TABLE IF NOT EXISTS "PlanPageImage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanPageImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PlanPageImage_tenantId_pageType_key" ON "PlanPageImage"("tenantId", "pageType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlanPageImage_tenantId_idx" ON "PlanPageImage"("tenantId");
