/**
 * 解析并校验 AI 返回的题目包围盒（bbox 标签）。
 * 格式：ymin,xmin,ymax,xmax，0-1000 归一化整数（原点左上，y 向下，x 向右）。
 * 用于整卷拆分后按题裁切原图。
 */
export type BBox = [number, number, number, number]; // [ymin, xmin, ymax, xmax]

export function parseBbox(raw: string | null): BBox | null {
    if (!raw) return null;
    const nums = raw
        .split(/[,，\s]+/)
        .map((s) => parseFloat(s))
        .filter((n) => !isNaN(n));
    if (nums.length < 4) return null;

    const [ymin, xmin, ymax, xmax] = nums.map((n) => Math.round(Math.min(1000, Math.max(0, n)))) as BBox;
    if (ymax <= ymin || xmax <= xmin) return null;
    // 高/宽小于 2% 视为不合理（AI 幻觉坐标）
    if (ymax - ymin < 20 || xmax - xmin < 20) return null;
    return [ymin, xmin, ymax, xmax];
}
