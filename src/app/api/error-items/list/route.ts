import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MIN_PAGE_SIZE } from "@/lib/constants/pagination";
import { buildErrorItemWhere } from "@/lib/error-item-filter";

const logger = createLogger('api:error-items:list');

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    const { searchParams } = new URL(req.url);

    // 分页参数
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10)));

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }

        if (!user) {
            return unauthorized("Authentication required");
        }

        // 筛选条件统一由 buildErrorItemWhere 构建（批量出卷等功能复用同一逻辑）
        const whereClause = await buildErrorItemWhere({
            subjectId: searchParams.get("subjectId"),
            query: searchParams.get("query"),
            mastery: searchParams.get("mastery"),
            timeRange: searchParams.get("timeRange"),
            chapter: searchParams.get("chapter"),
            tag: searchParams.get("tag"),
            gradeSemester: searchParams.get("gradeSemester"),
            paperLevel: searchParams.get("paperLevel"),
            dueOnly: searchParams.get("dueOnly") === "1",
        }, user.id);

        // 打印预览等场景需要原图时显式声明，默认不返回 base64 原图/ocr 文本（列表提速）
        const includeImage = searchParams.get("includeImage") === "1";

        // 获取总数
        const total = await prisma.errorItem.count({
            where: whereClause,
        });

        // 分页查询
        // 默认不返回 originalImageUrl / ocrText（base64 大字段），显著减小列表载荷
        const baseSelect = {
            id: true,
            userId: true,
            subjectId: true,
            questionText: true,
            answerText: true,
            analysis: true,
            wrongAnswerText: true,
            mistakeAnalysis: true,
            mistakeStatus: true,
            knowledgePoints: true,
            source: true,
            errorType: true,
            userNotes: true,
            masteryLevel: true,
            gradeSemester: true,
            paperLevel: true,
            createdAt: true,
            updatedAt: true,
            subject: true,
            tags: true,
        };
        const queryArgs: Prisma.ErrorItemFindManyArgs = {
            where: whereClause,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
            ...(includeImage
                ? { include: { subject: true, tags: true } }
                : { select: baseSelect }),
        };
        const errorItems = await prisma.errorItem.findMany(queryArgs);

        const totalPages = Math.ceil(total / pageSize);

        return NextResponse.json({
            items: errorItems,
            total,
            page,
            pageSize,
            totalPages,
        });
    } catch (error) {
        logger.error({ error }, 'Error fetching items');
        return internalError("Failed to fetch error items");
    }
}
