import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { completeReview } from "@/lib/review-plan";

const logger = createLogger('api:review:complete');

/** 完成一次复习：结清当前排期并按结果排下一次（issue #88） */
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

        const { errorItemId, isCorrect } = await req.json();
        if (!errorItemId || typeof isCorrect !== "boolean") {
            return badRequest("errorItemId and isCorrect required");
        }

        const item = await prisma.errorItem.findUnique({
            where: { id: errorItemId },
            select: { userId: true },
        });
        if (!item) {
            return notFound("Item not found");
        }
        if (item.userId !== user.id) {
            return NextResponse.json({ message: "Not authorized" }, { status: 403 });
        }

        const result = await completeReview(errorItemId, isCorrect);
        logger.info({ errorItemId, isCorrect, stage: result.stage }, 'Review completed');
        return NextResponse.json(result);
    } catch (error) {
        logger.error({ error }, 'Error completing review');
        return internalError("Failed to complete review");
    }
}
