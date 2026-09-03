-- AlterTable
ALTER TABLE "ToolCall" ALTER COLUMN "inputBytes" DROP NOT NULL,
ALTER COLUMN "outputBytes" DROP NOT NULL;
