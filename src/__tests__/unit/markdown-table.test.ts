/**
 * MarkdownRenderer 伪表格规范化测试
 */
import { describe, it, expect } from 'vitest';
import { fixMalformedTables } from '@/components/markdown-renderer';

describe('fixMalformedTables', () => {
    it('缺分隔行的伪表格应补全为标准 Markdown 表格', () => {
        const input = `实验数据如下表：

次数 | 弦长 L/m | 重物个数 | 频率 f/Hz
1 | 0.50 | 2 | 300
2 | 1.00 | 2 | 150

（1）分析数据`;
        const out = fixMalformedTables(input);
        expect(out).toContain('| 次数 | 弦长 L/m | 重物个数 | 频率 f/Hz |');
        expect(out).toContain('| --- | --- | --- | --- |');
        expect(out).toContain('| 1 | 0.50 | 2 | 300 |');
        // 表格块之外的文本不动
        expect(out).toContain('（1）分析数据');
    });

    it('已是标准表格（有分隔行）的不应改动', () => {
        const input = `| a | b |\n|---|---|\n| 1 | 2 |`;
        expect(fixMalformedTables(input)).toBe(input);
    });

    it('含 LaTeX 的行不应当作表格（$|x|$ 守卫）', () => {
        const input = `$|x| = 2$\n$|y| = 3$`;
        expect(fixMalformedTables(input)).toBe(input);
    });

    it('单行带竖线不成表格', () => {
        const input = `答案：A | B 均可`;
        expect(fixMalformedTables(input)).toBe(input);
    });

    it('表格块后紧跟普通文本应正确断开', () => {
        const input = `a | b | c\n1 | 2 | 3\n这是普通文字，没有竖线\nc | d | e\n3 | 4 | 5`;
        const out = fixMalformedTables(input);
        const parts = out.split('这是普通文字，没有竖线');
        expect(parts[0]).toContain('| --- | --- | --- |');
        expect(parts[1]).toContain('| --- | --- | --- |'); // 第二段表格也独立补全
    });
});
