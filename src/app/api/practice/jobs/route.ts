import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:practice:jobs');

/** 查询某错题最近的出题任务（用于页面恢复进行中的任务 / 加载已出好的题） */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    try {
        const { searchParams } = new URL(req.url);
        const errorItemId = searchParams.get("errorItemId");
        if (!errorItemId) {
            return NextResponse.json({ message: "errorItemId required" }, { status: 400 });
        }

        const jobs = await prisma.practiceJob.findMany({
            where: { errorItemId },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: {
                id: true,
                status: true,
                difficulty: true,
                error: true,
                createdAt: true,
                completedAt: true,
            },
        });

        return NextResponse.json({ jobs });
    } catch (error) {
        logger.error({ error }, 'Error listing practice jobs');
        return internalError("Failed to list practice jobs");
    }
}
