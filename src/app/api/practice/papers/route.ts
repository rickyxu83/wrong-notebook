import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { createPracticePaper } from "@/lib/practice-jobs";
import { buildErrorItemWhere, type ErrorItemFilterParams } from "@/lib/error-item-filter";

const logger = createLogger('api:practice:papers');

/** 单张试卷最大题数（防失控，也够覆盖一次考试规模的错题） */
const MAX_PAPER_ITEMS = 50;

const VALID_DIFFICULTIES = ["easy", "medium", "hard", "harder"];

/**
 * 创建举一反三批量试卷：每道错题各出一道变式题，后台串行执行。
 * 两种选题模式：
 * - errorItemIds: string[]  明确选中（多选模式）
 * - filter: 与列表 API 相同的筛选参数（"当前筛选全部"）
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
        const difficulty = VALID_DIFFICULTIES.includes(body.difficulty) ? body.difficulty : "medium";
        const language = body.language === "en" ? "en" : "zh";

        let ids: string[] = [];

        if (Array.isArray(body.errorItemIds) && body.errorItemIds.length > 0) {
            // 选中模式：校验归属，保持用户选择顺序
            const requested: string[] = body.errorItemIds.slice(0, MAX_PAPER_ITEMS);
            const owned = await prisma.errorItem.findMany({
                where: { id: { in: requested }, userId: user.id },
                select: { id: true },
            });
            const ownedSet = new Set(owned.map((i) => i.id));
            ids = requested.filter((id) => ownedSet.has(id));
        } else if (body.filter && typeof body.filter === "object") {
            // 筛选模式：复用列表 API 的 where 逻辑，按创建时间倒序取前 N 道
            const f = body.filter as ErrorItemFilterParams;
            const where = await buildErrorItemWhere({
                subjectId: f.subjectId ?? null,
                query: f.query ?? null,
                mastery: f.mastery ?? null,
                timeRange: f.timeRange ?? null,
                chapter: f.chapter ?? null,
                tag: f.tag ?? null,
                gradeSemester: f.gradeSemester ?? null,
                paperLevel: f.paperLevel ?? null,
                dueOnly: !!f.dueOnly,
            }, user.id);
            const items = await prisma.errorItem.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: MAX_PAPER_ITEMS,
                select: { id: true },
            });
            ids = items.map((i) => i.id);
        }

        if (ids.length === 0) {
            return badRequest("No error items selected");
        }

        const paper = await createPracticePaper({
            errorItemIds: ids,
            userId: user.id,
            difficulty,
            language,
        });

        logger.info({ paperId: paper.id, count: ids.length, difficulty }, 'Practice paper created');
        return NextResponse.json({ paperId: paper.id, count: ids.length }, { status: 202 });
    } catch (error) {
        logger.error({ error }, 'Error creating practice paper');
        return internalError("Failed to create practice paper");
    }
}
