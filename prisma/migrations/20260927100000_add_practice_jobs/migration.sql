-- CreateTable
CREATE TABLE "PracticeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "errorItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "language" TEXT NOT NULL DEFAULT 'zh',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "PracticeJob_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PracticeJob_errorItemId_idx" ON "PracticeJob"("errorItemId");

-- CreateIndex
CREATE INDEX "PracticeJob_userId_status_idx" ON "PracticeJob"("userId", "status");
