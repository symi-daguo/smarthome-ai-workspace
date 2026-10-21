-- 对标账号情报：配置对标账号 → 采集热门内容元数据 → AI 映射学习比对
--
-- 三张新表：
--   BenchmarkAccount  我们盯谁（用户自填平台名与主页链接，不枚举任何平台品牌）
--   BenchmarkContent  采集回来的内容元数据（只存元数据与文案，不下载视频本体）
--   BenchmarkInsight  AI 映射结果：风格画像 + 与我们业务的差距
--
-- 幂等写法：开发库可能被手工改过，或上一次部署中途失败留下半截状态。
-- 裸 CREATE TABLE / ADD COLUMN 遇到已存在会直接报错，容器启动时 migrate deploy
-- 失败、整个 api 起不来。幂等写法让重复执行安全。
CREATE TABLE IF NOT EXISTS "BenchmarkAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "homeUrl" TEXT NOT NULL,
    "tags" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BenchmarkAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BenchmarkContent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "sourceUrl" TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3),
    "stats" TEXT NOT NULL DEFAULT '{}',
    "hotScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "topics" TEXT NOT NULL DEFAULT '',
    "coverUrl" TEXT NOT NULL DEFAULT '',
    "batchId" TEXT NOT NULL DEFAULT '',
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BenchmarkContent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BenchmarkInsight" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL DEFAULT '',
    "analysis" TEXT NOT NULL DEFAULT '{}',
    "gaps" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BenchmarkInsight_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BenchmarkAccount_tenantId_enabled_idx" ON "BenchmarkAccount"("tenantId", "enabled");
CREATE INDEX IF NOT EXISTS "BenchmarkAccount_tenantId_createdAt_idx" ON "BenchmarkAccount"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "BenchmarkContent_tenantId_accountId_idx" ON "BenchmarkContent"("tenantId", "accountId");
CREATE INDEX IF NOT EXISTS "BenchmarkContent_tenantId_hotScore_idx" ON "BenchmarkContent"("tenantId", "hotScore");
CREATE INDEX IF NOT EXISTS "BenchmarkContent_tenantId_collectedAt_idx" ON "BenchmarkContent"("tenantId", "collectedAt");
CREATE INDEX IF NOT EXISTS "BenchmarkInsight_tenantId_accountId_idx" ON "BenchmarkInsight"("tenantId", "accountId");
CREATE INDEX IF NOT EXISTS "BenchmarkInsight_tenantId_createdAt_idx" ON "BenchmarkInsight"("tenantId", "createdAt");

-- 幂等键：同一账号同一条内容不重复入库（采集端重试、跨天重采都命中）
CREATE UNIQUE INDEX IF NOT EXISTS "BenchmarkContent_tenantId_accountId_sourceUrl_key"
  ON "BenchmarkContent"("tenantId", "accountId", "sourceUrl");

-- 知识库加来源标记：情报投影进来的资料要能和上传的资料区分开（列表分组 + 溯源）
ALTER TABLE "KnowledgeDoc"
  ADD COLUMN IF NOT EXISTS "sourceType" TEXT NOT NULL DEFAULT 'file',
  ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT NOT NULL DEFAULT '';

-- 去掉素材库 UGC 投稿交易：开源自用场景没有投稿数据来源
DROP TABLE IF EXISTS "MaterialSubmission";
