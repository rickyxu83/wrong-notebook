import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { notFound, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { createPracticeJob } from "@/lib/practice-jobs";

const logger = createLogger('api:practice:generate');

/**
 * 异步举一反三：创建出题任务立即返回 jobId，
 * AI 出题在后台执行，前端轮询 /api/practice/jobs/[id] 获取结果。
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    try {
        const { errorItemId, language, difficulty } = await req.json();

        const errorItem = await prisma.errorItem.findUnique({
            where: { id: errorItemId },
            select: { id: true, userId: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        const job = await createPracticeJob({ errorItemId, userId: errorItem.userId, difficulty, language });
        logger.info({ jobId: job.id, errorItemId, difficulty }, 'Practice job created');

        return NextResponse.json({ jobId: job.id, status: job.status }, { status: 202 });
    } catch (error) {
        logger.error({ error }, 'Error creating practice job');
        const errorMessage = error instanceof Error ? error.message : "Failed to create practice job";
        return internalError(errorMessage);
    }
}
