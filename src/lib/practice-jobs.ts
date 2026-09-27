import { prisma } from "@/lib/prisma";
import { getAIService } from "@/lib/ai";
import type { DifficultyLevel } from "@/lib/ai/types";
import { createLogger } from "@/lib/logger";

const logger = createLogger('practice-jobs');

const VALID_SUBJECTS = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"] as const;

/**
 * 创建举一反三出题任务，并在后台异步执行（fire-and-forget）。
 * 适用于长驻 Node 进程（standalone server），请求返回后任务继续执行。
 */
export async function createPracticeJob(params: {
    errorItemId: string;
    userId: string;
    difficulty?: string;
    language?: string;
}) {
    const job = await prisma.practiceJob.create({
        data: {
            errorItemId: params.errorItemId,
            userId: params.userId,
            difficulty: params.difficulty || "medium",
            language: params.language || "zh",
            status: "pending",
        },
    });

    void runPracticeJob(job.id).catch((err) => {
        logger.error({ err, jobId: job.id }, 'Unhandled practice job error');
    });

    return job;
}

export async function runPracticeJob(jobId: string): Promise<void> {
    const job = await prisma.practiceJob.findUnique({ where: { id: jobId } });
    if (!job || job.status === "done") return;

    await prisma.practiceJob.update({
        where: { id: jobId },
        data: { status: "running" },
    });

    try {
        const errorItem = await prisma.errorItem.findUnique({
            where: { id: job.errorItemId },
            include: { subject: true, tags: true },
        });
        if (!errorItem) throw new Error("ErrorItem not found");

        let tags: string[] = [];
        try {
            tags = JSON.parse(errorItem.knowledgePoints || "[]");
        } catch {
            tags = [];
        }
        if (tags.length === 0 && errorItem.tags?.length) {
            tags = errorItem.tags.map((t) => t.name);
        }

        const aiService = getAIService();
        const similarQuestion = await aiService.generateSimilarQuestion(
            errorItem.questionText || "",
            tags,
            (job.language as 'zh' | 'en') || 'zh',
            (job.difficulty as DifficultyLevel) || 'medium',
            errorItem.gradeSemester
        );

        const subjectName = errorItem.subject?.name || "其他";
        (similarQuestion as Record<string, unknown>).subject =
            (VALID_SUBJECTS as readonly string[]).includes(subjectName) ? subjectName : "其他";

        await prisma.practiceJob.update({
            where: { id: jobId },
            data: {
                status: "done",
                resultJson: JSON.stringify(similarQuestion),
                completedAt: new Date(),
            },
        });
        logger.info({ jobId, errorItemId: job.errorItemId }, 'Practice job completed');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error, jobId }, 'Practice job failed');
        await prisma.practiceJob.update({
            where: { id: jobId },
            data: { status: "failed", error: message, completedAt: new Date() },
        }).catch(() => { /* ignore secondary failure */ });
    }
}
