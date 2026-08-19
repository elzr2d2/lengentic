-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Run" (
    "id" VARCHAR(128) NOT NULL,
    "traceId" VARCHAR(128) NOT NULL,
    "workflowName" VARCHAR(200),
    "workflowVersion" VARCHAR(200),
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastEventAt" TIMESTAMPTZ(3) NOT NULL,
    "startEventId" VARCHAR(128),
    "completionEventId" VARCHAR(128),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Step" (
    "id" VARCHAR(128) NOT NULL,
    "runId" VARCHAR(128) NOT NULL,
    "parentStepId" VARCHAR(128),
    "name" VARCHAR(200),
    "agentName" VARCHAR(200),
    "type" VARCHAR(200),
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "startEventId" VARCHAR(128),
    "completionEventId" VARCHAR(128),
    "metadata" JSONB,

    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Run_workflowName_workflowVersion_idx" ON "Run"("workflowName", "workflowVersion");

-- CreateIndex
CREATE INDEX "Step_runId_idx" ON "Step"("runId");

-- CreateIndex
CREATE INDEX "Step_parentStepId_idx" ON "Step"("parentStepId");
