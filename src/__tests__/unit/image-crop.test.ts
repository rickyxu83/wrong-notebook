/**
 * 整卷拆分裁切相关纯函数测试
 * parseBbox / computeRowInkProfile / findWhitespaceBoundary
 */
import { describe, it, expect } from 'vitest';
import { parseBbox } from '@/lib/ai/bbox';
import { computeRowInkProfile, findWhitespaceBoundary, findAllWhitespaceGaps, assignBoundaries } from '@/lib/image-utils';

describe('parseBbox', () => {
    it('应该解析标准格式 ymin,xmin,ymax,xmax', () => {
        expect(parseBbox('20,30,245,990')).toEqual([20, 30, 245, 990]);
    });

    it('应该兼容中文逗号和空白分隔', () => {
        expect(parseBbox('20，30 245 990')).toEqual([20, 30, 245, 990]);
    });

    it('应该 clamp 到 0-1000', () => {
        expect(parseBbox('-5,10,1200,990')).toEqual([0, 10, 1000, 990]);
    });

    it('空值/缺分量/倒挂/过小应该返回 null', () => {
        expect(parseBbox(null)).toBeNull();
        expect(parseBbox('')).toBeNull();
        expect(parseBbox('20,30')).toBeNull();
        expect(parseBbox('245,30,20,990')).toBeNull();   // ymax < ymin
        expect(parseBbox('20,990,245,30')).toBeNull();   // xmax < xmin
        expect(parseBbox('20,30,25,35')).toBeNull();     // 过小（<2%）
    });
});

describe('computeRowInkProfile', () => {
    it('白行占比为 0，黑字行和批改红字行占比 > 0', () => {
        // 4x3 图：第 0 行全白，第 1 行半黑，第 2 行有红像素
        const w = 4, h = 3;
        const data = new Uint8ClampedArray(w * h * 4).fill(255);
        // 第 1 行前两个像素设为黑
        for (const x of [0, 1]) {
            const i = (1 * w + x) * 4;
            data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
        }
        // 第 2 行第一个像素设为红（r 高、g/b 低）
        const ri = (2 * w + 0) * 4;
        data[ri] = 200; data[ri + 1] = 50; data[ri + 2] = 50;

        const profile = computeRowInkProfile(data, w, h);
        expect(profile[0]).toBe(0);
        expect(profile[1]).toBe(0.5);
        expect(profile[2]).toBe(0.25);
    });
});

describe('findWhitespaceBoundary', () => {
    // 构造 100 行 profile：10-30 有字，40-80 有字，31-39 与 81-99 空白
    const profile = Array.from({ length: 100 }, (_, y) => ((y >= 10 && y <= 30) || (y >= 40 && y <= 80) ? 0.2 : 0));

    it('应该在提示附近找到空白带中心', () => {
        // hint 在 33（上题下方空白带 31-39 内）→ 中心 35
        expect(findWhitespaceBoundary(profile, 33, 10)).toBe(35);
    });

    it('hint 有偏差时应找到窗口内最长的空白带', () => {
        // hint 在 42（有字区边缘），窗口 ±10 覆盖 32-52 → 空白带 32-39（8 行），中心 36
        expect(findWhitespaceBoundary(profile, 42, 10)).toBe(36);
    });

    it('窗口内无空白带时返回 null', () => {
        // hint 在 55，窗口 ±8 → 47-63 全是有字区
        expect(findWhitespaceBoundary(profile, 55, 8)).toBeNull();
    });

    it('稀疏墨迹（红笔划过）不超过阈值时仍视为空白', () => {
        const noisy = [...profile];
        noisy[35] = 0.005; // 一道红笔细线穿过空白带
        expect(findWhitespaceBoundary(noisy, 35, 10)).toBe(35);
    });

    it('空白带过短（<minRunPx）不算数', () => {
        const p = Array.from({ length: 50 }, () => 0.2);
        p[20] = 0; p[21] = 0; // 只有 2px 空白
        expect(findWhitespaceBoundary(p, 21, 10)).toBeNull();
    });
});

describe('findAllWhitespaceGaps', () => {
    it('应该返回所有空白带中心', () => {
        // 10-30 有字，40-80 有字 → 空白带 0-9、31-39、81-99
        const profile = Array.from({ length: 100 }, (_, y) => ((y >= 10 && y <= 30) || (y >= 40 && y <= 80) ? 0.2 : 0));
        const gaps = findAllWhitespaceGaps(profile);
        expect(gaps).toEqual([5, 35, 90]);
    });
});

describe('assignBoundaries（有序约束分配切线）', () => {
    it('AI 提示有系统性偏移时，靠真实空白带修正（实测案例）', () => {
        // 图高 1023，真实题起始 10/340/720/910，真实空白带 330/700/900
        // AI 给的 top 提示系统性偏低：20/261/532/808
        const b = assignBoundaries([330, 700, 900], [20, 261, 532, 808], 1023);
        expect(b).toEqual([0, 330, 700, 900, 1023]);
    });

    it('提示落在题内时，取提示下方最近的空白带（题首前面那条缝）', () => {
        // hint 379 已在题内（真实起始 340），下方空白带 [131,268,326] 中取最后一条 326
        const b = assignBoundaries([131, 268, 326, 390], [72, 379, 726], 1023);
        expect(b[1]).toBe(326);
        // i=2: hint 726，下方 ≤726 且 >326+20 的空白带只有 390 → 390
        expect(b[2]).toBe(390);
    });

    it('没有空白带时回退到提示位置，且保持单调不重叠', () => {
        const b = assignBoundaries([], [100, 300, 500], 600);
        expect(b).toEqual([0, 300, 500, 600]);
    });

    it('提示偏低（在真边界之上）时取上方最近空白带', () => {
        // hint 261 低于真实边界 330 → 下方无合格空白带，取上方 330
        const b = assignBoundaries([330, 700], [20, 261, 532], 1023);
        expect(b[1]).toBe(330);
        expect(b[2]).toBe(700);
    });

    it('单题直接返回整图边界', () => {
        expect(assignBoundaries([100], [50], 500)).toEqual([0, 500]);
    });

    it('第 1 题顶用内容起始行而不是提示附近的空白带（避免吃掉第一行）', () => {
        // 内容从第 10 行开始，hint 72 旁边的空白带 80 是题内缝隙，不应作为题顶
        const b = assignBoundaries([80, 330], [72, 379], 1023, 10);
        expect(b[0]).toBe(4); // 10 - 6
        expect(b[1]).toBe(330);
    });
});
