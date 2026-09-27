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
    // 剥掉 dataURL 前缀，统一存裸 base64（provider 会自己补前缀）
    let mimeType = params.mimeType || "image/jpeg";
    const images = params.images.map((img) => {
        const m = img.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
            mimeType = m[1];
            return m[2];
        }
        return img;
    });

    const job = await prisma.analyzeJob.create({
        data: {
            userId: params.userId,
            status: "pending",
            mode: "grade",
            language: params.language || "zh",
            subjectId: params.subjectId || null,
            pagesJson: JSON.stringify({ images, mimeType }),
        },
    });

    void runAnalyzeJob(job.id).catch((err) => {
        logger.error({ err, jobId: job.id }, 'Unhandled analyze job error');
    });

    return job;
}

export async function runAnalyzeJob(jobId: string): Promise<void> {
    const job = await prisma.analyzeJob.findUnique({ where: { id: jobId } });
    // done 不重跑；pending/running 都允许（running 可能是进程重启后的尸体任务，需要复活）
    if (!job || job.status === "done") return;

    await prisma.analyzeJob.update({
        where: { id: jobId },
        data: { status: "running" },
    });

    try {
        const { images, mimeType } = JSON.parse(job.pagesJson) as { images: string[]; mimeType: string };
        const { userGrade, userGradeSemester, subjectChinese } = await resolveAnalyzeContext(job.userId, job.subjectId);

        const aiService = getAIServiceForMultiAnalyze();

        // 滑动窗口分批：每批 2 页、步长 1 页（[1,2]→[2,3]→[3,4]…）
        // 任意相邻两页都会同批出现一次，跨页题必有一个批能看到完整版；
        // 批间重复识别的题靠题号去重（保留更完整版本）。
        // 不用单请求塞全部页：实测 7 页一次调用 15 分钟超时失败。
        const WINDOW = 2;
        const allQuestions: Array<Record<string, unknown>> = [];
        for (let start = 0; start < images.length; start += 1) {
            const batch = images.slice(start, start + WINDOW);
            // 最后一批若只剩 1 页且已被上一批覆盖（作为上一批的第 2 页），跳过
            if (batch.length === 1 && start > 0) break;
            const batchInput = batch.length > 1 ? batch : batch[0];
            const questions = await aiService.gradeExamMulti(
                batchInput, mimeType, (job.language as 'zh' | 'en') || 'zh', userGrade, subjectChinese, userGradeSemester
            );
            // AI 返回的 page 是批内页码（1/2），换算成全局页码
            for (const q of questions) {
                const localPage = (q as { page?: number }).page ?? 1;
                allQuestions.push({ ...(q as object), page: start + localPage } as Record<string, unknown>);
            }
            logger.info({ jobId, batchStart: start + 1, batchCount: questions.length }, 'Analyze batch done');
        }

        // 题号去重：跨批边界的跨页题可能被两批各识别一次，保留内容更完整的
        const seen = new Map<string, Record<string, unknown>>();
        for (const q of allQuestions) {
            const m = ((q.questionText as string) || '').match(/^\s*(\d+)\s*[.、．]/);
            const key = m ? m[1] : `__no_num_${allQuestions.indexOf(q)}`;
            const existing = seen.get(key);
            if (!existing || ((q.questionText as string) || '').length > ((existing.questionText as string) || '').length) {
                seen.set(key, q);
            }
        }
        const questions = Array.from(seen.values());

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

/** 服务启动时复活卡死的分析任务（容器重启会杀死进行中的执行，任务永远挂在 running） */
export async function recoverStuckAnalyzeJobs(): Promise<void> {
    try {
        const stuck = await prisma.analyzeJob.findMany({
            where: { status: { in: ["pending", "running"] } },
            select: { id: true },
        });
        if (stuck.length === 0) return;
        logger.warn({ count: stuck.length, ids: stuck.map((j) => j.id) }, 'Recovering stuck analyze jobs');
        for (const j of stuck) {
            void runAnalyzeJob(j.id).catch((err) =>
                logger.error({ err, jobId: j.id }, 'Recovered job failed to start')
            );
        }
    } catch (error) {
        logger.error({ error }, 'Failed to recover stuck analyze jobs');
    }
}
