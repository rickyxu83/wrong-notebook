/**
 * /api/practice API 集成测试
 * 测试举一反三功能（生成类似题目和记录练习结果）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to ensure mocks are initialized before module imports
const mocks = vi.hoisted(() => ({
    mockPrismaErrorItem: {
        findUnique: vi.fn(),
    },
    mockPrismaPracticeJob: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
    },
    mockCreatePracticeJob: vi.fn(),
    mockPrismaPracticeRecord: {
        create: vi.fn(),
    },
    mockAIService: {
        generateSimilarQuestion: vi.fn(),
    },
    mockSession: {
        user: {
            id: 'user-123',
            email: 'user@example.com',
            name: 'Test User',
        },
        expires: '2025-12-31',
    },
}));

// Mock Prisma client
vi.mock('@/lib/prisma', () => ({
    prisma: {
        errorItem: mocks.mockPrismaErrorItem,
        practiceJob: mocks.mockPrismaPracticeJob,
        practiceRecord: mocks.mockPrismaPracticeRecord,
    },
}));

// 仅打桩 createPracticeJob（路由用），runPracticeJob 保持真实实现以便测试
vi.mock('@/lib/practice-jobs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/practice-jobs')>();
    return {
        ...actual,
        createPracticeJob: mocks.mockCreatePracticeJob,
    };
});

// Mock AI service
vi.mock('@/lib/ai', () => ({
    getAIService: vi.fn(() => mocks.mockAIService),
}));

// Mock next-auth
vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

// Import after mocks
import { POST as GENERATE_POST } from '@/app/api/practice/generate/route';
import { POST as RECORD_POST } from '@/app/api/practice/record/route';
import { runPracticeJob } from '@/lib/practice-jobs';
import { getServerSession } from 'next-auth';

describe('/api/practice', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue(mocks.mockSession);
        // prisma update/create 默认返回成功
        mocks.mockPrismaPracticeJob.update.mockResolvedValue({});
        mocks.mockPrismaPracticeJob.create.mockResolvedValue({ id: 'job-1' });
    });

    describe('POST /api/practice/generate (异步创建出题任务)', () => {
        it('应该创建任务并返回 202 和 jobId', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
            });
            mocks.mockCreatePracticeJob.mockResolvedValue({ id: 'job-1', status: 'pending' });

            const request = new Request('http://localhost/api/practice/generate', {
                method: 'POST',
                body: JSON.stringify({
                    errorItemId: 'error-item-1',
                    language: 'zh',
                    difficulty: 'hard',
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await GENERATE_POST(request);
            const data = await response.json();

            expect(response.status).toBe(202);
            expect(data.jobId).toBe('job-1');
            expect(data.status).toBe('pending');
            expect(mocks.mockCreatePracticeJob).toHaveBeenCalledWith({
                errorItemId: 'error-item-1',
                userId: 'user-123',
                difficulty: 'hard',
                language: 'zh',
            });
        });

        it('应该返回 404 当错题不存在', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(null);

            const request = new Request('http://localhost/api/practice/generate', {
                method: 'POST',
                body: JSON.stringify({
                    errorItemId: 'not-exist',
                    language: 'zh',
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await GENERATE_POST(request);
            const data = await response.json();

            expect(response.status).toBe(404);
            expect(data.message).toBe('Item not found');
        });

        it('应该返回 401 当未登录', async () => {
            vi.mocked(getServerSession).mockResolvedValueOnce(null);

            const request = new Request('http://localhost/api/practice/generate', {
                method: 'POST',
                body: JSON.stringify({ errorItemId: 'error-item-1' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await GENERATE_POST(request);
            expect(response.status).toBe(401);
        });
    });

    describe('runPracticeJob (后台出题执行器)', () => {
        const baseJob = {
            id: 'job-1',
            errorItemId: 'error-item-1',
            userId: 'user-123',
            difficulty: 'medium',
            language: 'zh',
            status: 'pending',
        };
        const mockErrorItemFull = {
            id: 'error-item-1',
            questionText: '求解 x + 2 = 5',
            knowledgePoints: '["一元一次方程", "移项"]',
            gradeSemester: null,
            subject: { id: 'math', name: '数学' },
            tags: [],
        };

        it('成功后写入 done 和出题结果，并从数据库注入学科', async () => {
            mocks.mockPrismaPracticeJob.findUnique.mockResolvedValue(baseJob);
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(mockErrorItemFull);
            mocks.mockAIService.generateSimilarQuestion.mockResolvedValue({
                questionText: '求解 2x - 3 = 7',
                answerText: 'x = 5',
                analysis: '移项得 2x = 10, x = 5',
                knowledgePoints: ['一元一次方程'],
            });

            await runPracticeJob('job-1');

            expect(mocks.mockAIService.generateSimilarQuestion).toHaveBeenCalledWith(
                '求解 x + 2 = 5',
                ['一元一次方程', '移项'],
                'zh',
                'medium',
                null
            );
            const lastUpdate = mocks.mockPrismaPracticeJob.update.mock.calls.at(-1)[0];
            expect(lastUpdate.data.status).toBe('done');
            const result = JSON.parse(lastUpdate.data.resultJson);
            expect(result.questionText).toBe('求解 2x - 3 = 7');
            expect(result.subject).toBe('数学');
        });

        it('未知学科应回退为"其他"', async () => {
            mocks.mockPrismaPracticeJob.findUnique.mockResolvedValue(baseJob);
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                ...mockErrorItemFull,
                subject: { id: 'x', name: '未知学科' },
            });
            mocks.mockAIService.generateSimilarQuestion.mockResolvedValue({
                questionText: '题目', answerText: '答案', analysis: '解析', knowledgePoints: [],
            });

            await runPracticeJob('job-1');

            const lastUpdate = mocks.mockPrismaPracticeJob.update.mock.calls.at(-1)[0];
            expect(JSON.parse(lastUpdate.data.resultJson).subject).toBe('其他');
        });

        it('knowledgePoints 非法 JSON 时应使用空数组', async () => {
            mocks.mockPrismaPracticeJob.findUnique.mockResolvedValue(baseJob);
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                ...mockErrorItemFull,
                knowledgePoints: 'invalid json{',
            });
            mocks.mockAIService.generateSimilarQuestion.mockResolvedValue({
                questionText: '题目', answerText: '答案', analysis: '解析', knowledgePoints: [],
            });

            await runPracticeJob('job-1');

            expect(mocks.mockAIService.generateSimilarQuestion).toHaveBeenCalledWith(
                expect.any(String), [], 'zh', 'medium', null
            );
        });

        it('knowledgePoints 为空时回退到 tags 关联', async () => {
            mocks.mockPrismaPracticeJob.findUnique.mockResolvedValue(baseJob);
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                ...mockErrorItemFull,
                knowledgePoints: null,
                tags: [{ name: '勾股定理' }],
            });
            mocks.mockAIService.generateSimilarQuestion.mockResolvedValue({
                questionText: '题目', answerText: '答案', analysis: '解析', knowledgePoints: [],
            });

            await runPracticeJob('job-1');

            expect(mocks.mockAIService.generateSimilarQuestion).toHaveBeenCalledWith(
                expect.any(String), ['勾股定理'], 'zh', 'medium', null
            );
        });

        it('AI 服务错误时应标记任务 failed', async () => {
            mocks.mockPrismaPracticeJob.findUnique.mockResolvedValue(baseJob);
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(mockErrorItemFull);
            mocks.mockAIService.generateSimilarQuestion.mockRejectedValue(new Error('AI service unavailable'));

            await runPracticeJob('job-1');

            const lastUpdate = mocks.mockPrismaPracticeJob.update.mock.calls.at(-1)[0];
            expect(lastUpdate.data.status).toBe('failed');
            expect(lastUpdate.data.error).toBe('AI service unavailable');
        });
    });

    describe('POST /api/practice/record (记录练习结果)', () => {
        it('应该成功记录正确的练习结果', async () => {
            const createdRecord = {
                id: 'record-1',
                userId: 'user-123',
                subject: '数学',
                difficulty: 'medium',
                isCorrect: true,
                createdAt: new Date(),
            };
            mocks.mockPrismaPracticeRecord.create.mockResolvedValue(createdRecord);

            const request = new Request('http://localhost/api/practice/record', {
                method: 'POST',
                body: JSON.stringify({
                    subject: '数学',
                    difficulty: 'medium',
                    isCorrect: true,
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await RECORD_POST(request);
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.subject).toBe('数学');
            expect(data.isCorrect).toBe(true);
        });

        it('应该成功记录错误的练习结果', async () => {
            const createdRecord = {
                id: 'record-2',
                userId: 'user-123',
                subject: '英语',
                difficulty: 'hard',
                isCorrect: false,
                createdAt: new Date(),
            };
            mocks.mockPrismaPracticeRecord.create.mockResolvedValue(createdRecord);

            const request = new Request('http://localhost/api/practice/record', {
                method: 'POST',
                body: JSON.stringify({
                    subject: '英语',
                    difficulty: 'hard',
                    isCorrect: false,
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await RECORD_POST(request);
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.isCorrect).toBe(false);
        });

        it('应该记录不同学科的练习结果', async () => {
            const subjects = ['数学', '物理', '化学', '英语', '语文'];

            for (const subject of subjects) {
                mocks.mockPrismaPracticeRecord.create.mockResolvedValue({
                    id: `record-${subject}`,
                    userId: 'user-123',
                    subject,
                    difficulty: 'medium',
                    isCorrect: true,
                });

                const request = new Request('http://localhost/api/practice/record', {
                    method: 'POST',
                    body: JSON.stringify({
                        subject,
                        difficulty: 'medium',
                        isCorrect: true,
                    }),
                    headers: { 'Content-Type': 'application/json' },
                });

                const response = await RECORD_POST(request);
                expect(response.status).toBe(200);
            }
        });

        it('应该拒绝未登录用户', async () => {
            vi.mocked(getServerSession).mockResolvedValue(null);

            const request = new Request('http://localhost/api/practice/record', {
                method: 'POST',
                body: JSON.stringify({
                    subject: '数学',
                    difficulty: 'medium',
                    isCorrect: true,
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await RECORD_POST(request);
            const data = await response.json();

            expect(response.status).toBe(401);
            expect(data.message).toBe('Unauthorized');
        });

        it('应该拒绝 session 中没有 user 的请求', async () => {
            vi.mocked(getServerSession).mockResolvedValue({
                user: undefined,
                expires: '2025-12-31',
            } as any);

            const request = new Request('http://localhost/api/practice/record', {
                method: 'POST',
                body: JSON.stringify({
                    subject: '数学',
                    difficulty: 'medium',
                    isCorrect: true,
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await RECORD_POST(request);
            const data = await response.json();

            expect(response.status).toBe(401);
            expect(data.message).toBe('Unauthorized');
        });

        it('应该处理数据库错误', async () => {
            mocks.mockPrismaPracticeRecord.create.mockRejectedValue(
                new Error('Database connection failed')
            );

            const request = new Request('http://localhost/api/practice/record', {
                method: 'POST',
                body: JSON.stringify({
                    subject: '数学',
                    difficulty: 'medium',
                    isCorrect: true,
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await RECORD_POST(request);
            const data = await response.json();

            expect(response.status).toBe(500);
            expect(data.message).toBe('Failed to save record');
        });
    });
});
