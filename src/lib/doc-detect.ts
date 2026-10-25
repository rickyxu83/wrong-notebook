/**
 * 文档切边 + 透视矫正（二期，v2 HSV 分割版）。
 * 按需懒加载 /vendor/opencv.js（~11MB WASM UMD），加载失败或未找到纸张轮廓时静默回退。
 *
 * v1 的 Canny 轮廓法在真实场景失效（卷边/遮挡/增白后对比度下降 → 四边形候选为 0）。
 * v2 改为颜色分割：纸 = 高亮度低饱和，木桌 = 高饱和，平板/阴影 = 低亮度；
 * HSV inRange → 形态学开/闭 → 最大轮廓 → approxPolyDP（渐进 epsilon）→ minAreaRect 兜底。
 * 已在真实浏览器 + 真实桌面照片验证（mask 命中 79.3%，矫正后内容完整）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */ // opencv.js 为无类型的第三方 UMD 全局对象

declare global {
    interface Window {
        cv?: any;
        /** layout 内联 hook 写入：opencv 就绪信号（true=就绪，false=加载失败） */
        __cvReady?: Promise<unknown>;
        /** layout 内联 hook 写入：就绪后的 cv Module（不经过 promise 传递，避免 thenable 收养死循环） */
        __cvModule?: any;
    }
}

/**
 * 等待 opencv 就绪，返回包装对象 { cv }（不可用返回 null）。
 *
 * 血泪教训（实测 Chrome 渲染进程 100% CPU 死转、页面假死）：这个 opencv.js 构建的
 * window.cv 是 Emscripten thenable，一旦被原生 Promise 收养（resolve(cv)、async return cv、
 * Promise.resolve(cv)）就触发内部死循环；动态注入/async/defer 加载同样挂死。
 * 因此 opencv 由 layout 里的经典同步标签加载、就绪回调在解析期同步挂好（window.__cvReady），
 * 这里只读全局状态并返回包装对象。
 */
export async function loadOpenCV(): Promise<{ cv: any } | null> {
    if (typeof window === 'undefined') return null;
    const ready = window.__cvReady;
    if (!ready) return null;
    const result = await Promise.race([
        ready,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 25000)),
    ]).catch(() => 'error' as const);
    return result === true && window.__cvModule ? { cv: window.__cvModule } : null;
}

/** 预热：保持 API 兼容（opencv 随页面同步加载，这里只是提前触发一次就绪等待） */
export function preloadOpenCV(): void {
    if (typeof window !== 'undefined') void loadOpenCV();
}

type Quad = [number, number][]; // 4 个 [x, y]，顺序：左上、右上、右下、左下

function orderQuad(pts: [number, number][]): Quad {
    const sum = pts.map(p => p[0] + p[1]);
    const diff = pts.map(p => p[0] - p[1]);
    return [
        pts[sum.indexOf(Math.min(...sum))],
        pts[diff.indexOf(Math.max(...diff))],
        pts[sum.indexOf(Math.max(...sum))],
        pts[diff.indexOf(Math.min(...diff))],
    ];
}

/** 纸张掩膜参数（HSV）：纸面亮且低饱和。 */
const PAPER_LO = [0, 0, 110, 0];
const PAPER_HI = [180, 90, 255, 255];

/** 检测用降采样上限：形态学大核在 2MP 全图上是手机主线程杀手，768px 足够定位纸张 */
const DETECT_MAX_DIM = 768;

/**
 * 在画布像素里找纸张四边形。
 * 内部降采样到 ≤768px 检测（速度快 10-20 倍，手机不卡），返回的坐标已映射回原图尺寸。
 * 三级策略链：严格纸色 → 放宽纸色 → Otsu 亮度自适应；任一策略拿到真四边形即返回，
 * 都拿不到才用首个策略的 minAreaRect 兜底（纠旋转但不纠透视）。
 */
export function detectPaperQuad(cv: any, canvas: HTMLCanvasElement): Quad | null {
    let src: any, rgb: any, hsv: any, gray: any;
    const masks: any[] = [];
    try {
        // 降采样工作图
        const scale = Math.min(1, DETECT_MAX_DIM / Math.max(canvas.width, canvas.height));
        let work = canvas;
        if (scale < 1) {
            work = document.createElement('canvas');
            work.width = Math.max(1, Math.round(canvas.width * scale));
            work.height = Math.max(1, Math.round(canvas.height * scale));
            work.getContext('2d')?.drawImage(canvas, 0, 0, work.width, work.height);
        }

        src = cv.imread(work);
        const imgArea = work.width * work.height;

        rgb = new cv.Mat();
        hsv = new cv.Mat();
        gray = new cv.Mat();
        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
        cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

        const kOpen = cv.Mat.ones(5, 5, cv.CV_8U);
        const kClose = cv.Mat.ones(15, 15, cv.CV_8U);
        let quad: Quad | null = null;
        let rectFallback: Quad | null = null;
        try {
            for (const makeMask of STRATEGIES) {
                const mask = makeMask(cv, src, hsv, gray, null);
                masks.push(mask);
                cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kOpen);   // 去噪点
                cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kClose); // 补洞连边
                const res = quadFromMask(cv, mask, imgArea);
                if (res?.isQuad) { quad = res.quad; break; }
                if (res && !rectFallback) rectFallback = res.quad;
            }
        } finally {
            kOpen.delete(); kClose.delete();
            for (const m of masks) m.delete();
        }

        if (!quad) quad = rectFallback;
        if (!quad) return null;

        // 坐标映射回原图尺寸
        if (scale < 1) quad = quad.map(([x, y]) => [x / scale, y / scale] as [number, number]);
        return quad;
    } catch {
        return null;
    } finally {
        src?.delete(); rgb?.delete(); hsv?.delete(); gray?.delete();
    }
}

