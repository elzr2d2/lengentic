-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "completionFieldOrigins" JSONB;

-- AlterTable
ALTER TABLE "Step" ADD COLUMN     "completionFieldOrigins" JSONB;
