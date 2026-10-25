import { describe, expect, it } from 'vitest';
import { generateSimilarQuestionPrompt } from '@/lib/ai/prompts';

/** 相似题必须明确「是否依赖图形」，避免出现题里说“如图”却没图的题目 */
describe('相似题 prompt 的图形约束', () => {
    const prompt = generateSimilarQuestionPrompt(
        'zh',
        '如图，在 $\\triangle ABC$ 中，$AD$ 是 $BC$ 边上的高线。',
        ['三角形的高'],
        'medium'
    );

    it('必须要求 AI 输出 requires_image 标记', () => {
        expect(prompt).toContain('<requires_image>');
        expect(prompt).toContain('填 true 或 false');
    });

    it('依赖图形时必须沿用原题图形结构', () => {
        expect(prompt).toContain('沿用原题的图形结构');
    });

    it('不依赖图形时禁止“如图”等无图指代', () => {
        expect(prompt).toContain('严禁');
        expect(prompt).toContain('如图');
    });
});
