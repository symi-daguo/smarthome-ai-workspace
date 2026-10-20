-- 定制智能体 / 问题反馈 / 智能灯光场景编排
CREATE TABLE "CustomAgent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "avatarColor" TEXT NOT NULL DEFAULT '#5B5BF0',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomAgent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeedbackTicket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "reply" TEXT NOT NULL DEFAULT '',
    "repliedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackTicket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LightingScene" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceAssetId" TEXT,
    "ratio" TEXT NOT NULL DEFAULT '16:9',
    "fixtures" JSONB NOT NULL,
    "timeline" JSONB NOT NULL,
    "videoAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LightingScene_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomAgent_tenantId_name_key" ON "CustomAgent"("tenantId", "name");
CREATE INDEX "CustomAgent_tenantId_createdAt_idx" ON "CustomAgent"("tenantId", "createdAt");
CREATE INDEX "FeedbackTicket_tenantId_createdAt_idx" ON "FeedbackTicket"("tenantId", "createdAt");
CREATE INDEX "LightingScene_tenantId_createdAt_idx" ON "LightingScene"("tenantId", "createdAt");