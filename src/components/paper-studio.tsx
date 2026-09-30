"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    bakeExclusion,
    clearRowRange,
    computeContentSegments,
    createExclusionMask,
    fillPolygon,
    fillRectRange,
    fillRowRange,
    hitSegment,
    invertMask,
    maskBoundingBox,
    maskCoverage,
    paintLine,
    withPixelBuffer,
} from "@/lib/image-enhance";
import { loadOpenCV, detectPaperQuad, warpPerspective } from "@/lib/doc-detect";
import { Brush, Eraser, LassoSelect, Loader2, Rows3, Scissors, SquareDashed, Undo2 } from "lucide-react";

interface PaperStudioProps {
    imageSrc: string;
    open: boolean;
    onClose: () => void;
    onApply: (processedDataUrl: string) => void;
}

/** 工具：套索（默认）/ 矩形 / 笔刷 / 点选整段 */
type Tool = "lasso" | "rect" | "brush" | "segment";
/** 掩膜语义：exclude=涂掉多余的（红=不识别）；keep=只留所选的（变暗=不识别，完成时自动裁到所选范围） */
type MaskMode = "exclude" | "keep";
/** 落笔动作：涂抹 / 擦除 */
type PaintOp = "paint" | "erase";

const MAX_UNDO = 20;

/** 裁出 dataURL 的指定区域（原图像素坐标） */
async function cropDataUrl(src: string, box: { x: number; y: number; width: number; height: number }): Promise<string> {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("图片加载失败"));
        el.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = box.width;
    canvas.height = box.height;
    canvas.getContext("2d")?.drawImage(img, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    return canvas.toDataURL("image/jpeg", 0.92);
}

