import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:analyze:jobs:[id]');

/** 轮询任务状态；?includePages=1 时附带页图（恢复场景） */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return unauthorized("Authentication required");
    }

    try {
        const { id } = await params;
        const { searchParams } = new URL(req.url);
        const includePages = searchParams.get("includePages") === "1";

        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        if (!user) {
            return unauthorized("No user found in DB");
        }

        const job = await prisma.analyzeJob.findUnique({ where: { id } });
        if (!job || job.userId !== user.id) {
            return notFound("Job not found");
        }

        // 尸体任务守卫：pending/running 超过 15 分钟 = 执行进程已死（容器重启等），判失败
        if ((job.status === 'pending' || job.status === 'running') &&
            Date.now() - job.createdAt.getTime() > 15 * 60 * 1000) {
            await prisma.analyzeJob.update({
                where: { id },
                data: { status: 'failed', error: 'AI_TIMEOUT_ERROR', completedAt: new Date() },
            });
            job.status = 'failed';
            job.error = 'AI_TIMEOUT_ERROR';
            logger.warn({ jobId: id }, 'Stale analyze job marked failed');
        }

        const { images, mimeType } = JSON.parse(job.pagesJson) as { images: string[]; mimeType?: string };
        return NextResponse.json({
            id: job.id,
            status: job.status,
            mode: job.mode,
            error: job.error,
            pageCount: images.length,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            consumedAt: job.consumedAt,
            questions: job.resultJson ? JSON.parse(job.resultJson) : null,
            // 库存裸 base64，给前端时重新包成 dataURL
            ...(includePages ? { pages: images.map((b) => `data:${mimeType || 'image/jpeg'};base64,${b}`) } : {}),
        });
    } catch (error) {
        logger.error({ error }, 'Error fetching analyze job');
        return internalError("Failed to fetch analyze job");
    }
}

/** 标记结果已被前端取走（防止下次打开页面重复弹出） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

        const job = await prisma.analyzeJob.findUnique({ where: { id } });
        if (!job || job.userId !== user.id) {
            return notFound("Job not found");
        }

        await prisma.analyzeJob.update({
            where: { id },
            data: { consumedAt: new Date() },
        });
        return NextResponse.json({ ok: true });
    } catch (error) {
        logger.error({ error }, 'Error consuming analyze job');
        return internalError("Failed to consume analyze job");
    }
}
