-- CreateEnum
CREATE TYPE "QueueSyncOperationKind" AS ENUM ('CREATE', 'UPDATE', 'START', 'SNOOZE', 'COMPLETE', 'CANCEL', 'EXTEND');

-- CreateTable
CREATE TABLE "QueueSyncReceipt" (
    "operationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "QueueSyncOperationKind" NOT NULL,
    "requestHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueSyncReceipt_pkey" PRIMARY KEY ("userId","operationId")
);

-- CreateIndex
CREATE INDEX "QueueSyncReceipt_userId_entityId_appliedAt_idx" ON "QueueSyncReceipt"("userId", "entityId", "appliedAt");

-- CreateIndex
CREATE INDEX "QueueSyncReceipt_userId_appliedAt_idx" ON "QueueSyncReceipt"("userId", "appliedAt");

-- AddForeignKey
ALTER TABLE "QueueSyncReceipt" ADD CONSTRAINT "QueueSyncReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
