import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters } from '@/components/markdown-renderer';

/**
 * AI 常输出 \( ... \) 与 \[ ... \]，remark-math 只认 $...$，
 * 不转换就会把公式源码当正文显示（如 (AC=\dfrac34 AB)）。
 */
describe('normalizeMathDelimiters', () => {
    it('把行内 \\( ... \\) 转成 $...$', () => {
        expect(normalizeMathDelimiters('则 \\(AC=\\dfrac34 AB\\)，求比值'))
            .toBe('则 $AC=\\dfrac34 AB$，求比值');
    });

    it('把行间 \\[ ... \\] 转成 $$...$$', () => {
        const out = normalizeMathDelimiters('解：\\[S=\\frac12 ab\\]完成');
        expect(out).toContain('$$');
        expect(out).toContain('S=\\frac12 ab');
        expect(out).not.toContain('\\[');
    });

    it('相邻多个行内公式都能转换', () => {
        expect(normalizeMathDelimiters('\\(A\\) 与 \\(B\\) 和 \\(C\\)'))
            .toBe('$A$ 与 $B$ 和 $C$');
    });

    it('已经使用 $...$ 的内容保持不变', () => {
        const src = '已知 $x=1$，求 $x^2$。';
        expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('空内容与无公式文本保持原样', () => {
        expect(normalizeMathDelimiters('')).toBe('');
        expect(normalizeMathDelimiters('纯文字题目，无公式。')).toBe('纯文字题目，无公式。');
    });
});
