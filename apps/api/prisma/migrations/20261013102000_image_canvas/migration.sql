CREATE TABLE "ImageConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '新对话',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImageConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImageTurn" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentId" TEXT,
    "prompt" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'assistant',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "error" TEXT,
    "variants" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImageTurn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'image',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultUrl" TEXT,
    "error" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ImageTurn" ADD CONSTRAINT "ImageTurn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ImageConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ImageConversation_tenantId_updatedAt_idx" ON "ImageConversation"("tenantId", "updatedAt");
CREATE INDEX "ImageTurn_conversationId_createdAt_idx" ON "ImageTurn"("conversationId", "createdAt");
CREATE INDEX "ImageTurn_parentId_idx" ON "ImageTurn"("parentId");
CREATE INDEX "GenerationJob_tenantId_createdAt_idx" ON "GenerationJob"("tenantId", "createdAt");