"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type ProgressStatus = 'compressing' | 'uploading' | 'analyzing' | 'processing' | 'saving' | 'idle';

interface ProgressFeedbackProps {
    status: ProgressStatus;
    progress?: number;
    message?: string;
    className?: string;
    /** 当前调用的 AI 模型名（如 "Kimi · k3-256k"） */
    modelName?: string;
    /** 分析阶段的轮转子步骤文案（每 3.5s 轮播一条，循环） */
    rotatingMessages?: string[];
    /** 取消按钮（后台任务场景：用户可主动放弃等待） */
    onCancel?: () => void;
    cancelLabel?: string;
}

import { useLanguage } from "@/contexts/LanguageContext";

export function ProgressFeedback({ status, progress, message, className, modelName, rotatingMessages, onCancel, cancelLabel }: ProgressFeedbackProps) {
    const { t } = useLanguage();
    // 确保只在客户端挂载完成后才渲染遮罩层，防止 SSR/Hydration 问题
    const [isMounted, setIsMounted] = useState(false);
    const [rotateIdx, setRotateIdx] = useState(0);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    // 子步骤轮播
    useEffect(() => {
        if (status === 'idle' || !rotatingMessages || rotatingMessages.length === 0) return;
        setRotateIdx(0);
        const timer = setInterval(() => {
            setRotateIdx((i) => (i + 1) % rotatingMessages.length);
        }, 3500);
        return () => clearInterval(timer);
    }, [status, rotatingMessages]);

    // 已等待时长（墙钟时间：后台被浏览器冻结的时段也计入，切回来直接显示真实耗时）
    const [elapsed, setElapsed] = useState(0);
    const startTsRef = useRef<number>(0);
    useEffect(() => {
        if (status === 'idle') return;
        startTsRef.current = Date.now();
        setElapsed(0);
        const tick = () => setElapsed(Math.floor((Date.now() - startTsRef.current) / 1000));
        const timer = setInterval(tick, 1000);
        // 从后台切回时立即刷新（后台 interval 被节流/冻结）
        document.addEventListener('visibilitychange', tick);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', tick);
        };
    }, [status]);
    const elapsedText = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

    // 只有在客户端挂载完成且 status 不为 idle 时才渲染
    if (!isMounted || status === 'idle') return null;

    return (
        <div className={cn(
            "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm",
            className
        )}>
            <div className="w-full max-w-md p-6 space-y-6 bg-card rounded-lg border shadow-lg mx-4">
                <div className="flex flex-col items-center justify-center space-y-4 text-center">
                    <div className="relative">
                        <Loader2 className="h-12 w-12 animate-spin text-primary" />
                        <div className="absolute inset-0 flex items-center justify-center">
                            {/* Optional: Add an icon inside the spinner if needed */}
                        </div>
                    </div>

                    <div className="space-y-2 w-full">
                        {modelName && (
                            <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                                <span className="inline-block px-2 py-0.5 rounded-full border bg-muted">🤖 {modelName}</span>
                            </p>
                        )}
                        <h3 className="text-lg font-semibold tracking-tight">
                            {message}
                        </h3>
                        {progress !== undefined && (
                            <Progress value={progress} className="h-2 w-full" />
                        )}
                        {rotatingMessages && rotatingMessages.length > 0 && (
                            <p key={rotateIdx} className="text-sm text-muted-foreground animate-in fade-in">
                                {rotatingMessages[rotateIdx]}
                            </p>
                        )}
                    </div>

                    <p className="text-sm text-muted-foreground">
                        {progress !== undefined ? `${Math.round(progress)}%` : (t.common.pleaseWait || 'Please wait...')}
                        {` · ${elapsedText}`}
                    </p>

                    {onCancel && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className="text-xs text-muted-foreground underline underline-offset-2"
                        >
                            {cancelLabel || '取消'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

