-- CreateEnum
CREATE TYPE "RoutineSyncOperationKind" AS ENUM ('CREATE_ROUTINE', 'UPDATE_ROUTINE', 'START_SESSION', 'EXTEND_SESSION', 'COMPLETE_SESSION');

-- CreateTable
CREATE TABLE "RoutineSyncReceipt" (
    "operationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "RoutineSyncOperationKind" NOT NULL,
    "requestHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseJson" JSONB NOT NULL,

    CONSTRAINT "RoutineSyncReceipt_pkey" PRIMARY KEY ("userId","operationId")
);

-- CreateIndex
CREATE INDEX "RoutineSyncReceipt_userId_entityId_appliedAt_idx" ON "RoutineSyncReceipt"("userId", "entityId", "appliedAt");

-- CreateIndex
CREATE INDEX "RoutineSyncReceipt_userId_appliedAt_idx" ON "RoutineSyncReceipt"("userId", "appliedAt");

-- AddForeignKey
ALTER TABLE "RoutineSyncReceipt" ADD CONSTRAINT "RoutineSyncReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
