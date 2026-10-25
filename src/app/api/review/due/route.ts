import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getDueErrorItemIds } from "@/lib/review-plan";

const logger = createLogger('api:review:due');

/** 今日待复习错题（简化艾宾浩斯，issue #88） */
export async function GET() {
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

        const ids = await getDueErrorItemIds(user.id);
        return NextResponse.json({ ids, count: ids.length });
    } catch (error) {
        logger.error({ error }, 'Error fetching due items');
        return internalError("Failed to fetch due items");
    }
}
