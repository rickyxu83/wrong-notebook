"use client";

import { useRef, useCallback } from "react";

/**
 * 整卷拆分的切线编辑器：在整页原图上叠加可拖拽的横向切线。
 * AI + 空白带算法给出初始位置，用户可拖动微调，所见即所得。
 * boundaries 为归一化 0-1 比例（N+1 条，含页顶和页底）。
 */
interface PageCutEditorProps {
    imageUrl: string;
    boundaries: number[];
    onChange: (boundaries: number[]) => void;
}

const MIN_GAP = 0.01; // 相邻切线最小间距（1% 页高）

export function PageCutEditor({ imageUrl, boundaries, onChange }: PageCutEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const dragIndexRef = useRef<number | null>(null);

    const updateFromPointer = useCallback((clientY: number) => {
        const idx = dragIndexRef.current;
        const el = containerRef.current;
        if (idx === null || !el) return;
        const rect = el.getBoundingClientRect();
        let frac = (clientY - rect.top) / rect.height;
        // 夹在相邻切线之间
        const lo = (boundaries[idx - 1] ?? 0) + MIN_GAP;
        const hi = (boundaries[idx + 1] ?? 1) - MIN_GAP;
        frac = Math.min(hi, Math.max(lo, frac));
        const next = [...boundaries];
        next[idx] = frac;
        onChange(next);
    }, [boundaries, onChange]);

    return (
        <div
            ref={containerRef}
            className="relative select-none w-full border rounded-lg overflow-hidden"
        >
            <img src={imageUrl} alt="整页原图" className="w-full block pointer-events-none" draggable={false} />
            {boundaries.map((b, i) => (
                <div
                    key={i}
                    className="absolute left-0 right-0 cursor-row-resize touch-none group"
                    style={{ top: `${b * 100}%`, height: 24, transform: "translateY(-50%)" }}
                    onPointerDown={(e) => {
                        dragIndexRef.current = i;
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                        if (dragIndexRef.current === i) updateFromPointer(e.clientY);
                    }}
                    onPointerUp={() => { dragIndexRef.current = null; }}
                    onPointerCancel={() => { dragIndexRef.current = null; }}
                >
                    {/* 可见切线 */}
                    <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-0.5 bg-red-500 group-hover:bg-red-600" />
                    {/* 标签 */}
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded">
                        {i === 0 ? "顶" : i === boundaries.length - 1 ? "底" : `切${i}`}
                    </div>
                </div>
            ))}
        </div>
    );
}
