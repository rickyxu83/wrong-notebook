/**
 * 压缩图片文件
 * @param file 原始图片文件
 * @param maxSizeMB 最大文件大小（MB），默认 1MB
 * @param maxWidth 最大宽度，默认 1920px
 * @param quality 压缩质量 0-1，默认 0.8
 * @returns 压缩后的 Base64 字符串
 */
export async function compressImage(
    file: File,
    maxSizeMB: number = 1,
    maxWidth: number = 1920,
    quality: number = 0.8
): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                if (!ctx) {
                    reject(new Error('无法获取 Canvas 上下文'));
                    return;
                }

                // 计算新的尺寸（保持宽高比）
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;

                // 绘制图片
                ctx.drawImage(img, 0, 0, width, height);

                // 转换为 Base64，逐步降低质量直到满足大小要求
                let currentQuality = quality;
                let compressed = canvas.toDataURL('image/jpeg', currentQuality);

                // 检查大小（Base64 字符串长度约等于文件大小的 4/3）
                const sizeInMB = (compressed.length * 3) / 4 / 1024 / 1024;

                // 如果还是太大，继续降低质量
                while (sizeInMB > maxSizeMB && currentQuality > 0.1) {
                    currentQuality -= 0.1;
                    compressed = canvas.toDataURL('image/jpeg', currentQuality);
                    const newSize = (compressed.length * 3) / 4 / 1024 / 1024;

                    console.log(`压缩质量: ${currentQuality.toFixed(1)}, 大小: ${newSize.toFixed(2)}MB`);

                    if (newSize <= maxSizeMB) break;
                }

                console.log(`原始文件: ${(file.size / 1024 / 1024).toFixed(2)}MB, 压缩后: ${((compressed.length * 3) / 4 / 1024 / 1024).toFixed(2)}MB`);

                resolve(compressed);
            };

            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = e.target?.result as string;
        };

        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
    });
}

/**
 * 检查并压缩图片（如果需要）
 * @param file 图片文件
 * @returns Base64 字符串
 */
export async function processImageFile(file: File): Promise<string> {
    const fileSizeMB = file.size / 1024 / 1024;
    const threshold = 1; // 1MB 阈值

    console.log(`文件大小: ${fileSizeMB.toFixed(2)}MB`);

    if (fileSizeMB > threshold) {
        console.log('文件超过阈值，开始压缩...');
        return await compressImage(file, threshold);
    } else {
        console.log('文件大小合适，无需压缩');
        // 直接返回 Base64
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }
}

/* ==================== 整卷拆分：按题裁切原图 ==================== */

/**
 * 计算每行墨迹占比（0-1）。
 * 墨迹判定：深色像素（印刷/手写黑蓝字）或偏红像素（红笔批改）。
 */
export function computeRowInkProfile(data: Uint8ClampedArray, width: number, height: number): number[] {
    const profile = new Array<number>(height).fill(0);
    for (let y = 0; y < height; y++) {
        let ink = 0;
        const rowStart = y * width * 4;
        for (let x = 0; x < width; x++) {
            const i = rowStart + x * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const dark = r < 190 && g < 190 && b < 190;
            const red = r > 120 && r > g + 30 && r > b + 30;
            if (dark || red) ink++;
        }
        profile[y] = ink / width;
    }
    return profile;
}

/**
 * 在 hintIdx 附近 ±windowPx 内找最佳空白分隔带（连续低墨迹行）的中心。
 * 找不到合格空白带返回 null（调用方回退到 hint 位置）。
 */
export function findWhitespaceBoundary(
    profile: number[],
    hintIdx: number,
    windowPx: number,
    minRunPx: number = 6,
    inkThreshold: number = 0.01
): number | null {
    const lo = Math.max(0, Math.round(hintIdx - windowPx));
    const hi = Math.min(profile.length - 1, Math.round(hintIdx + windowPx));

    let bestStart = -1, bestLen = 0, runStart = -1, runLen = 0;
    for (let y = lo; y <= hi; y++) {
        if (profile[y] < inkThreshold) {
            if (runStart < 0) runStart = y;
            runLen++;
            if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
        } else {
            runStart = -1;
            runLen = 0;
        }
    }
    if (bestLen < minRunPx) return null;
    return bestStart + Math.floor(bestLen / 2);
}

/**
 * 提取整页的全部横向空白带中心（题目之间的天然分隔线候选）。
 */
export function findAllWhitespaceGaps(profile: number[], minRunPx: number = 6, inkThreshold: number = 0.01): number[] {
    const gaps: number[] = [];
    let runStart = -1, runLen = 0;
    for (let y = 0; y < profile.length; y++) {
        if (profile[y] < inkThreshold) {
            if (runStart < 0) runStart = y;
            runLen++;
        } else {
            if (runLen >= minRunPx) gaps.push(runStart + Math.floor(runLen / 2));
            runStart = -1;
            runLen = 0;
        }
    }
    if (runLen >= minRunPx) gaps.push(runStart + Math.floor(runLen / 2));
    return gaps;
}

