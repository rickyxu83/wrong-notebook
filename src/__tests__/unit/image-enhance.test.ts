import { describe, expect, it } from 'vitest';
import {
    applyAutoLevels,
    applyExclusionMask,
    clearRowRange,
    computeContentSegments,
    createExclusionMask,
    estimatePaperColor,
    fillPolygon,
    fillRectRange,
    fillRowRange,
    invertMask,
    maskBoundingBox,
    hitSegment,
    maskCoverage,
    paintCircle,
    paintLine,
    unsharpMask,
    whitenPaper,
    type PixelBuffer,
} from '@/lib/image-enhance';

function makeBuf(width: number, height: number, fill: [number, number, number]): PixelBuffer {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = 255;
    }
    return { data, width, height };
}

function setRect(buf: PixelBuffer, x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) {
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * buf.width + x) * 4;
            buf.data[i] = c[0]; buf.data[i + 1] = c[1]; buf.data[i + 2] = c[2];
        }
    }
}

const px = (buf: PixelBuffer, x: number, y: number) => {
    const i = (y * buf.width + x) * 4;
    return [buf.data[i], buf.data[i + 1], buf.data[i + 2]];
};

describe('image-enhance 像素函数', () => {
    it('estimatePaperColor 取亮部均值而非暗色墨迹', () => {
        const buf = makeBuf(20, 20, [200, 195, 190]); // 发黄纸面
        setRect(buf, 0, 0, 20, 3, [30, 30, 30]); // 顶部一行墨迹
        const [r, g, b] = estimatePaperColor(buf);
        expect(r).toBeGreaterThan(180);
        expect(g).toBeGreaterThan(175);
        expect(b).toBeGreaterThan(170);
    });

    it('applyAutoLevels 提亮昏暗照片', () => {
        const buf = makeBuf(10, 10, [120, 118, 116]);
        setRect(buf, 0, 0, 10, 1, [40, 40, 40]); // 少量深色字
        applyAutoLevels(buf);
        const [r] = px(buf, 5, 5);
        expect(r).toBeGreaterThan(200); // 纸面被拉亮
        expect(px(buf, 5, 0)[0]).toBeLessThan(80); // 墨迹仍深
    });

    it('whitenPaper 把纸面推向白色但保留红笔', () => {
        const buf = makeBuf(10, 10, [225, 220, 215]);
        setRect(buf, 0, 0, 3, 3, [200, 40, 40]); // 红笔批改
        setRect(buf, 5, 5, 8, 8, [40, 40, 45]); // 黑字
        whitenPaper(buf, [225, 220, 215]);
        expect(px(buf, 9, 9)[0]).toBeGreaterThan(245); // 纸面变白
        const red = px(buf, 1, 1);
        expect(red[0]).toBe(200); expect(red[1]).toBe(40); // 红笔原样
        expect(px(buf, 6, 6)[0]).toBe(40); // 墨迹原样
    });

    it('unsharpMask 增强边缘对比且不改均值太多', () => {
        const buf = makeBuf(9, 9, [200, 200, 200]);
        setRect(buf, 4, 0, 5, 9, [50, 50, 50]); // 中间一条竖线
        const before = px(buf, 3, 4)[0];
        unsharpMask(buf, 0.8);
        const after = px(buf, 3, 4)[0];
        expect(after).toBeGreaterThan(before); // 边缘亮侧更亮
    });
});

