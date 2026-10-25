import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { runPracticePaper } from "@/lib/practice-jobs";

const logger = createLogger('api:practice:papers:[id]');

/** 查询试卷状态与全部题目（试卷页轮询 / 打印页加载） */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return unauthorized("Authentication required");
    }

    try {
        const { id } = await params;
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        if (!user) {
            return unauthorized("No user found in DB");
        }

        const paper = await prisma.practicePaper.findUnique({
            where: { id },
            include: {
                jobs: {
                    orderBy: { orderIndex: "asc" },
                    select: {
                        id: true,
                        errorItemId: true,
                        orderIndex: true,
                        status: true,
                        difficulty: true,
                        resultJson: true,
                        error: true,
                        createdAt: true,
                        completedAt: true,
                        // 依赖图形的相似题需要展示原题图（同图不同数）
                        errorItem: { select: { originalImageUrl: true } },
                    },
                },
            },
        });

        if (!paper || paper.userId !== user.id) {
            return notFound("Paper not found");
        }

        const jobs = paper.jobs.map((j) => {
            let result: Record<string, unknown> | null = null;
            if (j.resultJson) {
                try {
                    result = JSON.parse(j.resultJson);
                } catch {
                    result = null;
                }
            }
            // 只有 AI 判定依赖图形的题才附带原题图，避免无谓的大字段传输
            const needsFigure = result?.requiresImage === true;
            return {
                id: j.id,
                errorItemId: j.errorItemId,
                orderIndex: j.orderIndex,
                status: j.status,
                difficulty: j.difficulty,
                error: j.error,
                createdAt: j.createdAt,
                completedAt: j.completedAt,
                result,
                referenceImageUrl: needsFigure ? (j.errorItem?.originalImageUrl || null) : null,
            };
        });

        return NextResponse.json({
            id: paper.id,
            status: paper.status,
            difficulty: paper.difficulty,
            language: paper.language,
            createdAt: paper.createdAt,
            completedAt: paper.completedAt,
            total: jobs.length,
            doneCount: jobs.filter((j) => j.status === "done").length,
            failedCount: jobs.filter((j) => j.status === "failed").length,
            jobs,
        });
    } catch (error) {
        logger.error({ error }, 'Error fetching practice paper');
        return internalError("Failed to fetch practice paper");
    }
}

/** 重试整卷中失败的题目；已完成题目保持不变。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Authentication required");

    try {
        const { id } = await params;
        const body = await req.json().catch(() => ({}));
        if (body.action !== "retryFailed") return badRequest("Unsupported action");

        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        if (!user) return unauthorized("No user found in DB");

        const paper = await prisma.practicePaper.findUnique({
            where: { id },
            select: { id: true, userId: true, status: true },
        });
        if (!paper || paper.userId !== user.id) return notFound("Paper not found");
        if (paper.status === "running") return badRequest("Paper is still running");

        const failedJobs = await prisma.practiceJob.findMany({
            where: { paperId: id, status: "failed" },
            select: { id: true },
        });
        if (failedJobs.length === 0) return badRequest("No failed questions to retry");

        await prisma.practiceJob.updateMany({
            where: { paperId: id, status: "failed" },
            data: { status: "pending", error: null, resultJson: null, completedAt: null },
        });
        await prisma.practicePaper.update({
            where: { id },
            data: { status: "running", completedAt: null },
        });

        void runPracticePaper(id).catch((error) => {
            logger.error({ error, paperId: id }, 'Unhandled practice paper retry error');
        });
        logger.info({ paperId: id, count: failedJobs.length }, 'Retrying failed practice questions');
        return NextResponse.json({ retrying: failedJobs.length }, { status: 202 });
    } catch (error) {
        logger.error({ error }, 'Error retrying practice paper');
        return internalError("Failed to retry practice paper");
    }
}
