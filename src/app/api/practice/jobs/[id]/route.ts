import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:practice:jobs:id');

/** 轮询单个出题任务状态；完成时返回出题结果 */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    try {
        const { id } = await params;
        const job = await prisma.practiceJob.findUnique({ where: { id } });
        if (!job) {
            return notFound("Job not found");
        }

        let result = null;
        if (job.status === "done" && job.resultJson) {
            try {
                result = JSON.parse(job.resultJson);
            } catch {
                result = null;
            }
        }

        return NextResponse.json({
            id: job.id,
            errorItemId: job.errorItemId,
            status: job.status,
            difficulty: job.difficulty,
            error: job.error,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            result,
        });
    } catch (error) {
        logger.error({ error }, 'Error fetching practice job');
        return internalError("Failed to fetch practice job");
    }
}
