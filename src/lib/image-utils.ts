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

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = dataUrl;
    });
}

/**
 * 按 AI 返回的 bbox（0-1000 归一化 [ymin,xmin,ymax,xmax]）裁切题目图片。
 * AI 坐标是粗略提示：上下边界用横向空白带投影精修，横向仅在明显非整宽（双栏等）时裁切。
 * 任何异常都回退整图，不影响保存。
 */
export async function cropQuestionImage(
    dataUrl: string,
    bbox: [number, number, number, number]
): Promise<string> {
    const img = await loadImage(dataUrl);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (!W || !H) return dataUrl;

    const [yminN, , ymaxN, xmaxN] = bbox;
    const xminN = bbox[1];
    const padY = Math.round(H * 0.005);

    let top = Math.max(0, Math.round((yminN / 1000) * H) - padY);
    let bottom = Math.min(H, Math.round((ymaxN / 1000) * H) + padY);

    // 上下边界精修：在 ±10% 高度窗口内找空白带
    try {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.drawImage(img, 0, 0);
            const { data } = ctx.getImageData(0, 0, W, H);
            const profile = computeRowInkProfile(data, W, H);
            const win = Math.round(H * 0.10);
            const topB = findWhitespaceBoundary(profile, top, win);
            if (topB !== null && topB < bottom) top = Math.max(0, topB - 2);
            const botB = findWhitespaceBoundary(profile, bottom, win);
            if (botB !== null && botB > top) bottom = Math.min(H, botB + 2);
        }
    } catch {
        /* 精修失败保留 bbox 原值 */
    }

    // 裁切结果异常（过窄）→ 回退整图
    if (bottom - top < H * 0.02) return dataUrl;

    // 横向：仅当 AI 给的范围明显窄于整宽（如双栏版面）时才裁
    let left = 0;
    let right = W;
    if ((xmaxN - xminN) / 1000 < 0.9) {
        left = Math.max(0, Math.round((xminN / 1000) * W) - Math.round(W * 0.01));
        right = Math.min(W, Math.round((xmaxN / 1000) * W) + Math.round(W * 0.01));
        if (right - left < W * 0.2) { left = 0; right = W; }
    }

    const out = document.createElement('canvas');
    out.width = right - left;
    out.height = bottom - top;
    const octx = out.getContext('2d');
    if (!octx) return dataUrl;
    octx.drawImage(img, left, top, right - left, bottom - top, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.85);
}
