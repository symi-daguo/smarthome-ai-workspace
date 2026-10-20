-- CreateTable
CREATE TABLE "ModelProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "updated" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelProfile_name_key" ON "ModelProfile"("name");
