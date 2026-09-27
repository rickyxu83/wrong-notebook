/**
 * /api/practice/papers 批量出卷测试
 * 覆盖：创建试卷（选中/筛选两种模式）、归属校验、runPracticePaper 串行执行与状态汇总
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockPrismaUser: { findUnique: vi.fn() },
    mockPrismaErrorItem: { findMany: vi.fn(), findUnique: vi.fn() },
    mockPrismaPracticePaper: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    mockPrismaPracticeJob: {
        createMany: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        groupBy: vi.fn(),
    },
    mockBuildErrorItemWhere: vi.fn(),
    mockAIService: { generateSimilarQuestion: vi.fn() },
    mockSession: {
        user: { id: 'user-123', email: 'user@example.com', name: 'Test User' },
        expires: '2025-12-31',
    },
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.mockPrismaUser,
        errorItem: mocks.mockPrismaErrorItem,
        practicePaper: mocks.mockPrismaPracticePaper,
        practiceJob: mocks.mockPrismaPracticeJob,
    },
}));

vi.mock('@/lib/error-item-filter', () => ({
    buildErrorItemWhere: mocks.mockBuildErrorItemWhere,
}));

vi.mock('@/lib/ai', () => ({
    getAIService: vi.fn(() => mocks.mockAIService),
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { POST as PAPERS_POST } from '@/app/api/practice/papers/route';
import { runPracticePaper, createPracticePaper } from '@/lib/practice-jobs';
import { getServerSession } from 'next-auth';

function postRequest(body: unknown) {
    return new Request('http://localhost/api/practice/papers', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('/api/practice/papers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue(mocks.mockSession);
        mocks.mockPrismaUser.findUnique.mockResolvedValue({ id: 'user-123' });
        mocks.mockPrismaPracticePaper.create.mockResolvedValue({ id: 'paper-1' });
        mocks.mockPrismaPracticePaper.update.mockResolvedValue({});
        mocks.mockPrismaPracticeJob.createMany.mockResolvedValue({ count: 2 });
        mocks.mockPrismaPracticeJob.update.mockResolvedValue({});
        // createPracticePaper 会 fire-and-forget 调 runPracticePaper，给它安全的默认桩
        mocks.mockPrismaPracticeJob.findMany.mockResolvedValue([]);
        mocks.mockPrismaPracticeJob.groupBy.mockResolvedValue([]);
    });

    describe('POST 选中模式', () => {
        it('应该过滤掉不属于当前用户的错题，保持选择顺序', async () => {
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([
                { id: 'item-a' }, { id: 'item-b' },
            ]);

            const response = await PAPERS_POST(postRequest({
                errorItemIds: ['item-b', 'item-x-foreign', 'item-a'],
                difficulty: 'hard',
            }));
            const data = await response.json();

            expect(response.status).toBe(202);
            expect(data.paperId).toBe('paper-1');
            expect(data.count).toBe(2);
            // createMany 按用户选择顺序（item-b 在前）落库
            expect(mocks.mockPrismaPracticeJob.createMany).toHaveBeenCalledWith({
                data: [
                    expect.objectContaining({ errorItemId: 'item-b', orderIndex: 0, paperId: 'paper-1', difficulty: 'hard' }),
                    expect.objectContaining({ errorItemId: 'item-a', orderIndex: 1, paperId: 'paper-1', difficulty: 'hard' }),
                ],
            });
        });

        it('选中的错题全部不属于当前用户时应返回 400', async () => {
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

            const response = await PAPERS_POST(postRequest({ errorItemIds: ['foreign-1'] }));
            expect(response.status).toBe(400);
        });
    });

    describe('POST 筛选模式', () => {
        it('应该用筛选器查错题并创建试卷', async () => {
            mocks.mockBuildErrorItemWhere.mockResolvedValue({ userId: 'user-123', masteryLevel: 0 });
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([{ id: 'item-1' }, { id: 'item-2' }]);

            const response = await PAPERS_POST(postRequest({
                filter: { subjectId: 'sub-1', mastery: '0', dueOnly: true },
                difficulty: 'easy',
            }));
            const data = await response.json();

            expect(response.status).toBe(202);
            expect(data.count).toBe(2);
            expect(mocks.mockBuildErrorItemWhere).toHaveBeenCalledWith(
                expect.objectContaining({ subjectId: 'sub-1', mastery: '0', dueOnly: true }),
                'user-123',
            );
        });

        it('筛选结果为空时应返回 400', async () => {
            mocks.mockBuildErrorItemWhere.mockResolvedValue({ userId: 'user-123' });
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

            const response = await PAPERS_POST(postRequest({ filter: { subjectId: 'sub-1' } }));
            expect(response.status).toBe(400);
        });
    });

    it('两种模式都没有时应返回 400', async () => {
        const response = await PAPERS_POST(postRequest({ difficulty: 'medium' }));
        expect(response.status).toBe(400);
    });

    it('未登录应返回 401', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null);
        const response = await PAPERS_POST(postRequest({ errorItemIds: ['a'] }));
        expect(response.status).toBe(401);
    });
});

describe('runPracticePaper (出卷执行器)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockPrismaPracticeJob.update.mockResolvedValue({});
        mocks.mockPrismaPracticePaper.update.mockResolvedValue({});
        mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
            id: 'item-1',
            questionText: '题目',
            knowledgePoints: '["知识点"]',
            subject: { name: '数学' },
            tags: [],
        });
        mocks.mockAIService.generateSimilarQuestion.mockResolvedValue({
            questionText: '变式题', answerText: '答案', analysis: '解析',
        });
    });

    it('全部成功 → 试卷状态 done', async () => {
        mocks.mockPrismaPracticeJob.findMany.mockResolvedValue([{ id: 'job-1' }, { id: 'job-2' }]);
        // 每个 job 两次 findUnique：runPracticeJob 开头一次（状态检查）
        mocks.mockPrismaPracticeJob.findUnique.mockResolvedValue({ id: 'job-1', errorItemId: 'item-1', status: 'pending', difficulty: 'medium', language: 'zh' });
        mocks.mockPrismaPracticeJob.groupBy.mockResolvedValue([
            { status: 'done', _count: { _all: 2 } },
        ]);

        await runPracticePaper('paper-1');

        expect(mocks.mockAIService.generateSimilarQuestion).toHaveBeenCalledTimes(2);
        expect(mocks.mockPrismaPracticePaper.update).toHaveBeenCalledWith({
            where: { id: 'paper-1' },
            data: expect.objectContaining({ status: 'done' }),
        });
    });

    it('部分失败 → 试卷状态 partial', async () => {
        mocks.mockPrismaPracticeJob.findMany.mockResolvedValue([{ id: 'job-1' }, { id: 'job-2' }]);
        mocks.mockPrismaPracticeJob.findUnique.mockImplementation(({ where }: any) =>
            Promise.resolve({ id: where.id, errorItemId: 'item-1', status: 'pending', difficulty: 'medium', language: 'zh' }));
        // 第一题成功，第二题 AI 失败（runPracticeJob 内部容错，不中断整卷）
        mocks.mockAIService.generateSimilarQuestion
            .mockResolvedValueOnce({ questionText: '变式题', answerText: '答案', analysis: '解析' })
            .mockRejectedValueOnce(new Error('AI_CONNECTION_FAILED'));
        mocks.mockPrismaPracticeJob.groupBy.mockResolvedValue([
            { status: 'done', _count: { _all: 1 } },
            { status: 'failed', _count: { _all: 1 } },
        ]);

        await runPracticePaper('paper-1');

        expect(mocks.mockPrismaPracticePaper.update).toHaveBeenCalledWith({
            where: { id: 'paper-1' },
            data: expect.objectContaining({ status: 'partial' }),
        });
    });
});

describe('createPracticePaper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockPrismaPracticePaper.create.mockResolvedValue({ id: 'paper-1' });
        mocks.mockPrismaPracticeJob.createMany.mockResolvedValue({ count: 1 });
        mocks.mockPrismaPracticeJob.findMany.mockResolvedValue([]);
        mocks.mockPrismaPracticeJob.groupBy.mockResolvedValue([]);
        mocks.mockPrismaPracticePaper.update.mockResolvedValue({});
    });

    it('应该创建试卷并按顺序落库出题任务', async () => {
        const paper = await createPracticePaper({
            errorItemIds: ['a', 'b', 'c'],
            userId: 'user-123',
            difficulty: 'medium',
            language: 'zh',
        });

        expect(paper.id).toBe('paper-1');
        expect(mocks.mockPrismaPracticePaper.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ userId: 'user-123', status: 'running' }),
        });
        expect(mocks.mockPrismaPracticeJob.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({ errorItemId: 'a', orderIndex: 0 }),
                expect.objectContaining({ errorItemId: 'b', orderIndex: 1 }),
                expect.objectContaining({ errorItemId: 'c', orderIndex: 2 }),
            ],
        });
    });
});
