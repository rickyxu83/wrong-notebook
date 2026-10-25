-- AlterTable
ALTER TABLE "PracticeJob" ADD COLUMN "paperId" TEXT REFERENCES "PracticePaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PracticeJob" ADD COLUMN "orderIndex" INTEGER;

-- CreateTable
CREATE TABLE "PracticePaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "language" TEXT NOT NULL DEFAULT 'zh',
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "PracticePaper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PracticeJob_paperId_idx" ON "PracticeJob"("paperId");

-- CreateIndex
CREATE INDEX "PracticePaper_userId_createdAt_idx" ON "PracticePaper"("userId", "createdAt");
