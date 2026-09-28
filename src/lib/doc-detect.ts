/**
 * 文档切边 + 透视矫正（二期）。
 * 按需懒加载 /vendor/opencv.js（~11MB WASM UMD），加载失败或未找到纸张轮廓时静默回退。
 *
 * 管线：灰度 → 高斯模糊 → Canny → 轮廓 → 最大四边形 → 透视变换到矩形。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */ // opencv.js 为无类型的第三方 UMD 全局对象

declare global {
    interface Window { cv?: any; }
}

let cvReadyPromise: Promise<any> | null = null;

/** 懒加载 opencv.js；加载完成 resolve cv 对象，失败 reject。 */
export function loadOpenCV(): Promise<any> {
    if (cvReadyPromise) return cvReadyPromise;
    cvReadyPromise = new Promise((resolve, reject) => {
        if (window.cv?.Mat) { resolve(window.cv); return; }
        const script = document.createElement('script');
        script.src = '/vendor/opencv.js';
        script.async = true;
        script.onload = () => {
            const cv = window.cv;
            if (!cv) { reject(new Error('opencv 未注册到 window.cv')); return; }
            if (cv.Mat) { resolve(cv); return; }
            // WASM 异步初始化
            cv.onRuntimeInitialized = () => resolve(cv);
            setTimeout(() => (cv.Mat ? resolve(cv) : reject(new Error('opencv 初始化超时'))), 15000);
        };
        script.onerror = () => reject(new Error('opencv.js 加载失败'));
        document.head.appendChild(script);
    });
    cvReadyPromise.catch(() => { cvReadyPromise = null; }); // 失败允许重试
    return cvReadyPromise;
}

/** 预加载（上传第一张图后后台触发，用户打开编辑器时多半已就绪）。 */
export function preloadOpenCV(): void {
    if (typeof window !== 'undefined') loadOpenCV().catch(() => {});
}

type Quad = [number, number][]; // 4 个 [x, y]，顺序：左上、右上、右下、左下

function orderQuad(pts: { x: number; y: number }[]): Quad {
    // 按 x+y 找左上/右下，按 x-y 找右上/左下
    const sorted = [...pts];
    const sum = sorted.map(p => p.x + p.y);
    const diff = sorted.map(p => p.x - p.y);
    const tl = sorted[sum.indexOf(Math.min(...sum))];
    const br = sorted[sum.indexOf(Math.max(...sum))];
    const tr = sorted[diff.indexOf(Math.max(...diff))];
    const bl = sorted[diff.indexOf(Math.min(...diff))];
    return [[tl.x, tl.y], [tr.x, tr.y], [br.x, br.y], [bl.x, bl.y]];
}

/**
 * 在画布像素里找纸张四边形。
 * 找到且面积占图 >20% 返回四角坐标；否则 null。
 */
export function detectPaperQuad(cv: any, canvas: HTMLCanvasElement): Quad | null {
    let src: any, gray: any, blurred: any, edged: any, contours: any, hierarchy: any;
    try {
        src = cv.imread(canvas);
        gray = new cv.Mat();
        blurred = new cv.Mat();
        edged = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
        cv.Canny(blurred, edged, 50, 150);

        contours = new cv.MatVector();
        hierarchy = new cv.Mat();
        cv.findContours(edged, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        const imgArea = canvas.width * canvas.height;
        let best: { area: number; quad: Quad } | null = null;

        for (let i = 0; i < contours.size(); i++) {
            const cnt = contours.get(i);
            const area = cv.contourArea(cnt);
            if (area < imgArea * 0.2) { cnt.delete(); continue; }
            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
            if (approx.rows === 4 && cv.isContourConvex(approx)) {
                const pts = [];
                for (let j = 0; j < 4; j++) {
                    pts.push({ x: approx.intPtr(j)[0], y: approx.intPtr(j)[1] });
                }
                if (!best || area > best.area) best = { area, quad: orderQuad(pts) };
            }
            approx.delete();
            cnt.delete();
        }
        return best?.quad ?? null;
    } catch {
        return null;
    } finally {
        src?.delete(); gray?.delete(); blurred?.delete(); edged?.delete();
        contours?.delete(); hierarchy?.delete();
    }
}

/**
 * 透视矫正：把 quad 区域拉正为矩形，返回新 canvas；失败返回 null。
 * 输出尺寸取 quad 两侧边长的最大值，保持内容不压缩。
 */
export function warpPerspective(cv: any, canvas: HTMLCanvasElement, quad: Quad): HTMLCanvasElement | null {
    let src: any, dst: any, M: any, srcTri: any, dstTri: any;
    try {
        const [[tlx, tly], [trx, try_], [brx, bry], [blx, bly]] = quad;
        const wTop = Math.hypot(trx - tlx, try_ - tly);
        const wBot = Math.hypot(brx - blx, bry - bly);
        const hLeft = Math.hypot(blx - tlx, bly - tly);
        const hRight = Math.hypot(brx - trx, bry - try_);
        const outW = Math.round(Math.max(wTop, wBot));
        const outH = Math.round(Math.max(hLeft, hRight));
        if (outW < 100 || outH < 100) return null;

        src = cv.imread(canvas);
        dst = new cv.Mat();
        srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tlx, tly, trx, try_, brx, bry, blx, bly]);
        dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
        M = cv.getPerspectiveTransform(srcTri, dstTri);
        cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        cv.imshow(out, dst);
        return out;
    } catch {
        return null;
    } finally {
        src?.delete(); dst?.delete(); M?.delete(); srcTri?.delete(); dstTri?.delete();
    }
}

/**
 * 一键切边矫正：输入 dataURL，成功返回矫正后的 dataURL，任何失败回退原图。
 */
export async function rectifyPaperImage(dataUrl: string, quality = 0.9): Promise<string> {
    try {
        const cv = await loadOpenCV();
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('图片加载失败'));
            el.src = dataUrl;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return dataUrl;
        ctx.drawImage(img, 0, 0);

        const quad = detectPaperQuad(cv, canvas);
        if (!quad) return dataUrl;
        const warped = warpPerspective(cv, canvas, quad);
        if (!warped) return dataUrl;
        return warped.toDataURL('image/jpeg', quality);
    } catch {
        return dataUrl;
    }
}
