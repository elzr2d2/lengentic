-- CreateTable
CREATE TABLE "IngestedEvent" (
    "eventId" VARCHAR(128) NOT NULL,
    "runId" VARCHAR(128) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IngestedEvent_pkey" PRIMARY KEY ("runId","eventId")
);
