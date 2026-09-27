import { prisma } from "@/lib/prisma";
import { getAIServiceForMultiAnalyze } from "@/lib/ai";
import { calculateGrade } from "@/lib/grade-calculator";
import { calculateGradeNumber, inferSubjectFromName } from "@/lib/knowledge-tags";
import { createLogger } from "@/lib/logger";

const logger = createLogger('analyze-jobs');

const SUBJECT_NAME_MAPPING: Record<string, string> = {
    'math': '数学', 'physics': '物理', 'chemistry': '化学', 'biology': '生物',
    'english': '英语', 'chinese': '语文', 'history': '历史', 'geography': '地理', 'politics': '政治',
};

/** 解析 AI 调用所需的上下文（年级、学科）——analyze 路由与后台任务共用 */
export async function resolveAnalyzeContext(userId: string, subjectId?: string | null) {
    let userGrade: 7 | 8 | 9 | 10 | 11 | 12 | null = null;
    let userGradeSemester: string | null = null;
    let subjectChinese: string | null = null;

    try {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { educationStage: true, enrollmentYear: true },
        });
        if (user) {
            userGrade = calculateGradeNumber(user.educationStage, user.enrollmentYear);
            if (user.educationStage && user.enrollmentYear) {
                userGradeSemester = calculateGrade(user.educationStage, user.enrollmentYear, new Date(), 'zh');
            }
        }
        if (subjectId) {
            const subject = await prisma.subject.findUnique({
                where: { id: subjectId },
                select: { name: true },
            });
            if (subject) {
                const key = inferSubjectFromName(subject.name);
                subjectChinese = key ? SUBJECT_NAME_MAPPING[key] : null;
            }
        }
    } catch (error) {
        logger.error({ error }, 'Error resolving analyze context');
    }

    return { userGrade, userGradeSemester, subjectChinese };
}

/**
 * 创建试卷扫描分析任务并后台执行（fire-and-forget）。
 * 页图存在任务里，浏览器黑屏/切后台/断网都不影响服务端跑完。
 */
export async function createAnalyzeJob(params: {
    userId: string;
    images: string[];
    mimeType?: string;
    language?: string;
    subjectId?: string | null;
}) {
    const job = await prisma.analyzeJob.create({
        data: {
            userId: params.userId,
            status: "pending",
            mode: "grade",
            language: params.language || "zh",
            subjectId: params.subjectId || null,
            pagesJson: JSON.stringify({
                images: params.images,
                mimeType: params.mimeType || "image/jpeg",
            }),
        },
    });

    void runAnalyzeJob(job.id).catch((err) => {
        logger.error({ err, jobId: job.id }, 'Unhandled analyze job error');
    });

    return job;
}

export async function runAnalyzeJob(jobId: string): Promise<void> {
    const job = await prisma.analyzeJob.findUnique({ where: { id: jobId } });
    if (!job || job.status === "done") return;

    await prisma.analyzeJob.update({
        where: { id: jobId },
        data: { status: "running" },
    });

    try {
        const { images, mimeType } = JSON.parse(job.pagesJson) as { images: string[]; mimeType: string };
        const { userGrade, userGradeSemester, subjectChinese } = await resolveAnalyzeContext(job.userId, job.subjectId);

        const aiService = getAIServiceForMultiAnalyze();
        const imageInput = images.length > 1 ? images : images[0];
        const questions = await aiService.gradeExamMulti(
            imageInput, mimeType, (job.language as 'zh' | 'en') || 'zh', userGrade, subjectChinese, userGradeSemester
        );

        await prisma.analyzeJob.update({
            where: { id: jobId },
            data: {
                status: "done",
                resultJson: JSON.stringify(questions),
                completedAt: new Date(),
            },
        });
        logger.info({ jobId, count: questions.length, pages: images.length }, 'Analyze job completed');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error, jobId }, 'Analyze job failed');
        await prisma.analyzeJob.update({
            where: { id: jobId },
            data: { status: "failed", error: message, completedAt: new Date() },
        }).catch(() => { /* ignore secondary failure */ });
    }
}
