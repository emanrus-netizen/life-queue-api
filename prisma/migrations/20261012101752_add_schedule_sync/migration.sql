-- AlterTable
ALTER TABLE "UserSchedule" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "UserScheduleSyncReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseJson" JSONB NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserScheduleSyncReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserScheduleSyncReceipt_userId_appliedAt_idx" ON "UserScheduleSyncReceipt"("userId", "appliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserScheduleSyncReceipt_userId_operationId_key" ON "UserScheduleSyncReceipt"("userId", "operationId");

-- AddForeignKey
ALTER TABLE "UserScheduleSyncReceipt" ADD CONSTRAINT "UserScheduleSyncReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
