import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

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
                    },
                },
            },
        });

        if (!paper || paper.userId !== user.id) {
            return notFound("Paper not found");
        }

        const jobs = paper.jobs.map((j) => ({
            id: j.id,
            errorItemId: j.errorItemId,
            orderIndex: j.orderIndex,
            status: j.status,
            difficulty: j.difficulty,
            error: j.error,
            createdAt: j.createdAt,
            completedAt: j.completedAt,
            result: j.resultJson ? JSON.parse(j.resultJson) : null,
        }));

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
