"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Eraser, Undo2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

interface Point { x: number; y: number }
type Stroke = Point[];

/**
 * 手写演算画板：为墨水屏手写笔（Boox NeoBrowser / Pointer Events）设计。
 * - touch-action: none 防止书写时页面滚动
 * - 纯黑 3px 线条，白底，无动画（e-ink 高对比）
 * - 笔迹只存在内存（草稿性质），支持撤销/清空
 */
export function SketchPad({ height = 320, className = "" }: { height?: number; className?: string }) {
    const { t } = useLanguage();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const strokesRef = useRef<Stroke[]>([]);
    const currentRef = useRef<Stroke | null>(null);
    const drawingRef = useRef(false);
    const [strokeCount, setStrokeCount] = useState(0);

    /** 重绘全部笔迹 */
    const redraw = useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const stroke of strokesRef.current) {
            if (stroke.length < 2) {
                // 单点（点一下）
                if (stroke.length === 1) {
                    ctx.beginPath();
                    ctx.arc(stroke[0].x, stroke[0].y, 1.5, 0, Math.PI * 2);
                    ctx.fillStyle = "#000000";
                    ctx.fill();
                }
                continue;
            }
            ctx.beginPath();
            ctx.moveTo(stroke[0].x, stroke[0].y);
            for (let i = 1; i < stroke.length; i++) {
                ctx.lineTo(stroke[i].x, stroke[i].y);
            }
            ctx.stroke();
        }
    }, []);

    // 初始化画布尺寸（跟随容器宽度，按 devicePixelRatio 保证清晰）
    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;
        const resize = () => {
            const w = container.clientWidth;
            const dpr = window.devicePixelRatio || 1;
            canvas.width = w * dpr;
            canvas.height = height * dpr;
            canvas.style.width = `${w}px`;
            canvas.style.height = `${height}px`;
            const ctx = canvas.getContext("2d");
            ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
            redraw();
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(container);
        return () => ro.disconnect();
    }, [height, redraw]);

    const getPos = (e: React.PointerEvent): Point => {
        const rect = canvasRef.current!.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onPointerDown = (e: React.PointerEvent) => {
        if (!e.isPrimary) return;
        drawingRef.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        currentRef.current = [getPos(e)];
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (!drawingRef.current || !e.isPrimary || !currentRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const p = getPos(e);
        const stroke = currentRef.current;
        const last = stroke[stroke.length - 1];
        stroke.push(p);
        // 增量绘制，避免每次全量重绘（e-ink 上流畅些）
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
    };

    const onPointerUp = (e: React.PointerEvent) => {
        if (!drawingRef.current || !e.isPrimary) return;
        drawingRef.current = false;
        if (currentRef.current) {
            strokesRef.current.push(currentRef.current);
            currentRef.current = null;
            setStrokeCount(strokesRef.current.length);
        }
    };

    const undo = () => {
        strokesRef.current.pop();
        setStrokeCount(strokesRef.current.length);
        redraw();
    };

    const clear = () => {
        strokesRef.current = [];
        setStrokeCount(0);
        redraw();
    };

    return (
        <div className={`space-y-2 ${className}`}>
            <div ref={containerRef} className="w-full">
                <canvas
                    ref={canvasRef}
                    className="w-full border-2 border-foreground/70 rounded-lg bg-white cursor-crosshair"
                    style={{ touchAction: "none", height }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                />
            </div>
            <div className="flex gap-2 justify-end">
                <Button type="button" variant="outline" size="sm" onClick={undo} disabled={strokeCount === 0}>
                    <Undo2 className="mr-1 h-3.5 w-3.5" />
                    {t.sketch?.undo || "撤销"}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={clear} disabled={strokeCount === 0}>
                    <Eraser className="mr-1 h-3.5 w-3.5" />
                    {t.sketch?.clear || "清空"}
                </Button>
            </div>
        </div>
    );
}
