"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    applyExclusionMask,
    bakeExclusion,
    clearRowRange,
    computeContentSegments,
    createExclusionMask,
    fillRowRange,
    hitSegment,
    maskCoverage,
    paintLine,
    withPixelBuffer,
    type PixelBuffer,
} from "@/lib/image-enhance";
import { loadOpenCV, detectPaperQuad, warpPerspective } from "@/lib/doc-detect";
import { Brush, Eraser, Loader2, Rows3, Scissors, Undo2 } from "lucide-react";

interface PaperStudioProps {
    imageSrc: string;
    open: boolean;
    onClose: () => void;
    onApply: (processedDataUrl: string) => void;
}

type Mode = "segments" | "brush";

const MAX_UNDO = 20;

export function PaperStudio({ imageSrc, open, onClose, onApply }: PaperStudioProps) {
    const { t } = useLanguage();
    const ps = (key: string, fallback: string) =>
        (t.paperStudio as Record<string, string> | undefined)?.[key] || fallback;

    const [currentSrc, setCurrentSrc] = useState(imageSrc);
    const [segments, setSegments] = useState<[number, number][]>([]);
    const [excludedSegs, setExcludedSegs] = useState<Set<number>>(new Set());
    const [mode, setMode] = useState<Mode>("segments");
    const [brushSize, setBrushSize] = useState(40);
    const [busy, setBusy] = useState<null | "rectify" | "apply">(null);
    const [cvReady, setCvReady] = useState(false);

    const imgRef = useRef<HTMLImageElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const maskRef = useRef<Uint8Array | null>(null);
    const undoStackRef = useRef<Uint8Array[]>([]);
    const paintingRef = useRef<{ x: number; y: number } | null>(null);
    const [, forceRedraw] = useState(0);

    // 打开时初始化：分段检测 + mask + opencv 状态
    useEffect(() => {
        if (!open) return;
        setCurrentSrc(imageSrc);
        setExcludedSegs(new Set());
        undoStackRef.current = [];
        maskRef.current = null;
        loadOpenCV().then(() => setCvReady(true)).catch(() => setCvReady(false));
    }, [open, imageSrc]);

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

    /** 全量重绘遮罩层（撤销/分段切换时用；涂抹过程中走增量绘制） */
    const redrawOverlay = useCallback(() => {
        const overlay = overlayRef.current;
        const mask = maskRef.current;
        const img = imgRef.current;
        if (!overlay || !mask || !img) return;
        const ctx = overlay.getContext("2d");
        if (!ctx) return;
        const W = overlay.width, H = overlay.height;
        const id = ctx.createImageData(W, H);
        for (let i = 0; i < mask.length; i++) {
            if (mask[i]) {
                id.data[i * 4] = 239; id.data[i * 4 + 1] = 68; id.data[i * 4 + 2] = 68; id.data[i * 4 + 3] = 110;
            }
        }
        ctx.putImageData(id, 0, 0);
    }, []);

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
        // 分段高亮状态与 mask 保持一致：直接按段中心点采样
        setExcludedSegs((prevSegs) => {
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

    /** 增量画红遮罩（涂抹过程不重绘全图） */
    const drawOverlayCircle = (x: number, y: number, r: number) => {
        const ctx = overlayRef.current?.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "rgba(239, 68, 68, 0.43)";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        const pt = toImageCoords(e);
        if (!pt) return;
        e.currentTarget.setPointerCapture(e.pointerId);

        if (mode === "segments") {
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
            redrawOverlay();
            return;
        }

        // brush 模式
        pushUndo();
        paintingRef.current = pt;
        paintLine(maskRef.current!, imgRef.current!.naturalWidth, imgRef.current!.naturalHeight, pt.x, pt.y, pt.x, pt.y, brushSize);
        drawOverlayCircle(pt.x, pt.y, brushSize);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (mode !== "brush") return;
        const last = paintingRef.current;
        if (!last) return;
        const pt = toImageCoords(e);
        if (!pt) return;
        const img = imgRef.current!;
        paintLine(maskRef.current!, img.naturalWidth, img.naturalHeight, last.x, last.y, pt.x, pt.y, brushSize);
        drawOverlayCircle(pt.x, pt.y, brushSize);
        paintingRef.current = pt;
    };

    const handlePointerUp = () => {
        paintingRef.current = null;
    };

    /** 二期：自动切边 + 透视矫正 */
    const handleRectify = async () => {
        setBusy("rectify");
        try {
            const cv = await loadOpenCV();
            const img = imgRef.current;
            if (!img) return;
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
            const baked = await bakeExclusion(currentSrc, mask);
            onApply(baked);
        } finally {
            setBusy(null);
        }
    };

    const excludedCount = excludedSegs.size;

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{ps("title", "试卷优化与选题")}</DialogTitle>
                </DialogHeader>

                {/* 工具栏 */}
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    <div className="flex rounded-md border overflow-hidden">
                        <button
                            type="button"
                            onClick={() => setMode("segments")}
                            className={`px-3 py-1.5 flex items-center gap-1 ${mode === "segments" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                        >
                            <Rows3 className="h-4 w-4" />{ps("segmentMode", "点选整段")}
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode("brush")}
                            className={`px-3 py-1.5 flex items-center gap-1 ${mode === "brush" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                        >
                            <Brush className="h-4 w-4" />{ps("brushMode", "涂抹")}
                        </button>
                    </div>

                    {mode === "brush" && (
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

                    <span className="text-xs text-muted-foreground ml-auto">
                        {mode === "segments"
                            ? (segments.length > 0
                                ? ps("segmentHint", "点一下段落即可排除/恢复（红色 = 不识别）")
                                : ps("noSegments", "未检测到分段，可切换涂抹模式"))
                            : ps("brushHint", "涂抹不需要的区域（红色 = 不识别）")}
                    </span>
                </div>

                {/* 图片编辑区 */}
                <div className="relative flex-1 min-h-0 overflow-auto rounded border bg-muted/30">
                    <div className="relative inline-block w-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img ref={imgRef} src={currentSrc} onLoad={onImageLoad} alt="paper" className="w-full h-auto block select-none" draggable={false} />
                        <canvas
                            ref={overlayRef}
                            className="absolute inset-0 w-full h-full touch-none"
                            style={{ cursor: mode === "brush" ? "crosshair" : "pointer" }}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerUp}
                        />
                        {/* 分段模式下的分隔线提示 */}
                        {mode === "segments" && segments.map(([top, bottom], i) => (
                            <div key={i} className="absolute left-0 right-0 pointer-events-none border-t border-dashed border-primary/60" style={{ top: `${top * 100}%` }} />
                        ))}
                    </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-xs text-muted-foreground">
                        {excludedCount > 0 ? ps("excludedInfo", "已排除 {count} 段").replace("{count}", String(excludedCount)) : " "}
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
