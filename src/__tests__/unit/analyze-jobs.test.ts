/**
 * 试卷扫描后台任务（AnalyzeJob）测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockPrismaAnalyzeJob: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
    },
    mockPrismaUser: { findUnique: vi.fn() },
    mockPrismaSubject: { findUnique: vi.fn() },
    mockAIService: { gradeExamMulti: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        analyzeJob: mocks.mockPrismaAnalyzeJob,
        user: mocks.mockPrismaUser,
        subject: mocks.mockPrismaSubject,
    },
}));

vi.mock('@/lib/ai', () => ({
    getAIServiceForMultiAnalyze: vi.fn(() => mocks.mockAIService),
}));

import { createAnalyzeJob, runAnalyzeJob } from '@/lib/analyze-jobs';

describe('analyze-jobs（试卷扫描后台任务）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockPrismaAnalyzeJob.create.mockResolvedValue({ id: 'job-1' });
        mocks.mockPrismaAnalyzeJob.update.mockResolvedValue({});
        mocks.mockPrismaUser.findUnique.mockResolvedValue({ educationStage: 'junior_high', enrollmentYear: 2024 });
        mocks.mockPrismaSubject.findUnique.mockResolvedValue(null);
        // createAnalyzeJob 会 fire-and-forget 调 runAnalyzeJob，给默认桩
        mocks.mockPrismaAnalyzeJob.findUnique.mockResolvedValue(null);
    });

    it('创建任务：页图与参数落库，状态 pending', async () => {
        const job = await createAnalyzeJob({
            userId: 'user-1',
            images: ['AAAA', 'BBBB'],
            language: 'zh',
            subjectId: 'sub-1',
        });

        expect(job.id).toBe('job-1');
        expect(mocks.mockPrismaAnalyzeJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                status: 'pending',
                mode: 'grade',
                subjectId: 'sub-1',
                pagesJson: JSON.stringify({ images: ['AAAA', 'BBBB'], mimeType: 'image/jpeg' }),
            }),
        });
    });

    it('创建时应剥掉 dataURL 前缀存裸 base64', async () => {
        await createAnalyzeJob({
            userId: 'user-1',
            images: ['data:image/png;base64,AAAA', 'BBBB'],
        });

        expect(mocks.mockPrismaAnalyzeJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                pagesJson: JSON.stringify({ images: ['AAAA', 'BBBB'], mimeType: 'image/png' }),
            }),
        });
    });

    it('执行成功：调用批改分析并存储结果，状态 done', async () => {
        mocks.mockPrismaAnalyzeJob.findUnique.mockResolvedValue({
            id: 'job-1', userId: 'user-1', status: 'pending', language: 'zh', subjectId: null,
            pagesJson: JSON.stringify({ images: ['AAAA'], mimeType: 'image/jpeg' }),
        });
        mocks.mockAIService.gradeExamMulti.mockResolvedValue([
            { questionText: '题1', answerText: '答1', analysis: '析1', subject: '数学', knowledgePoints: [], isCorrect: false, page: 1 },
        ]);

        await runAnalyzeJob('job-1');

        expect(mocks.mockAIService.gradeExamMulti).toHaveBeenCalled();
        expect(mocks.mockPrismaAnalyzeJob.update).toHaveBeenLastCalledWith({
            where: { id: 'job-1' },
            data: expect.objectContaining({ status: 'done' }),
        });
    });

    it('执行失败：状态 failed 并记录错误', async () => {
        mocks.mockPrismaAnalyzeJob.findUnique.mockResolvedValue({
            id: 'job-1', userId: 'user-1', status: 'pending', language: 'zh', subjectId: null,
            pagesJson: JSON.stringify({ images: ['AAAA'], mimeType: 'image/jpeg' }),
        });
        mocks.mockAIService.gradeExamMulti.mockRejectedValue(new Error('AI_TIMEOUT_ERROR'));

        await runAnalyzeJob('job-1');

        expect(mocks.mockPrismaAnalyzeJob.update).toHaveBeenLastCalledWith({
            where: { id: 'job-1' },
            data: expect.objectContaining({ status: 'failed', error: 'AI_TIMEOUT_ERROR' }),
        });
    });

    it('已完成的任务不重复执行', async () => {
        mocks.mockPrismaAnalyzeJob.findUnique.mockResolvedValue({ id: 'job-1', status: 'done' });

        await runAnalyzeJob('job-1');

        expect(mocks.mockAIService.gradeExamMulti).not.toHaveBeenCalled();
    });
});
