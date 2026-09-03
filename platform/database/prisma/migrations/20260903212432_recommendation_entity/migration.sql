-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('OPEN', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RecommendationCategory" AS ENUM ('DETERMINISTIC_CANDIDATE');

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" VARCHAR(128) NOT NULL,
    "category" "RecommendationCategory" NOT NULL,
    "analyzerId" VARCHAR(200) NOT NULL,
    "analyzerVersion" VARCHAR(200) NOT NULL,
    "workflowName" VARCHAR(200) NOT NULL,
    "workflowVersion" VARCHAR(200) NOT NULL,
    "decisionType" VARCHAR(200) NOT NULL,
    "contextKeyVersion" VARCHAR(200) NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "sourceWatermark" TIMESTAMPTZ(3) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "evidence" JSONB NOT NULL,
    "counterexamples" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'OPEN',
    "statusNote" TEXT,
    "statusChangedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_fingerprint_key" ON "Recommendation"("fingerprint");

-- CreateIndex
CREATE INDEX "Recommendation_status_lastSeenAt_idx" ON "Recommendation"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Recommendation_workflowName_workflowVersion_idx" ON "Recommendation"("workflowName", "workflowVersion");
