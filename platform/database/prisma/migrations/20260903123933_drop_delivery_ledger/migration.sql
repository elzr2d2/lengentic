-- CreateTable
CREATE TABLE "DropDelivery" (
    "runId" VARCHAR(128) NOT NULL,
    "deliveryId" VARCHAR(128) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DropDelivery_pkey" PRIMARY KEY ("runId","deliveryId")
);
