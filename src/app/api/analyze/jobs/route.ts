import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { createAnalyzeJob } from "@/lib/analyze-jobs";

const logger = createLogger('api:analyze:jobs');

const MAX_PAGES = 10;

/**
 * 创建试卷扫描分析任务（后台执行，黑屏/切后台不中断）。
 * 或 ?latest=1 查询最近一次任务（页面恢复用）。
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return unauthorized("Authentication required");
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        if (!user) {
            return unauthorized("No user found in DB");
        }

        const body = await req.json();
        const images: string[] = Array.isArray(body.images) ? body.images.slice(0, MAX_PAGES) : [];
        if (images.length === 0) {
            return badRequest("images required");
        }

        const job = await createAnalyzeJob({
            userId: user.id,
            images,
            mimeType: body.mimeType || "image/jpeg",
            language: body.language === "en" ? "en" : "zh",
            subjectId: body.subjectId || null,
        });

        logger.info({ jobId: job.id, pages: images.length }, 'Analyze job created');
        return NextResponse.json({ jobId: job.id }, { status: 202 });
    } catch (error) {
        logger.error({ error }, 'Error creating analyze job');
        return internalError("Failed to create analyze job");
    }
}

/** 最近一次任务（不含大字段），用于页面重新打开后恢复进度 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return unauthorized("Authentication required");
    }

    try {
        const { searchParams } = new URL(req.url);
        if (searchParams.get("latest") !== "1") {
            return badRequest("only ?latest=1 supported");
        }
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        if (!user) {
            return unauthorized("No user found in DB");
        }

        const job = await prisma.analyzeJob.findFirst({
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
            select: {
                id: true, status: true, mode: true, error: true,
                createdAt: true, completedAt: true, consumedAt: true,
            },
        });

        return NextResponse.json({ job: job || null });
    } catch (error) {
        logger.error({ error }, 'Error fetching latest analyze job');
        return internalError("Failed to fetch analyze job");
    }
}
