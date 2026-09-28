/**
 * 纸张照片增强：自动亮度、纸面增白、锐化。
 * 所有像素级函数都是纯函数（直接操作 RGBA 数组），可单测；
 * DOM 包装函数放在文件尾部。
 *
 * 设计约束：
 * - 必须保留红笔批改（偏红像素不参与增白/拉灰）
 * - 必须保留深色墨迹（印刷字/手写）
 * - 任何一步失败都不应毁掉原图（调用方负责回退）
 */

export type PixelBuffer = { data: Uint8ClampedArray; width: number; height: number };

function luminance(r: number, g: number, b: number): number {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isReddish(r: number, g: number, b: number): boolean {
    return r > 120 && r > g + 30 && r > b + 30;
}

/**
 * 估计纸面颜色：取亮度最高的 30% 像素的均值。
 * 照片里纸面通常是最大块的亮区域（桌面、手指、阴影更暗或更偏色）。
 */
export function estimatePaperColor({ data }: PixelBuffer): [number, number, number] {
    const count = data.length / 4;
    const lumas = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        lumas[i] = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    const sorted = Array.from(lumas).sort((a, b) => a - b);
    const cutoff = sorted[Math.floor(count * 0.7)] ?? 255;

    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < count; i++) {
        if (lumas[i] >= cutoff && !isReddish(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])) {
            sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2];
            n++;
        }
    }
    if (n === 0) return [235, 235, 235];
    return [sr / n, sg / n, sb / n];
}

/**
 * 亮度自动拉伸：把亮度的 p1~p99.5 分位线性映射到 [16, 248]。
 * 按亮度比例缩放 RGB，保持色相（红笔还是红的）。
 */
export function applyAutoLevels(buf: PixelBuffer, targetHi = 248, targetLo = 16): void {
    const { data } = buf;
    const count = data.length / 4;
    const hist = new Uint32Array(256);
    for (let i = 0; i < count; i++) {
        hist[Math.min(255, Math.round(luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])))]++;
    }
    const pick = (pct: number): number => {
        const need = count * pct;
        let acc = 0;
        for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= need) return v; }
        return 255;
    };
    const lo = pick(0.01);
    const hi = Math.max(lo + 1, pick(0.995));
    const scale = (targetHi - targetLo) / (hi - lo);

    for (let i = 0; i < count; i++) {
        const idx = i * 4;
        const l = luminance(data[idx], data[idx + 1], data[idx + 2]);
        if (l < 1) continue;
        const nl = Math.max(targetLo, Math.min(targetHi, targetLo + (l - lo) * scale));
        const f = nl / l;
        data[idx] = Math.min(255, data[idx] * f);
        data[idx + 1] = Math.min(255, data[idx + 1] * f);
        data[idx + 2] = Math.min(255, data[idx + 2] * f);
    }
}

/**
 * 纸面增白：接近纸面色的像素按相似度向白色靠拢。
 * 距离越近越白，超过 threshold 的像素（墨迹、红笔、图片）保持不动。
 */
export function whitenPaper(
    buf: PixelBuffer,
    paper: [number, number, number],
    threshold = 46,
    strength = 0.9
): void {
    const { data } = buf;
    const count = data.length / 4;
    for (let i = 0; i < count; i++) {
        const idx = i * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        if (isReddish(r, g, b)) continue; // 保红笔
        const dr = r - paper[0], dg = g - paper[1], db = b - paper[2];
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist >= threshold) continue;
        const f = (1 - dist / threshold) * strength;
        data[idx] = Math.min(255, r + (255 - r) * f);
        data[idx + 1] = Math.min(255, g + (255 - g) * f);
        data[idx + 2] = Math.min(255, b + (255 - b) * f);
    }
}

/**
 * Unsharp mask 锐化：luma + amount * (luma - blur)。
 * radius=1 的 3x3 盒式模糊，够轻，手机上 2MP 图约几十毫秒。
 */
export function unsharpMask(buf: PixelBuffer, amount = 0.6): void {
    const { data, width: W, height: H } = buf;
    if (W < 3 || H < 3) return;
    const luma = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        luma[i] = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            const blur = (
                luma[i - W - 1] + luma[i - W] + luma[i - W + 1] +
                luma[i - 1] + luma[i] + luma[i + 1] +
                luma[i + W - 1] + luma[i + W] + luma[i + W + 1]
            ) / 9;
            const delta = (luma[i] - blur) * amount;
            if (Math.abs(delta) < 0.5) continue;
            const idx = i * 4;
            const f = (luma[i] + delta) / Math.max(1, luma[i]);
            data[idx] = Math.max(0, Math.min(255, data[idx] * f));
            data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] * f));
            data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] * f));
        }
    }
}

/** 一键纸张增强：自动亮度 → 增白 → 锐化。 */
export function enhancePaperPixels(buf: PixelBuffer): void {
    applyAutoLevels(buf);
    const paper = estimatePaperColor(buf);
    whitenPaper(buf, paper);
    unsharpMask(buf);
}

/* ==================== 排除区域 mask（分段点选 + 涂抹共用一套机制） ==================== */

/** 创建排除 mask：1 = 该区域涂白不送 AI。 */
export function createExclusionMask(width: number, height: number): Uint8Array {
    return new Uint8Array(width * height);
}

