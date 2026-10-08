-- CreateTable
CREATE TABLE "ModelSetting" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "updated" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelSetting_scope_key" ON "ModelSetting"("scope");
