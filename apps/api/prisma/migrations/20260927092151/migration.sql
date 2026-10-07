-- CreateEnum
CREATE TYPE "ExtractionSource" AS ENUM ('UPLOAD', 'URL', 'TRANSCRIPT');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'EXTRACTING', 'REVIEWING', 'CONFIRMED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "ExtractionJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT,
    "source" "ExtractionSource" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "score" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedDocument" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "docType" TEXT NOT NULL DEFAULT 'generic',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedField" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "confidence" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionDeficiency" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionDeficiency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewConfirmation" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExtractionJob_tenantId_createdAt_idx" ON "ExtractionJob"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedDocument_jobId_key" ON "ExtractedDocument"("jobId");

-- CreateIndex
CREATE INDEX "ExtractedDocument_tenantId_confirmed_idx" ON "ExtractedDocument"("tenantId", "confirmed");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedField_documentId_key_key" ON "ExtractedField"("documentId", "key");

-- CreateIndex
CREATE INDEX "ExtractionDeficiency_jobId_idx" ON "ExtractionDeficiency"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewConfirmation_jobId_key" ON "ReviewConfirmation"("jobId");

-- AddForeignKey
ALTER TABLE "ExtractedDocument" ADD CONSTRAINT "ExtractedDocument_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedField" ADD CONSTRAINT "ExtractedField_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ExtractedDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionDeficiency" ADD CONSTRAINT "ExtractionDeficiency_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewConfirmation" ADD CONSTRAINT "ReviewConfirmation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