/** 涂抹：以 (cx,cy) 为圆心、r 为半径画进 mask。返回是否有改动。 */
export function paintCircle(mask: Uint8Array, width: number, height: number, cx: number, cy: number, r: number): boolean {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(height - 1, Math.ceil(cy + r));
    const r2 = r * r;
    let changed = false;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy <= r2) {
                const i = y * width + x;
                if (!mask[i]) { mask[i] = 1; changed = true; }
            }
        }
    }
    return changed;
}

/** 两个涂抹点之间插值连线，避免快速滑动断点。 */
export function paintLine(mask: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, r: number): void {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, r * 0.5)));
    for (let s = 0; s <= steps; s++) {
        paintCircle(mask, width, height, x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, r);
    }
}

/** 分段点选：整行段填充进 mask。 */
export function fillRowRange(mask: Uint8Array, width: number, height: number, yTop: number, yBottom: number): void {
    const t = Math.max(0, Math.floor(yTop)), b = Math.min(height - 1, Math.ceil(yBottom));
    for (let y = t; y <= b; y++) mask.fill(1, y * width, (y + 1) * width);
}

/** mask 反选（用于"点一下恢复"）：把指定行段从 mask 里清掉。 */
export function clearRowRange(mask: Uint8Array, width: number, height: number, yTop: number, yBottom: number): void {
    const t = Math.max(0, Math.floor(yTop)), b = Math.min(height - 1, Math.ceil(yBottom));
    for (let y = t; y <= b; y++) mask.fill(0, y * width, (y + 1) * width);
}

/** 应用 mask：被排除的像素涂成纯白（保留版面布局，AI 只看到留下的题）。 */
export function applyExclusionMask(buf: PixelBuffer, mask: Uint8Array): void {
    const { data } = buf;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i]) {
            data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255;
        }
    }
}

export function maskCoverage(mask: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    return mask.length ? n / mask.length : 0;
}

/**
 * 用横向空白带把页面切成内容段（供"点选整段排除"）。
 * 返回归一化 [top, bottom] 区间数组；过矮的段（<1.5% 页高）并入邻段。
 * 纯函数；墨迹分析复用 image-utils 的 computeRowInkProfile / findAllWhitespaceGaps 思路，
 * 这里自带一份轻量实现以避免循环依赖。
 */
export function computeContentSegments(buf: PixelBuffer, minGapPx = 12, inkThreshold = 0.01): [number, number][] {
    const { data, width: W, height: H } = buf;
    const profile = new Array<number>(H).fill(0);
    for (let y = 0; y < H; y++) {
        let ink = 0;
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if ((r < 190 && g < 190 && b < 190) || isReddish(r, g, b)) ink++;
        }
        profile[y] = ink / W;
    }

    // 内容行聚段：墨迹行之间若只隔 < minGapPx 的空白，视为同一段
    const segments: [number, number][] = [];
    let segStart = -1, lastInk = -1;
    for (let y = 0; y < H; y++) {
        if (profile[y] >= inkThreshold) {
            if (segStart < 0) segStart = y;
            lastInk = y;
        } else if (segStart >= 0 && y - lastInk >= minGapPx) {
            segments.push([segStart, lastInk]);
            segStart = -1;
        }
    }
    if (segStart >= 0) segments.push([segStart, lastInk]);

    // 过滤 + 归一化
    const minHPx = H * 0.015;
    return segments
        .filter(([t, b]) => b - t >= minHPx)
        .map(([t, b]) => [t / H, b / H] as [number, number]);
}

/** 点中了哪一段（py 为像素行），返回段下标；不在任何段内返回 -1。 */
export function hitSegment(segments: [number, number][], pyFrac: number): number {
    for (let i = 0; i < segments.length; i++) {
        if (pyFrac >= segments[i][0] && pyFrac <= segments[i][1]) return i;
    }
    return -1;
}

/* ==================== DOM 包装（浏览器侧使用） ==================== */

function loadImageEl(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = dataUrl;
    });
}

export async function withPixelBuffer<T>(dataUrl: string, fn: (buf: PixelBuffer, canvas: HTMLCanvasElement) => T): Promise<T> {
    const img = await loadImageEl(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 Canvas 上下文');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return fn({ data: imageData.data, width: canvas.width, height: canvas.height }, canvas);
}

/** 增强整张纸照片，返回 JPEG dataURL；失败回退原图。 */
export async function enhancePaperImage(dataUrl: string, quality = 0.88): Promise<string> {
    try {
        return await withPixelBuffer(dataUrl, (buf, canvas) => {
            enhancePaperPixels(buf);
            const ctx = canvas.getContext('2d')!;
            // 拷贝一份保证底层是独立 ArrayBuffer（ImageData 构造函数的类型要求）
            ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
            return canvas.toDataURL('image/jpeg', quality);
        });
    } catch {
        return dataUrl;
    }
}

/** 把排除 mask 涂白后的成品图。 */
export async function bakeExclusion(dataUrl: string, mask: Uint8Array, quality = 0.88): Promise<string> {
    try {
        return await withPixelBuffer(dataUrl, (buf, canvas) => {
            applyExclusionMask(buf, mask);
            const ctx = canvas.getContext('2d')!;
            ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
            return canvas.toDataURL('image/jpeg', quality);
        });
    } catch {
        return dataUrl;
    }
}

/** 计算内容段（DOM 包装版）。 */
export async function detectSegments(dataUrl: string): Promise<[number, number][]> {
    try {
        return await withPixelBuffer(dataUrl, (buf) => computeContentSegments(buf));
    } catch {
        return [];
    }
}
