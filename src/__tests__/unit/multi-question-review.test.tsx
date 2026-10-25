import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { MultiQuestionReview } from '@/components/multi-question-review';
import type { ParsedQuestion } from '@/lib/ai';

// 本测试只验证服务端静态预览，不触发浏览器图片处理。
vi.mock('@/components/notebook-selector', () => ({
    NotebookSelector: () => <div>数学</div>,
}));

const question: ParsedQuestion = {
    questionText: '已知四边形 $ABCD$，用无刻度的直尺和圆规完成作图。',
    answerText: '（1）作线段 $BC$ 的垂直平分线，交 $AC$ 于点 $M$。\n\n（2）作 $\\angle APD$ 的角平分线，交 $AC$ 于点 $N$。',
    analysis: '点 $N$ 到 $AB$、$CD$ 的距离相等，因此\n$$S_{\\triangle ABN}=\\frac12 AB\\cdot h,\\qquad S_{\\triangle CDN}=\\frac12 CD\\cdot h.$$',
    wrongAnswerText: '',
    mistakeAnalysis: '',
    mistakeStatus: 'unknown',
    subject: '数学',
    knowledgePoints: ['角平分线的性质'],
    requiresImage: true,
};

describe('MultiQuestionReview 数学公式预览', () => {
    it('默认渲染 LaTeX，不把公式源码当作乱码直接展示', () => {
        const html = renderToStaticMarkup(
            <LanguageProvider>
                <MultiQuestionReview
                    questions={[question]}
                    pageImages={[]}
                    onSaved={vi.fn()}
                    onCancel={vi.fn()}
                />
            </LanguageProvider>
        );

        expect(html).toContain('katex');
        expect(html).toContain('编辑');
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain('$BC$');
        expect(html).not.toContain('$$S_{');
    });
});
