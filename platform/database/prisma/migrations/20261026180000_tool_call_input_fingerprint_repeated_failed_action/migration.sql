-- AlterEnum
ALTER TYPE "RecommendationCategory" ADD VALUE 'REPEATED_FAILED_ACTION';

-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN     "inputFingerprint" VARCHAR(128),
ADD COLUMN     "runId" VARCHAR(128),
ADD COLUMN     "toolName" VARCHAR(200),
ALTER COLUMN "workflowName" DROP NOT NULL,
ALTER COLUMN "workflowVersion" DROP NOT NULL,
ALTER COLUMN "decisionType" DROP NOT NULL,
ALTER COLUMN "contextKeyVersion" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ToolCall" ADD COLUMN     "inputFingerprint" VARCHAR(128);
