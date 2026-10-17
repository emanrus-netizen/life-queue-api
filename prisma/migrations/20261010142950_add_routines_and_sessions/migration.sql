-- CreateEnum
CREATE TYPE "RoutineTimePreference" AS ENUM ('ANYTIME', 'MORNING', 'AFTERNOON', 'EVENING');

-- CreateEnum
CREATE TYPE "RoutineSessionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "RoutineSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "status" "RoutineSessionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "timerEndsAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutineSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifeRoutine" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetSessionsPerWeek" INTEGER NOT NULL DEFAULT 3,
    "preferredMinutes" INTEGER NOT NULL DEFAULT 30,
    "preferredTime" "RoutineTimePreference" NOT NULL DEFAULT 'ANYTIME',
    "context" "QueueContext" NOT NULL DEFAULT 'ANYWHERE',
    "energy" "EnergyLevel",
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifeRoutine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoutineSession_userId_startedAt_idx" ON "RoutineSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "RoutineSession_userId_updatedAt_idx" ON "RoutineSession"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "RoutineSession_routineId_startedAt_idx" ON "RoutineSession"("routineId", "startedAt");

-- CreateIndex
CREATE INDEX "LifeRoutine_userId_isActive_idx" ON "LifeRoutine"("userId", "isActive");

-- CreateIndex
CREATE INDEX "LifeRoutine_userId_updatedAt_idx" ON "LifeRoutine"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LifeRoutine_id_userId_key" ON "LifeRoutine"("id", "userId");

-- AddForeignKey
ALTER TABLE "RoutineSession" ADD CONSTRAINT "RoutineSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutineSession" ADD CONSTRAINT "RoutineSession_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "LifeRoutine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifeRoutine" ADD CONSTRAINT "LifeRoutine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