describe('排除 mask', () => {
    it('paintCircle 画圆且只改圆内像素', () => {
        const mask = createExclusionMask(20, 20);
        expect(paintCircle(mask, 20, 20, 10, 10, 3)).toBe(true);
        expect(mask[10 * 20 + 10]).toBe(1);
        expect(mask[0]).toBe(0);
        expect(mask[10 * 20 + 10 + 4]).toBe(0); // 半径外
        expect(paintCircle(mask, 20, 20, 10, 10, 3)).toBe(false); // 重复画无改动
    });

    it('paintLine 两点之间无断点', () => {
        const mask = createExclusionMask(100, 20);
        paintLine(mask, 100, 20, 5, 10, 95, 10, 2);
        for (let x = 5; x <= 95; x++) expect(mask[10 * 100 + x]).toBe(1);
    });

    it('fillRowRange / clearRowRange 整段填充与恢复', () => {
        const mask = createExclusionMask(10, 30);
        fillRowRange(mask, 10, 30, 5, 10);
        expect(mask[7 * 10 + 5]).toBe(1);
        expect(mask[12 * 10]).toBe(0);
        clearRowRange(mask, 10, 30, 5, 10);
        expect(mask[7 * 10 + 5]).toBe(0);
    });

    it('applyExclusionMask 把排除区涂白', () => {
        const buf = makeBuf(4, 4, [60, 60, 60]);
        const mask = createExclusionMask(4, 4);
        mask[5] = 1;
        applyExclusionMask(buf, mask);
        expect(px(buf, 1, 1)).toEqual([255, 255, 255]);
        expect(px(buf, 0, 0)).toEqual([60, 60, 60]);
    });

    it('maskCoverage 统计覆盖比例', () => {
        const mask = createExclusionMask(10, 10);
        fillRowRange(mask, 10, 10, 0, 4);
        expect(maskCoverage(mask)).toBeCloseTo(0.5, 1);
    });

    it('paintCircle/paintLine 支持擦除（value=0）', () => {
        const mask = createExclusionMask(20, 20);
        paintCircle(mask, 20, 20, 10, 10, 5, 1);
        expect(mask[10 * 20 + 10]).toBe(1);
        paintCircle(mask, 20, 20, 10, 10, 5, 0);
        expect(mask[10 * 20 + 10]).toBe(0);
        paintLine(mask, 20, 20, 2, 2, 18, 2, 2, 1);
        expect(mask[2 * 20 + 10]).toBe(1);
        paintLine(mask, 20, 20, 2, 2, 18, 2, 2, 0);
        expect(mask[2 * 20 + 10]).toBe(0);
    });

    it('fillRectRange 自动交换对角并裁剪到图内', () => {
        const mask = createExclusionMask(10, 10);
        fillRectRange(mask, 10, 10, 8, 8, 2, 2, 1); // 反向拖拽
        expect(mask[2 * 10 + 2]).toBe(1);
        expect(mask[5 * 10 + 5]).toBe(1);
        expect(mask[1 * 10 + 1]).toBe(0);
        fillRectRange(mask, 10, 10, -50, -50, 3, 3, 1); // 越界裁剪
        expect(mask[0]).toBe(1);
        fillRectRange(mask, 10, 10, 0, 0, 9, 9, 0); // 整图擦除
        expect(maskCoverage(mask)).toBe(0);
    });

    it('fillPolygon 三角形 even-odd 填充与擦除', () => {
        const mask = createExclusionMask(10, 10);
        fillPolygon(mask, 10, 10, [[1, 1], [8, 1], [1, 8]], 1);
        expect(mask[1 * 10 + 4]).toBe(1);  // 斜边上方内部
        expect(mask[5 * 10 + 2]).toBe(1);  // 靠近斜边内部
        expect(mask[5 * 10 + 7]).toBe(0);  // 斜边另一侧外部
        expect(mask[9 * 10 + 9]).toBe(0);
        // 少于 3 个点忽略
        fillPolygon(mask, 10, 10, [[0, 0], [9, 9]], 1);
        expect(mask[9 * 10 + 9]).toBe(0);
        // 擦除
        fillPolygon(mask, 10, 10, [[1, 1], [8, 1], [1, 8]], 0);
        expect(mask[1 * 10 + 4]).toBe(0);
    });

    it('invertMask 生成反转副本且不改原 mask', () => {
        const mask = createExclusionMask(4, 4);
        mask[0] = 1;
        const inv = invertMask(mask);
        expect(inv[0]).toBe(0);
        expect(inv[5]).toBe(1);
        expect(mask[0]).toBe(1); // 原 mask 不变
    });

    it('maskBoundingBox 返回外扩包围盒，空 mask 返回 null', () => {
        const mask = createExclusionMask(100, 100);
        expect(maskBoundingBox(mask, 100, 100)).toBeNull();
        fillRectRange(mask, 100, 100, 20, 30, 40, 50, 1);
        const box = maskBoundingBox(mask, 100, 100, 0.02)!;
        expect(box).toEqual({ x: 18, y: 28, width: 25, height: 25 }); // 各边外扩 2px
        const noPad = maskBoundingBox(mask, 100, 100, 0)!;
        expect(noPad).toEqual({ x: 20, y: 30, width: 21, height: 21 });
    });
});

describe('内容分段', () => {
    it('按空白带切成两段并支持命中测试', () => {
        const buf = makeBuf(20, 100, [240, 240, 240]);
        setRect(buf, 0, 5, 20, 20, [30, 30, 30]);   // 第一段墨迹
        setRect(buf, 0, 60, 20, 75, [30, 30, 30]);  // 第二段墨迹
        const segs = computeContentSegments(buf, 10);
        expect(segs.length).toBe(2);
        expect(segs[0][0]).toBeCloseTo(0.05, 2);
        expect(segs[1][1]).toBeCloseTo(0.74, 2); // 最后一个墨迹行是 74
        expect(hitSegment(segs, 0.1)).toBe(0);
        expect(hitSegment(segs, 0.65)).toBe(1);
        expect(hitSegment(segs, 0.4)).toBe(-1); // 空白带
    });

    it('红笔行也算墨迹', () => {
        const buf = makeBuf(20, 50, [240, 240, 240]);
        setRect(buf, 0, 10, 20, 20, [200, 50, 50]);
        const segs = computeContentSegments(buf, 8);
        expect(segs.length).toBe(1);
    });

    it('空白图返回空数组', () => {
        const buf = makeBuf(20, 50, [240, 240, 240]);
        expect(computeContentSegments(buf)).toEqual([]);
    });
});
