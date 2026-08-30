-- CreateEnum
CREATE TYPE "DecisionOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OutcomeAttestedBy" AS ENUM ('CALLER', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Decision" (
    "id" VARCHAR(128) NOT NULL,
    "runId" VARCHAR(128) NOT NULL,
    "stepId" VARCHAR(128),
    "decisionType" VARCHAR(200),
    "contextKey" VARCHAR(200),
    "contextKeyVersion" VARCHAR(200),
    "rawContext" JSONB,
    "availableOptions" JSONB,
    "selectedOption" VARCHAR(200),
    "outcome" "DecisionOutcome" NOT NULL DEFAULT 'UNKNOWN',
    "outcomeAttestedBy" "OutcomeAttestedBy" NOT NULL DEFAULT 'UNKNOWN',
    "outcomeObservedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCall" (
    "id" VARCHAR(128) NOT NULL,
    "runId" VARCHAR(128) NOT NULL,
    "stepId" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(200) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "status" VARCHAR(200) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" VARCHAR(128) NOT NULL,
    "runId" VARCHAR(128) NOT NULL,
    "stepId" VARCHAR(128) NOT NULL,
    "toolName" VARCHAR(200) NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "inputTruncated" BOOLEAN NOT NULL DEFAULT false,
    "outputTruncated" BOOLEAN NOT NULL DEFAULT false,
    "inputBytes" INTEGER NOT NULL,
    "outputBytes" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Error" (
    "id" VARCHAR(128) NOT NULL,
    "runId" VARCHAR(128) NOT NULL,
    "stepId" VARCHAR(128) NOT NULL,
    "type" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Error_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Decision_runId_idx" ON "Decision"("runId");

-- CreateIndex
CREATE INDEX "Decision_stepId_idx" ON "Decision"("stepId");

-- CreateIndex
CREATE INDEX "ModelCall_runId_idx" ON "ModelCall"("runId");

-- CreateIndex
CREATE INDEX "ModelCall_stepId_idx" ON "ModelCall"("stepId");

-- CreateIndex
CREATE INDEX "ToolCall_runId_idx" ON "ToolCall"("runId");

-- CreateIndex
CREATE INDEX "ToolCall_stepId_idx" ON "ToolCall"("stepId");

-- CreateIndex
CREATE INDEX "Error_runId_idx" ON "Error"("runId");

-- CreateIndex
CREATE INDEX "Error_stepId_idx" ON "Error"("stepId");