/**
 * 从二值掩膜里提取纸张四边形。
 * 凸包先行（填平手指/字迹/卷边造成的凹陷，approxPolyDP 命中率大增），
 * 渐进 epsilon 找真四边形；失败回退 minAreaRect（isQuad=false 标记，让调用方先试别的策略）。
 */
function quadFromMask(cv: any, mask: any, imgArea: number): { quad: Quad; isQuad: boolean } | null {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let best: any = null;
    let hull: any = null;
    try {
        cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        let bestArea = 0;
        for (let i = 0; i < contours.size(); i++) {
            const cnt = contours.get(i);
            const area = cv.contourArea(cnt);
            if (area > bestArea) { bestArea = area; if (best) best.delete(); best = cnt; }
            else cnt.delete();
        }
        if (!best || bestArea < imgArea * 0.18) return null;

        hull = new cv.Mat();
        cv.convexHull(best, hull, false, true);
        best.delete(); best = null;

        for (const eps of [0.015, 0.02, 0.03, 0.045, 0.06]) {
            const peri = cv.arcLength(hull, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(hull, approx, eps * peri, true);
            const ok = approx.rows === 4 && cv.isContourConvex(approx);
            if (ok) {
                const pts: [number, number][] = [];
                for (let j = 0; j < 4; j++) pts.push([approx.intPtr(j)[0], approx.intPtr(j)[1]]);
                approx.delete();
                return { quad: orderQuad(pts), isQuad: true };
            }
            approx.delete();
        }
        // 兜底：旋转矩形（能纠旋转但纠不了透视梯形，所以标记 isQuad=false）
        const rect = cv.minAreaRect(hull);
        const corners = (cv.RotatedRect.points(rect) as { x: number; y: number }[])
            .map(p => [p.x, p.y] as [number, number]);
        return { quad: orderQuad(corners), isQuad: false };
    } catch {
        return null;
    } finally {
        best?.delete(); hull?.delete(); contours.delete(); hierarchy.delete();
    }
}

/** 三条分割策略：严格纸色 → 放宽纸色（暗/黄纸） → Otsu 亮度自适应 */
type MaskStrategy = (cv: any, src: any, hsv: any, gray: any, tmp: any) => any;

const STRATEGIES: MaskStrategy[] = [
    // 1. 严格：亮且低饱和
    (cv, src, hsv) => {
        const mask = new cv.Mat();
        const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), PAPER_LO);
        const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), PAPER_HI);
        cv.inRange(hsv, lo, hi, mask);
        lo.delete(); hi.delete();
        return mask;
    },
    // 2. 放宽：更暗/更黄的纸（傍晚灯光、旧卷子）
    (cv, src, hsv) => {
        const mask = new cv.Mat();
        const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 85, 0]);
        const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 125, 255, 255]);
        cv.inRange(hsv, lo, hi, mask);
        lo.delete(); hi.delete();
        return mask;
    },
    // 3. Otsu 亮度自适应：纸通常比背景亮
    (cv, src, hsv, gray) => {
        const mask = new cv.Mat();
        cv.threshold(gray, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        // 若亮区反而是少数（深色卷子/深底白纸误判），反色取多数派之外的较亮侧
        const total = mask.rows * mask.cols;
        const bright = cv.countNonZero(mask);
        if (bright < total * 0.15) cv.bitwise_not(mask, mask); // 亮区太小可能是深色背景被压暗，反转试试
        return mask;
    },
];

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

/** 让出主线程，避免长任务连发时页面假死 */
function yieldToUI(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
}

/**
 * 一键切边矫正：输入 dataURL，成功返回矫正后的 dataURL，任何失败回退原图。
 * 注意：请在增强（增白）之前调用——分割依赖纸张与背景的原始对比度。
 */
export async function rectifyPaperImage(dataUrl: string, quality = 0.9): Promise<string> {
    try {
        const mod = await loadOpenCV();
        if (!mod) return dataUrl; // opencv 不可用，静默回退原图
        const cv = mod.cv;
        await yieldToUI(); // opencv 就绪后先让浏览器喘口气
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

        await yieldToUI();
        const quad = detectPaperQuad(cv, canvas);
        if (!quad) return dataUrl;
        await yieldToUI();
        const warped = warpPerspective(cv, canvas, quad);
        if (!warped) return dataUrl;
        return warped.toDataURL('image/jpeg', quality);
    } catch {
        return dataUrl;
    }
}
