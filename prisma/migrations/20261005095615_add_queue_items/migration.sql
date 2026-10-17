-- CreateEnum
CREATE TYPE "QueueItemStatus" AS ENUM ('ACTIVE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QueuePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "QueueContext" AS ENUM ('ANYWHERE', 'HOME', 'WORK', 'COMPUTER', 'PHONE', 'ERRAND');

-- CreateEnum
CREATE TYPE "EnergyLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "QueueItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "QueueItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" "QueuePriority" NOT NULL DEFAULT 'NORMAL',
    "estimatedMinutes" INTEGER,
    "dueAt" TIMESTAMP(3),
    "deferUntil" TIMESTAMP(3),
    "context" "QueueContext" NOT NULL DEFAULT 'ANYWHERE',
    "energy" "EnergyLevel",
    "startedAt" TIMESTAMP(3),
    "timerEndsAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QueueItem_userId_status_idx" ON "QueueItem"("userId", "status");

-- CreateIndex
CREATE INDEX "QueueItem_userId_updatedAt_idx" ON "QueueItem"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "QueueItem_userId_createdAt_idx" ON "QueueItem"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