export function PaperStudio({ imageSrc, open, onClose, onApply }: PaperStudioProps) {
    const { t } = useLanguage();
    const ps = (key: string, fallback: string) =>
        (t.paperStudio as Record<string, string> | undefined)?.[key] || fallback;

    const [currentSrc, setCurrentSrc] = useState(imageSrc);
    const [segments, setSegments] = useState<[number, number][]>([]);
    const [excludedSegs, setExcludedSegs] = useState<Set<number>>(new Set());
    const [tool, setTool] = useState<Tool>("lasso");
    const [maskMode, setMaskMode] = useState<MaskMode>("exclude");
    const [paintOp, setPaintOp] = useState<PaintOp>("paint");
    const [brushSize, setBrushSize] = useState(40);
    const [busy, setBusy] = useState<null | "rectify" | "apply">(null);
    const [cvReady, setCvReady] = useState(false);
    const [coveragePct, setCoveragePct] = useState(0); // 底部“已标记 xx%”展示（mask 在 ref 里，收笔时同步）

    const imgRef = useRef<HTMLImageElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const maskRef = useRef<Uint8Array | null>(null);
    const undoStackRef = useRef<Uint8Array[]>([]);
    const paintingRef = useRef<{ x: number; y: number } | null>(null);
    const lassoRef = useRef<[number, number][] | null>(null);
    const rectRef = useRef<{ x: number; y: number } | null>(null);
    const snapshotRef = useRef<HTMLCanvasElement | null>(null);

    /** 当前落笔写入 mask 的值 */
    const paintValue = (): 0 | 1 => (paintOp === "paint" ? 1 : 0);

    /** 预览颜色：排除模式红，保留模式绿 */
    const previewColor = () => (maskMode === "exclude" ? "rgba(239, 68, 68, 0.9)" : "rgba(34, 197, 94, 0.9)");

    // 打开时初始化：分段检测 + mask + opencv 状态
    useEffect(() => {
        if (!open) return;
        setCurrentSrc(imageSrc);
        setExcludedSegs(new Set());
        setCoveragePct(0);
        undoStackRef.current = [];
        maskRef.current = null;
        loadOpenCV().then((mod) => setCvReady(!!mod)).catch(() => setCvReady(false));
    }, [open, imageSrc]);

    /** 全量重绘遮罩层：exclude 模式红色=排除；keep 模式变暗=不保留 */
    const redrawOverlay = useCallback(() => {
        const overlay = overlayRef.current;
        const mask = maskRef.current;
        const img = imgRef.current;
        if (!overlay || !mask || !img) return;
        const ctx = overlay.getContext("2d");
        if (!ctx) return;
        const W = overlay.width, H = overlay.height;
        const id = ctx.createImageData(W, H);
        if (maskMode === "exclude") {
            for (let i = 0; i < mask.length; i++) {
                if (mask[i]) {
                    id.data[i * 4] = 239; id.data[i * 4 + 1] = 68; id.data[i * 4 + 2] = 68; id.data[i * 4 + 3] = 110;
                }
            }
        } else {
            for (let i = 0; i < mask.length; i++) {
                if (!mask[i]) {
                    id.data[i * 4] = 15; id.data[i * 4 + 1] = 23; id.data[i * 4 + 2] = 42; id.data[i * 4 + 3] = 120;
                }
            }
        }
        ctx.putImageData(id, 0, 0);
    }, [maskMode]);

    // 模式切换后重绘遮罩（同一 mask 的显示语义变了）
    useEffect(() => { redrawOverlay(); }, [maskMode, redrawOverlay]);

    // 图片载入后建 mask + 检测分段
    const onImageLoad = useCallback(async () => {
        const img = imgRef.current;
        if (!img || !img.naturalWidth) return;
        const W = img.naturalWidth, H = img.naturalHeight;
        maskRef.current = createExclusionMask(W, H);
        const overlay = overlayRef.current;
        if (overlay) { overlay.width = W; overlay.height = H; }
        redrawOverlay();
        try {
            const segs = await withPixelBuffer(currentSrc, (buf) => computeContentSegments(buf));
            setSegments(segs);
        } catch {
            setSegments([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentSrc]);

    const pushUndo = useCallback(() => {
        const mask = maskRef.current;
        if (!mask) return;
        undoStackRef.current.push(new Uint8Array(mask));
        if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
    }, []);

    const handleUndo = () => {
        const prev = undoStackRef.current.pop();
        if (!prev || !maskRef.current) return;
        maskRef.current.set(prev);
        setCoveragePct(maskCoverage(maskRef.current));
        // 分段高亮状态与 mask 保持一致：直接按段中心点采样
        setExcludedSegs(() => {
            const next = new Set<number>();
            const img = imgRef.current;
            if (img) {
                segments.forEach(([top, bottom], i) => {
                    const midY = Math.floor(((top + bottom) / 2) * img.naturalHeight);
                    const midX = Math.floor(img.naturalWidth / 2);
                    if (maskRef.current![midY * img.naturalWidth + midX]) next.add(i);
                });
            }
            return next;
        });
        redrawOverlay();
    };

    const handleReset = () => {
        pushUndo();
        maskRef.current?.fill(0);
        setExcludedSegs(new Set());
        setCoveragePct(0);
        redrawOverlay();
    };

    /** 坐标换算：屏幕点 → 原图像素 */
    const toImageCoords = (e: React.PointerEvent): { x: number; y: number } | null => {
        const img = imgRef.current;
        if (!img) return null;
        const rect = img.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * img.naturalWidth;
        const y = ((e.clientY - rect.top) / rect.height) * img.naturalHeight;
        if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null;
        return { x, y };
    };

    /** 增量画笔刷圆点（涂抹过程不重绘全图）。写入值/模式决定是加色还是擦除。 */
    const drawOverlayCircle = (x: number, y: number, r: number) => {
        const ctx = overlayRef.current?.getContext("2d");
        if (!ctx) return;
        const addingMark = (maskMode === "exclude") === (paintValue() === 1);
        ctx.save();
        if (addingMark) {
            ctx.fillStyle = maskMode === "exclude" ? "rgba(239, 68, 68, 0.43)" : "rgba(15, 23, 42, 0.47)";
        } else {
            ctx.globalCompositeOperation = "destination-out";
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };

    /** 切换目标模式时清空 mask（同一批像素在两种模式下语义相反，带过去必然误导） */
    const switchMaskMode = (next: MaskMode) => {
        if (next === maskMode) return;
        pushUndo();
        maskRef.current?.fill(0);
        setExcludedSegs(new Set());
        setCoveragePct(0);
        setMaskMode(next);
    };

    const strokeWidth = () => Math.max(2, (imgRef.current?.naturalWidth || 1000) / 500);

    const handlePointerDown = (e: React.PointerEvent) => {
        const pt = toImageCoords(e);
        if (!pt) return;
        e.currentTarget.setPointerCapture(e.pointerId);

        if (tool === "segment") {
            const img = imgRef.current;
            if (!img || segments.length === 0) return;
            const idx = hitSegment(segments, pt.y / img.naturalHeight);
            if (idx < 0) return;
            pushUndo();
            const H = img.naturalHeight, W = img.naturalWidth;
            const mask = maskRef.current!;
            setExcludedSegs((prev) => {
                const next = new Set(prev);
                const [top, bottom] = segments[idx];
                if (next.has(idx)) {
                    next.delete(idx);
                    clearRowRange(mask, W, H, top * H, bottom * H);
                } else {
                    next.add(idx);
                    fillRowRange(mask, W, H, top * H, bottom * H);
                }
                return next;
            });
            setCoveragePct(maskCoverage(mask));
            redrawOverlay();
            return;
        }

        pushUndo();

        if (tool === "brush") {
            paintingRef.current = pt;
            paintLine(maskRef.current!, imgRef.current!.naturalWidth, imgRef.current!.naturalHeight, pt.x, pt.y, pt.x, pt.y, brushSize, paintValue());
            drawOverlayCircle(pt.x, pt.y, brushSize);
            return;
        }

        if (tool === "lasso") {
            lassoRef.current = [[pt.x, pt.y]];
            return;
        }

        // rect：拍一张遮罩快照，拖动时基于快照画预览框
        rectRef.current = pt;
        const overlay = overlayRef.current;
        if (overlay) {
            const snap = document.createElement("canvas");
            snap.width = overlay.width;
            snap.height = overlay.height;
            snap.getContext("2d")?.drawImage(overlay, 0, 0);
            snapshotRef.current = snap;
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const pt = toImageCoords(e);
        if (!pt) return;
        const img = imgRef.current!;
        const W = img.naturalWidth, H = img.naturalHeight;

        if (tool === "brush") {
            const last = paintingRef.current;
            if (!last) return;
            paintLine(maskRef.current!, W, H, last.x, last.y, pt.x, pt.y, brushSize, paintValue());
            drawOverlayCircle(pt.x, pt.y, brushSize);
            paintingRef.current = pt;
            return;
        }

        if (tool === "lasso") {
            const pts = lassoRef.current;
            if (!pts) return;
            const last = pts[pts.length - 1];
            const minDist = Math.max(W, H) / 400;
            if (Math.hypot(pt.x - last[0], pt.y - last[1]) < minDist) return;
            pts.push([pt.x, pt.y]);
            // 增量画预览线
            const ctx = overlayRef.current?.getContext("2d");
            if (ctx) {
                ctx.save();
                ctx.strokeStyle = previewColor();
                ctx.lineWidth = strokeWidth();
                ctx.lineJoin = "round";
                ctx.beginPath();
                ctx.moveTo(last[0], last[1]);
                ctx.lineTo(pt.x, pt.y);
                ctx.stroke();
                ctx.restore();
            }
            return;
        }

        // rect：恢复快照 + 画预览框
        const start = rectRef.current;
        const snap = snapshotRef.current;
        const ctx = overlayRef.current?.getContext("2d");
        if (!start || !snap || !ctx) return;
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(snap, 0, 0);
        ctx.save();
        ctx.strokeStyle = previewColor();
        ctx.lineWidth = strokeWidth();
        ctx.setLineDash([strokeWidth() * 3, strokeWidth() * 2]);
        ctx.strokeRect(Math.min(start.x, pt.x), Math.min(start.y, pt.y), Math.abs(pt.x - start.x), Math.abs(pt.y - start.y));
        ctx.restore();
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        const img = imgRef.current;
        if (!img) return;
        const W = img.naturalWidth, H = img.naturalHeight;

        if (tool === "brush") {
            paintingRef.current = null;
            if (maskMode === "keep") redrawOverlay(); // keep 模式笔刷增量画的是近似色，收尾统一重绘
            setCoveragePct(maskCoverage(maskRef.current!));
            return;
        }

        if (tool === "lasso") {
            const pts = lassoRef.current;
            lassoRef.current = null;
            if (pts && pts.length >= 3) {
                fillPolygon(maskRef.current!, W, H, pts, paintValue());
            }
            redrawOverlay();
            setCoveragePct(maskCoverage(maskRef.current!));
            return;
        }

        if (tool === "rect") {
            const start = rectRef.current;
            rectRef.current = null;
            snapshotRef.current = null;
            const pt = toImageCoords(e);
            if (start && pt && (Math.abs(pt.x - start.x) > W / 200 || Math.abs(pt.y - start.y) > H / 200)) {
                fillRectRange(maskRef.current!, W, H, start.x, start.y, pt.x, pt.y, paintValue());
            }
            redrawOverlay();
            setCoveragePct(maskCoverage(maskRef.current!));
        }
    };

    /** 自动切边 + 透视矫正 */
    const handleRectify = async () => {
        setBusy("rectify");
        try {
            const mod = await loadOpenCV();
            const img = imgRef.current;
            if (!mod || !img) {
                alert(ps("rectifyFailed", "未检测到纸张边缘，保持原图"));
                return;
            }
            const cv = mod.cv;
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d")?.drawImage(img, 0, 0);
            const quad = detectPaperQuad(cv, canvas);
            if (!quad) {
                alert(ps("rectifyFailed", "未检测到纸张边缘，保持原图"));
                return;
            }
            const warped = warpPerspective(cv, canvas, quad);
            if (!warped) return;
            setCurrentSrc(warped.toDataURL("image/jpeg", 0.9)); // onImageLoad 会重建 mask 和分段
            setExcludedSegs(new Set());
            undoStackRef.current = [];
        } catch {
            alert(ps("rectifyFailed", "未检测到纸张边缘，保持原图"));
        } finally {
            setBusy(null);
        }
    };

    const handleApply = async () => {
        setBusy("apply");
        try {
            const mask = maskRef.current;
            if (!mask || maskCoverage(mask) < 0.001) {
                onApply(currentSrc); // 没涂任何东西，直接用当前图（可能已切边）
                return;
            }
            if (maskMode === "keep") {
                // 只留所选：排除 = 保留区的补集；完成后自动裁到所选范围
                const img = imgRef.current!;
                const W = img.naturalWidth, H = img.naturalHeight;
                const baked = await bakeExclusion(currentSrc, invertMask(mask));
                const box = maskBoundingBox(mask, W, H, 0.02);
                onApply(box ? await cropDataUrl(baked, box) : baked);
                return;
            }
            onApply(await bakeExclusion(currentSrc, mask));
        } finally {
            setBusy(null);
        }
    };

    const coverage = coveragePct;
    const toolBtn = (t0: Tool, Icon: typeof Brush, label: string) => (
        <button
            key={t0}
            type="button"
            onClick={() => setTool(t0)}
            className={`px-3 py-1.5 flex items-center gap-1 ${tool === t0 ? "bg-primary text-primary-foreground" : "bg-background"}`}
        >
            <Icon className="h-4 w-4" />{label}
        </button>
    );

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{ps("title", "试卷优化与选题")}</DialogTitle>
                </DialogHeader>

                {/* 工具栏 */}
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    {/* 目标模式：涂掉多余 / 只留所选 */}
                    <div className="flex rounded-md border overflow-hidden">
                        <button
                            type="button"
                            onClick={() => switchMaskMode("exclude")}
                            className={`px-3 py-1.5 ${maskMode === "exclude" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                        >
                            {ps("modeExclude", "涂掉多余")}
                        </button>
                        <button
                            type="button"
                            onClick={() => switchMaskMode("keep")}
                            className={`px-3 py-1.5 ${maskMode === "keep" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                        >
                            {ps("modeKeep", "只留所选")}
                        </button>
                    </div>

                    {/* 工具：套索 / 矩形 / 笔刷 / 整段 */}
                    <div className="flex rounded-md border overflow-hidden">
                        {toolBtn("lasso", LassoSelect, ps("toolLasso", "套索"))}
                        {toolBtn("rect", SquareDashed, ps("toolRect", "矩形"))}
                        {toolBtn("brush", Brush, ps("toolBrush", "笔刷"))}
                        {toolBtn("segment", Rows3, ps("toolSegment", "整段"))}
                    </div>

                    {/* 涂抹 / 擦除（整段工具不需要） */}
                    {tool !== "segment" && (
                        <div className="flex rounded-md border overflow-hidden">
                            <button
                                type="button"
                                onClick={() => setPaintOp("paint")}
                                className={`px-3 py-1.5 ${paintOp === "paint" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                            >
                                {ps("opPaint", "涂抹")}
                            </button>
                            <button
                                type="button"
                                onClick={() => setPaintOp("erase")}
                                className={`px-3 py-1.5 ${paintOp === "erase" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                            >
                                {ps("opErase", "擦除")}
                            </button>
                        </div>
                    )}

                    {tool === "brush" && (
                        <label className="flex items-center gap-2 text-xs">
                            {ps("brushSize", "笔刷")}
                            <input
                                type="range" min={10} max={120} value={brushSize}
                                onChange={(e) => setBrushSize(Number(e.target.value))}
                                className="w-20 accent-primary"
                            />
                        </label>
                    )}

                    <Button variant="outline" size="sm" onClick={handleUndo}>
                        <Undo2 className="h-4 w-4 mr-1" />{ps("undo", "撤销")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleReset}>
                        <Eraser className="h-4 w-4 mr-1" />{ps("reset", "重置")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleRectify} disabled={busy !== null || !cvReady}>
                        {busy === "rectify" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Scissors className="h-4 w-4 mr-1" />}
                        {cvReady ? ps("rectify", "自动切边") : ps("rectifyLoading", "切边组件加载中…")}
                    </Button>
                </div>

                {/* 提示行 */}
                <div className="text-xs text-muted-foreground">
                    {maskMode === "exclude"
                        ? (tool === "segment"
                            ? (segments.length > 0
                                ? ps("segmentHintExclude", "点一下段落即可排除/恢复（红色 = 不识别）")
                                : ps("noSegments", "未检测到分段，可换用套索/矩形"))
                            : ps("excludeHint", "圈出/涂抹不需要的区域（红色 = 不识别）"))
                        : (tool === "segment"
                            ? (segments.length > 0
                                ? ps("segmentHintKeep", "点一下段落即可保留/取消（只识别未变暗的区域）")
                                : ps("noSegments", "未检测到分段，可换用套索/矩形"))
                            : ps("keepHint", "圈出要保留的题目（只识别未变暗区域，完成后自动裁到所选范围）"))}
                </div>

                {/* 图片编辑区 */}
                <div className="relative flex-1 min-h-0 overflow-auto rounded border bg-muted/30">
                    <div className="relative inline-block w-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img ref={imgRef} src={currentSrc} onLoad={onImageLoad} alt="paper" className="w-full h-auto block select-none" draggable={false} />
                        <canvas
                            ref={overlayRef}
                            className="absolute inset-0 w-full h-full touch-none"
                            style={{ cursor: tool === "segment" ? "pointer" : "crosshair" }}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerUp}
                        />
                        {/* 整段模式下的分隔线提示 */}
                        {tool === "segment" && segments.map(([top], i) => (
                            <div key={i} className="absolute left-0 right-0 pointer-events-none border-t border-dashed border-primary/60" style={{ top: `${top * 100}%` }} />
                        ))}
                    </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-xs text-muted-foreground">
                        {coverage > 0.001
                            ? (maskMode === "exclude"
                                ? ps("excludedInfo", "已标记 {pct} 不识别").replace("{pct}", `${Math.round(coverage * 100)}%`)
                                : ps("keptInfo", "已选留 {pct}").replace("{pct}", `${Math.round(coverage * 100)}%`))
                            : " "}
                    </span>
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={onClose}>{t.common?.cancel || "取消"}</Button>
                        <Button onClick={handleApply} disabled={busy !== null}>
                            {busy === "apply" && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                            {ps("apply", "完成")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
