import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { getAIService } from "@/lib/ai";
import { unauthorized, internalError, notFound, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:reanalyze');

/**
 * 手动触发 AI 重新解析（issue #66）：
 * 基于原题图片重新识别题目/答案/解析/知识点，覆盖对应字段。
 * 仅支持有原题图片的错题。
 */
export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
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

        const item = await prisma.errorItem.findUnique({
            where: { id },
            include: { subject: true },
        });
        if (!item) {
            return notFound("Item not found");
        }
        if (item.userId !== user.id) {
            return NextResponse.json({ message: "Not authorized" }, { status: 403 });
        }
        if (!item.originalImageUrl) {
            return badRequest("NO_IMAGE");
        }

        // originalImageUrl 为 data URL（base64 存库）
        let imageBase64 = item.originalImageUrl;
        let mimeType = "image/jpeg";
        if (imageBase64.startsWith('data:')) {
            const matches = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
                mimeType = matches[1];
                imageBase64 = matches[2];
            }
        }

        const aiService = getAIService();
        const parsed = await aiService.analyzeImage(
            imageBase64,
            mimeType,
            'zh',
            null,
            item.subject?.name || null,
            item.gradeSemester
        );

        const updated = await prisma.errorItem.update({
            where: { id },
            data: {
                questionText: parsed.questionText,
                answerText: parsed.answerText,
                analysis: parsed.analysis,
                wrongAnswerText: parsed.wrongAnswerText || item.wrongAnswerText,
                mistakeAnalysis: parsed.mistakeAnalysis || item.mistakeAnalysis,
                mistakeStatus: parsed.mistakeStatus || item.mistakeStatus,
                knowledgePoints: JSON.stringify(parsed.knowledgePoints || []),
            },
            include: { subject: true, tags: true },
        });

        logger.info({ errorItemId: id }, 'Item reanalyzed');
        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error reanalyzing item');
        const errorMessage = error instanceof Error ? error.message : "Failed to reanalyze item";
        return internalError(errorMessage);
    }
}
