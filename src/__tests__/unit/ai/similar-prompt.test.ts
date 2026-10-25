import { describe, expect, it } from 'vitest';
import { generateSimilarQuestionPrompt } from '@/lib/ai/prompts';

/**
 * 试卷不出图，所以相似题必须是纯文字自包含题：
 * 禁止“如图”这类指代，避免出现“题里说有图、页面上没图”。
 */
describe('相似题 prompt 的纯文字约束', () => {
    const prompt = generateSimilarQuestionPrompt(
        'zh',
        '如图，在 $\\triangle ABC$ 中，$AD$ 是 $BC$ 边上的高线。',
        ['三角形的高'],
        'medium'
    );

    it('必须禁止“如图”等指代图形的表述', () => {
        expect(prompt).toContain('严禁');
        expect(prompt).toContain('如图');
    });

    it('要求把图形条件写成文字，保证题目可独立作答', () => {
        expect(prompt).toContain('全部用文字写进题干');
    });

    it('不再要求 AI 输出 requires_image（试卷不配图）', () => {
        expect(prompt).not.toContain('<requires_image>');
    });
});
