-- CreateTable
CREATE TABLE "AnalyzeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mode" TEXT NOT NULL DEFAULT 'grade',
    "language" TEXT NOT NULL DEFAULT 'zh',
    "subjectId" TEXT,
    "pagesJson" TEXT NOT NULL,
    "resultJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "consumedAt" DATETIME,
    CONSTRAINT "AnalyzeJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AnalyzeJob_userId_status_idx" ON "AnalyzeJob"("userId", "status");

-- CreateIndex
CREATE INDEX "AnalyzeJob_userId_createdAt_idx" ON "AnalyzeJob"("userId", "createdAt");