/**
 * 有序约束分配切线（纯函数，可单测）：
 * AI 的题顶提示单调但可能有系统性偏移。切线选择规则：
 * - 优先取提示下方最近的空白带（题目起始行前面那条缝最有可能是真边界）；
 * - 提示偏低（在真边界之上）时，取提示上方最近的空白带；
 * - 都不行则回退提示位置。
 *
 * @param gapCenters 升序的空白带中心（px）
 * @param topHints   每题 top 提示（px，与题数等长，升序）
 * @param height     图片高度（px）
 * @param contentTop 页面内容起始行（第一条墨迹行），作为第 1 题顶
 * @returns N+1 个边界：[第1题顶, 切线1, ..., 切线N-1, 第N题底]
 */
export function assignBoundaries(gapCenters: number[], topHints: number[], height: number, contentTop: number = 0): number[] {
    const n = topHints.length;
    if (n === 0) return [0, height];
    const minBlockPx = Math.round(height * 0.02); // 每题至少占 2% 高度

    // 第 1 题顶：页面内容起始处（提示通常落在第一题内部，向上找空白带容易吃掉第一行）
    const boundaries: number[] = [Math.max(0, contentTop - 6)];

    for (let i = 1; i < n; i++) {
        const hint = topHints[i];
        const minPos = boundaries[boundaries.length - 1] + minBlockPx;
        const below = gapCenters.filter((g) => g <= hint && g > minPos);
        const above = gapCenters.filter((g) => g > hint && g > minPos);
        let cut: number;
        if (below.length > 0) {
            cut = below[below.length - 1]; // 提示下方（前面）最近的空白带
        } else if (above.length > 0) {
            cut = above[0]; // 提示偏低：取上方最近空白带
        } else {
            cut = Math.max(minPos, hint); // 无空白带，回退提示
        }
        boundaries.push(cut);
    }

    // 最后一题底：整图底
    boundaries.push(height);
    return boundaries;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = dataUrl;
    });
}

/**
 * 计算整页拆分的题目边界（归一化 0-1 比例，N 道题返回 N+1 条）。
 * AI 的 bbox 仅作为题顶位置的粗略提示，真正切线由横向空白带投影决定。
 * 无法计算时（无 bbox / 图片加载失败）返回 null，调用方回退整图。
 */
export async function computeQuestionBoundaries(
    dataUrl: string,
    bboxes: ([number, number, number, number] | undefined)[]
): Promise<number[] | null> {
    const n = bboxes.length;
    if (n === 0) return null;

    try {
        const img = await loadImage(dataUrl);
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        if (!W || !H) return null;

        // 单题不需要切
        if (n === 1) return [0, 1];
        // 任一题缺 bbox → 无法对齐顺序，放弃自动切分
        if (bboxes.some((b) => !b)) return null;

        const topHints = bboxes.map((b) => Math.round((b![0] / 1000) * H));

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, W, H);

        const profile = computeRowInkProfile(data, W, H);
        const gaps = findAllWhitespaceGaps(profile);
        const firstInk = profile.findIndex((v) => v >= 0.005);
        const contentTop = firstInk >= 0 ? firstInk : 0;

        const boundaries = assignBoundaries(gaps, topHints, H, contentTop);
        return boundaries.map((b) => b / H);
    } catch {
        return null;
    }
}

/**
 * 按给定边界（归一化 0-1，N+1 条）把整页裁成 N 张题目图。
 * 任何异常时对应题回退整图。
 */
export async function cropByBoundaries(dataUrl: string, boundaries: number[]): Promise<string[]> {
    const n = boundaries.length - 1;
    if (n <= 0) return [dataUrl];

    try {
        const img = await loadImage(dataUrl);
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        if (!W || !H) return Array(n).fill(dataUrl);

        return boundaries.slice(0, n).map((_, i) => {
            const top = Math.max(0, Math.min(Math.round(boundaries[i] * H), H - 10));
            const bottom = Math.max(top + 10, Math.min(Math.round(boundaries[i + 1] * H), H));
            const out = document.createElement('canvas');
            out.width = W;
            out.height = bottom - top;
            const octx = out.getContext('2d');
            if (!octx) return dataUrl;
            octx.drawImage(img, 0, top, W, bottom - top, 0, 0, W, bottom - top);
            return out.toDataURL('image/jpeg', 0.85);
        });
    } catch {
        return Array(n).fill(dataUrl);
    }
}
