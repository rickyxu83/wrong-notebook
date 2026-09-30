"use client";

import { useState, Suspense, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { UploadZone } from "@/components/upload-zone";
import { CorrectionEditor } from "@/components/correction-editor";
import { ParsedQuestion } from "@/lib/ai";
import { UserWelcome } from "@/components/user-welcome";
import { apiClient } from "@/lib/api-client";
import { AnalyzeResponse, Notebook, AppConfig } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import { enhancePaperImage } from "@/lib/image-enhance";
import { preloadOpenCV, rectifyPaperImage } from "@/lib/doc-detect";
import { PaperStudio } from "@/components/paper-studio";
import { Upload, BookOpen, Tags, LogOut, BarChart3, PenLine, Loader2 } from "lucide-react";
import { SettingsDialog } from "@/components/settings-dialog";
import { BroadcastNotification } from "@/components/broadcast-notification";
import { signOut } from "next-auth/react";

import { ProgressFeedback, ProgressStatus } from "@/components/ui/progress-feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { TextInputZone } from "@/components/text-input-zone";
import { DirectTextEditor } from "@/components/direct-text-editor";
import { MultiQuestionReview } from "@/components/multi-question-review";

function HomeContent() {
    const [step, setStep] = useState<"upload" | "review" | "multi-review">("upload");
    const [analysisStep, setAnalysisStep] = useState<ProgressStatus>('idle');
    const [progress, setProgress] = useState(0);
    const [parsedData, setParsedData] = useState<ParsedQuestion | null>(null);
    // 整卷拆分：AI 识别出多道题时进入批量确认页
    const [parsedQuestions, setParsedQuestions] = useState<ParsedQuestion[]>([]);
    // 连续扫描：待解析的页面队列（多页一次调用）
    const [pendingPages, setPendingPages] = useState<string[]>([]);
    const [studioIndex, setStudioIndex] = useState<number | null>(null); // 打开纸张工作室的页码
    const [rectifyingPages, setRectifyingPages] = useState<Set<string>>(new Set()); // 后台切边处理中的页
    // 本次分析的页面图（供确认页裁切/预览用）
    const [pageImages, setPageImages] = useState<string[]>([]);
    // 分析失败的内联错误（不用 alert，墨水屏上弹窗体验差）
    const [analyzeError, setAnalyzeError] = useState<string | null>(null);
    // 后台任务轮询中标记：抑制安全超时误关遮罩
    const analyzeJobActiveRef = useRef(false);
    // 停止轮询函数（取消按钮用）
    const analyzeJobStopRef = useRef<(() => void) | null>(null);
    const [currentImage, setCurrentImage] = useState<string | null>(null);
    const { t, language } = useLanguage();
    const searchParams = useSearchParams();
    const router = useRouter();
    const initialNotebookId = searchParams.get("notebook");
    const [notebooks, setNotebooks] = useState<{ id: string; name: string }[]>([]);
    const [autoSelectedNotebookId, setAutoSelectedNotebookId] = useState<string | null>(null);

    const [config, setConfig] = useState<AppConfig | null>(null);

    // Input mode: "image" for photo upload, "text" for AI solve, "direct" for manual entry
    const [inputMode, setInputMode] = useState<"image" | "text" | "direct">("image");

    // Timeout Config
    const aiTimeout = config?.timeouts?.analyze || 180000;
    const safetyTimeout = aiTimeout + 10000;

    useEffect(() => {
        // Fetch notebooks for auto-selection
        apiClient.get<Notebook[]>("/api/notebooks")
            .then(data => setNotebooks(data))
            .catch(err => console.error("Failed to fetch notebooks:", err));

        // Fetch settings for timeouts
        apiClient.get<AppConfig>("/api/settings")
            .then(data => {
                setConfig(data);
                if (data.timeouts?.analyze) {
                    frontendLogger.info('[Config]', 'Loaded timeout settings', {
                        analyze: data.timeouts.analyze
                    });
                }
            })
            .catch(err => console.error("Failed to fetch config:", err));
    }, []);

    // 页面恢复：只恢复本浏览器发起的任务（sessionStorage 记录 jobId）。
    // 黑屏/误刷新不丢进度；不会捞到别的设备或旧会话的任务（共享账号场景关键）。
    useEffect(() => {
        const jobId = sessionStorage.getItem('analyzeJobId');
        if (!jobId) return;
        apiClient.get<any>(`/api/analyze/jobs/${jobId}?includePages=1`)
            .then(async (job) => {
                if (job.consumedAt) {
                    sessionStorage.removeItem('analyzeJobId');
                    return;
                }
                if (Date.now() - new Date(job.createdAt).getTime() > 30 * 60 * 1000) {
                    sessionStorage.removeItem('analyzeJobId');
                    return;
                }
                if (job.pages?.length) {
                    setPendingPages(job.pages);
                    setPageImages(job.pages);
                    setCurrentImage(job.pages[0]);
                }
                if (job.status === 'pending' || job.status === 'running') {
                    setAnalysisStep('analyzing');
                    // 看门狗以任务创建时间为准（不是恢复时间），尸体任务不会无限转圈
                    pollAnalyzeJob(job.id, new Date(job.createdAt).getTime());
                } else if (job.status === 'done') {
                    sessionStorage.removeItem('analyzeJobId');
                    await apiClient.post(`/api/analyze/jobs/${job.id}/consume`, {}).catch(() => { });
                    if (job.questions?.length) {
                        handleAnalyzeResult(job.questions, Date.now());
                    }
                } else if (job.status === 'failed') {
                    sessionStorage.removeItem('analyzeJobId');
                    await apiClient.post(`/api/analyze/jobs/${job.id}/consume`, {}).catch(() => { });
                    setAnalyzeError(mapAnalyzeError(job.error || ''));
                }
            })
            .catch(() => {
                sessionStorage.removeItem('analyzeJobId');
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Simulate progress for smoother UX with timeout protection
    useEffect(() => {
        let interval: NodeJS.Timeout;
        let timeout: NodeJS.Timeout;
        if (analysisStep !== 'idle') {
            setProgress(0);
            interval = setInterval(() => {
                setProgress(prev => {
                    if (prev >= 90) return prev; // Cap at 90% until complete
                    return prev + Math.random() * 10;
                });
            }, 500);

            // Safety timeout: auto-reset after configurable time to prevent stuck overlay
            // 后台任务轮询期间不生效（服务端还在跑，遮罩消失会造成“已完成”的错觉）
            timeout = setTimeout(() => {
                if (analyzeJobActiveRef.current) return;
                console.warn('[Progress] Safety timeout triggered - resetting analysisStep');
                setAnalysisStep('idle');
            }, safetyTimeout);
        }
        return () => {
            clearInterval(interval);
            clearTimeout(timeout);
        };
    }, [analysisStep, safetyTimeout]);

    const onImageSelect = async (file: File) => {
        // 单张也直进自动管线（切边+增强全自动），不再拦路弹矩形裁剪框；
        // 需要细裁/选题时点暂存条缩略图进纸张工作室。
        try {
            await enhanceAndStage(file);
        } catch (e) {
            console.error(e);
            alert(t.common?.messages?.analysisFailed || '图片处理失败');
        }
    };

    /**
     * 统一入队管道：压缩 → 纸张增强（亮度/增白/锐化）→ 暂存；
     * 后台懒加载 opencv 成功后自动尝试切边矫正，找到纸张轮廓就替换该页。
     */
    const enhanceAndStage = async (file: File): Promise<void> => {
        const base64Image = await processImageFile(file);
        const enhanced = await enhancePaperImage(base64Image);
        setPendingPages((prev) => [...prev, enhanced]);
        preloadOpenCV();
        // 切边必须在增强前做（HSV 分割依赖纸张与背景的原始对比度），切完再重新增强
        setRectifyingPages((prev) => new Set(prev).add(enhanced));
        rectifyPaperImage(base64Image).then(async (rect) => {
            if (rect === base64Image) return; // 没找到纸张轮廓，保持增强版
            const reEnhanced = await enhancePaperImage(rect);
            setPendingPages((prev) => prev.map((p) => (p === enhanced ? reEnhanced : p)));
        }).catch(() => { /* 切边失败静默回退 */ })
            .finally(() => setRectifyingPages((prev) => { const next = new Set(prev); next.delete(enhanced); return next; }));
    };

    /** 多选/多拖整页：逐张压缩后直接入暂存队列（不逐张进裁剪器） */
    const onImagesSelect = async (files: File[]) => {
        for (const file of files.slice(0, 10)) {
            try {
                await enhanceAndStage(file);
            } catch (e) {
                console.error(e);
            }
        }
    };

    /** 开始解析暂存的所有页（单页或多页） */
    const startAnalysis = () => {
        if (pendingPages.length === 0 || analysisStep !== 'idle') return;
        setAnalyzeError(null);
        handleAnalyzePages(pendingPages);
    };

    /** 把 AI 错误码映射为可读文案 */
    const mapAnalyzeError = (msg: string): string => {
        if (!msg) return t.common?.messages?.analysisFailed || 'AI 分析失败，请重试';
        if (t.errors && typeof t.errors === 'object' && msg in t.errors) {
            const mapped = (t.errors as any)[msg];
            if (typeof mapped === 'string') return mapped;
        }
        if (msg.startsWith('AI_')) return t.errors?.AI_UNKNOWN_ERROR || msg;
        return msg;
    };

    const handleAnalyzePages = async (pages: string[]) => {
        const startTime = Date.now();
        try {
            frontendLogger.info('[HomeAnalyze]', 'Submitting background analyze job', { pages: pages.length });
            setAnalysisStep('analyzing');
            setCurrentImage(pages[0]);
            setPageImages(pages);

            // 后台任务模式：服务端执行 AI 分析，浏览器黑屏/切后台/断网都不中断
            const { jobId } = await apiClient.post<{ jobId: string }>("/api/analyze/jobs", {
                images: pages, // 多页一次调用，AI 可关联跨页题目
                language: language,
                subjectId: initialNotebookId || autoSelectedNotebookId || undefined,
            });
            frontendLogger.info('[HomeAnalyze]', 'Analyze job created', { jobId, pages: pages.length });
            sessionStorage.setItem('analyzeJobId', jobId); // 供黑屏/刷新后恢复，且只恢复本会话的任务
            pollAnalyzeJob(jobId, startTime);
        } catch (error: any) {
            frontendLogger.error('[HomeError]', 'Failed to create analyze job', { error: error?.message });
            setAnalysisStep('idle');
            setAnalyzeError(mapAnalyzeError(error?.data?.message || error?.message || ''));
        }
    };

    /** 取消后台分析任务：停止轮询、取走标记、清会话记录；页图保留在暂存条可重试 */
    const cancelAnalyzeJob = () => {
        analyzeJobStopRef.current?.();
        analyzeJobActiveRef.current = false;
        const jobId = sessionStorage.getItem('analyzeJobId');
        sessionStorage.removeItem('analyzeJobId');
        if (jobId) apiClient.post(`/api/analyze/jobs/${jobId}/consume`, {}).catch(() => { });
        setAnalysisStep('idle');
    };

    /** 轮询分析任务；单次失败（黑屏恢复等）下个周期自动重试；切回前台立即补查；超 15 分钟判定超时 */
    const pollAnalyzeJob = (jobId: string, startTime: number) => {
        analyzeJobActiveRef.current = true;
        const stop = () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
            analyzeJobActiveRef.current = false;
            analyzeJobStopRef.current = null;
        };
        const check = async () => {
            try {
                // 看门狗：任务超过 15 分钟未结束（AI 卡死/连接静默挂起），判定超时
                if (Date.now() - startTime > 15 * 60 * 1000) {
                    stop();
                    sessionStorage.removeItem('analyzeJobId');
                    apiClient.post(`/api/analyze/jobs/${jobId}/consume`, {}).catch(() => { });
                    setAnalysisStep('idle');
                    setAnalyzeError(t.errors?.AI_TIMEOUT_ERROR || 'AI 响应超时，请重试（页数多时可分批上传）');
                    return;
                }
                const job = await apiClient.get<any>(`/api/analyze/jobs/${jobId}`);
                if (job.status === 'done' && job.questions) {
                    stop();
                    sessionStorage.removeItem('analyzeJobId');
                    apiClient.post(`/api/analyze/jobs/${jobId}/consume`, {}).catch(() => { });
                    handleAnalyzeResult(job.questions, startTime);
                } else if (job.status === 'failed') {
                    stop();
                    sessionStorage.removeItem('analyzeJobId');
                    apiClient.post(`/api/analyze/jobs/${jobId}/consume`, {}).catch(() => { });
                    setAnalysisStep('idle');
                    setAnalyzeError(mapAnalyzeError(job.error || ''));
                }
            } catch (e) {
                console.warn('[HomeAnalyze] poll failed, retrying', e);
            }
        };
        // 后台时浏览器会冻结/节流 interval，切回前台立刻补查一次
        const onVisible = () => {
            if (document.visibilityState === 'visible') check();
        };
        document.addEventListener('visibilitychange', onVisible);
        const timer = setInterval(check, 3000);
        analyzeJobStopRef.current = stop;
    };

    /** 分析结果分流：多题 → 批量确认页；单题 → 单题校对页 */
    const handleAnalyzeResult = (questions: ParsedQuestion[], startTime: number) => {
        frontendLogger.info('[HomeAnalyze]', 'Job done, routing result', {
            count: questions.length,
            totalDuration: Date.now() - startTime,
        });
        setAnalysisStep('processing');
        setProgress(100);

        // 按第一题学科自动匹配笔记本
        const first = questions[0];
        if (first?.subject) {
            const matchedNotebook = notebooks.find(n =>
                n.name.includes(first.subject!) || first.subject!.includes(n.name)
            );
            if (matchedNotebook) {
                setAutoSelectedNotebookId(matchedNotebook.id);
            }
        }

        if (questions.length > 1) {
            setParsedQuestions(questions);
            setStep("multi-review");
            return;
        }
        if (questions.length === 1) {
            setParsedData(questions[0]);
            setStep("review");
            return;
        }
        // 一道题都没识别出来
        setAnalysisStep('idle');
        setAnalyzeError(t.errors?.AI_RESPONSE_ERROR || 'AI 分析失败，请重试');
    };

    const handleSave = async (finalData: ParsedQuestion & { subjectId?: string }): Promise<void> => {
        frontendLogger.info('[HomeSave]', 'Starting save process', {
            hasQuestionText: !!finalData.questionText,
            hasAnswerText: !!finalData.answerText,
            subjectId: finalData.subjectId,
            knowledgePointsCount: finalData.knowledgePoints?.length || 0,
            hasImage: !!currentImage,
            imageSize: currentImage?.length || 0,
        });

        try {
            const result = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", {
                ...finalData,
                originalImageUrl: currentImage || "",
            });

            // 检查是否是重复提交（后端去重返回）
            if (result.duplicate) {
                frontendLogger.info('[HomeSave]', 'Duplicate submission detected, using existing record');
            }

            frontendLogger.info('[HomeSave]', 'Save successful');
            setStep("upload");
            setParsedData(null);
            setCurrentImage(null);
            alert(t.common?.messages?.saveSuccess || 'Saved successfully!');

            // Redirect to notebook page if subjectId is present
            if (finalData.subjectId) {
                router.push(`/notebooks/${finalData.subjectId}`);
            }
        } catch (error: any) {
            frontendLogger.error('[HomeSave]', 'Save failed', {
                errorStatus: error?.status,
                errorMessage: error?.data?.message || error?.message || String(error),
                errorData: error?.data,
            });
            alert(t.common?.messages?.saveFailed || 'Failed to save');
        }
    };

    const handleTextSubmit = async (questionText: string) => {
        const startTime = Date.now();
        frontendLogger.info('[HomeTextSubmit]', 'Starting text-based analysis', { textLength: questionText.length });

        try {
            setAnalysisStep('analyzing');

            // Infer subject from auto-selected notebook
            const targetNotebookId = initialNotebookId || autoSelectedNotebookId;
            const matchedNotebook = targetNotebookId
                ? notebooks.find(n => n.id === targetNotebookId)
                : undefined;

            const result = await apiClient.post<{
                answerText: string;
                analysis: string;
                knowledgePoints: string[];
                wrongAnswerText: string;
                mistakeAnalysis: string;
                mistakeStatus: string;
            }>("/api/reanswer", {
                questionText,
                language,
                subject: matchedNotebook?.name || undefined,
            }, { timeout: aiTimeout });

            setAnalysisStep('processing');
            setProgress(100);

            const parsed: ParsedQuestion = {
                questionText,
                answerText: result.answerText,
                analysis: result.analysis,
                knowledgePoints: result.knowledgePoints || [],
                wrongAnswerText: result.wrongAnswerText || "",
                mistakeAnalysis: result.mistakeAnalysis || "",
                mistakeStatus: (result.mistakeStatus as any) || "unknown",
                subject: "数学", // Default, will be overridden by notebook selection
                requiresImage: false,
            };

            setCurrentImage(null); // No image for text input
            setParsedData(parsed);
            setStep("review");

            const totalDuration = Date.now() - startTime;
            frontendLogger.info('[HomeTextSubmit]', 'Text analysis completed', { totalDuration });
        } catch (error: any) {
            const errorDuration = Date.now() - startTime;
            frontendLogger.error('[HomeTextSubmit]', 'Analysis failed', {
                errorDuration,
                error: error.message || String(error)
            });

            try {
                let errorMessage = t.common?.messages?.analysisFailed || 'Analysis failed, please try again';
                const backendErrorType = error?.data?.message;
                if (backendErrorType && typeof backendErrorType === 'string') {
                    if (t.errors && typeof t.errors === 'object' && backendErrorType in t.errors) {
                        const mappedError = (t.errors as any)[backendErrorType];
                        if (typeof mappedError === 'string') errorMessage = mappedError;
                    } else {
                        errorMessage = backendErrorType;
                    }
                }
                alert(errorMessage);
            } catch {
                alert('Analysis failed. Please try again.');
            }
        } finally {
            setAnalysisStep('idle');
        }
    };

    const handleDirectSave = async (data: {
        questionText: string;
        answerText: string;
        analysis: string;
        wrongAnswerText: string;
        mistakeAnalysis: string;
        mistakeStatus: string;
        knowledgePoints: string[];
        subjectId: string;
        gradeSemester?: string;
        paperLevel?: string;
    }): Promise<void> => {
        frontendLogger.info('[HomeDirectSave]', 'Starting direct save', {
            hasQuestionText: !!data.questionText,
            hasAnswerText: !!data.answerText,
            subjectId: data.subjectId,
        });

        try {
            setAnalysisStep('saving');
            const result = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", {
                questionText: data.questionText,
                answerText: data.answerText,
                analysis: data.analysis,
                wrongAnswerText: data.wrongAnswerText || null,
                mistakeAnalysis: data.mistakeAnalysis || null,
                mistakeStatus: data.mistakeStatus || "unknown",
                knowledgePoints: data.knowledgePoints,
                subjectId: data.subjectId,
                gradeSemester: data.gradeSemester,
                paperLevel: data.paperLevel,
                originalImageUrl: "",
            });

            if (result.duplicate) {
                frontendLogger.info('[HomeDirectSave]', 'Duplicate detected');
            }

            frontendLogger.info('[HomeDirectSave]', 'Save successful');
            setAnalysisStep('idle');
            alert(t.common?.messages?.saveSuccess || 'Saved successfully!');

            if (data.subjectId) {
                router.push(`/notebooks/${data.subjectId}`);
            }
        } catch (error: any) {
            frontendLogger.error('[HomeDirectSave]', 'Save failed', {
                errorStatus: error?.status,
                errorMessage: error?.data?.message || error?.message || String(error),
            });
            setAnalysisStep('idle');
            alert(t.common?.messages?.saveFailed || 'Failed to save');
        }
    };

    const getProgressMessage = () => {
        switch (analysisStep) {
            case 'compressing': return t.common.progress?.compressing || "Compressing...";
            case 'uploading': return t.common.progress?.uploading || "Uploading...";
            case 'analyzing': return t.common.progress?.analyzing || "Analyzing...";
            case 'processing': return t.common.progress?.processing || "Processing...";
            case 'saving': return "保存中...";
            default: return "";
        }
    };

    /** 当前扫描实际使用的 AI 实例（整卷拆分/批改走专用实例，未配置时跟随活跃实例） */
    const getScanModelName = (): string | undefined => {
        if (!config) return undefined;
        if (config.aiProvider === 'openai') {
            const instances = config.openai?.instances || [];
            const id = config.openai?.multiAnalyzeInstanceId || config.openai?.activeInstanceId;
            const inst = instances.find((i) => i.id === id);
            return inst ? `${inst.name} · ${inst.model}` : undefined;
        }
        if (config.aiProvider === 'azure') return `Azure · ${config.azure?.model || config.azure?.deploymentName || ''}`;
        return `Gemini · ${config.gemini?.model || ''}`;
    };

    return (
        <main className="min-h-screen bg-background">
            <ProgressFeedback
                status={analysisStep}
                progress={progress}
                message={getProgressMessage()}
                modelName={analysisStep === 'analyzing' && inputMode === 'image' ? getScanModelName() : undefined}
                rotatingMessages={analysisStep === 'analyzing' && inputMode === 'image' ? (t.common.progress?.analyzingSteps as string[] | undefined) : undefined}
                onCancel={analysisStep === 'analyzing' ? cancelAnalyzeJob : undefined}
                cancelLabel={t.common?.cancel || '取消'}
            />

            <div className="container mx-auto p-4 space-y-8 pb-20">
                {/* Header Section */}
                <div className="flex justify-between items-start gap-4">
                    <UserWelcome />

                    <div className="flex items-center gap-2 bg-card p-2 rounded-lg border shadow-sm shrink-0">
                        <BroadcastNotification />
                        <div className="eink-hide">
                            <SettingsDialog />
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="rounded-full text-muted-foreground hover:text-destructive"
                            onClick={() => signOut({ callbackUrl: '/login' })}
                            title={t.app?.logout || 'Logout'}
                        >
                            <LogOut className="h-5 w-5" />
                        </Button>
                    </div>
                </div>

                {/* Action Center */}
                <div className={initialNotebookId ? "flex justify-center mb-6" : "grid grid-cols-2 md:grid-cols-4 gap-4"}>
                    <Button
                        size="lg"
                        className={`eink-hide h-auto py-4 text-base shadow-sm hover:shadow-md transition-all ${initialNotebookId ? "w-full max-w-md" : ""}`}
                        variant={step === "upload" ? "default" : "secondary"}
                        onClick={() => { setStep("upload"); setInputMode("image"); }}
                    >
                        <div className="flex items-center gap-2">
                            <Upload className="h-5 w-5" />
                            <span>{t.app.uploadNew}</span>
                        </div>
                    </Button>

                    {!initialNotebookId && (
                        <>
                            <Link href="/notebooks" className="w-full">
                                <Button
                                    variant="outline"
                                    size="lg"
                                    className="w-full h-auto py-4 text-base shadow-sm hover:shadow-md transition-all border hover:border-primary/50 hover:bg-accent/50"
                                >
                                    <div className="flex items-center gap-2">
                                        <BookOpen className="h-5 w-5" />
                                        <span>{t.app.viewNotebook}</span>
                                    </div>
                                </Button>
                            </Link>

                            <Link href="/tags" className="w-full eink-hide">
                                <Button
                                    variant="outline"
                                    size="lg"
                                    className="w-full h-auto py-4 text-base shadow-sm hover:shadow-md transition-all border hover:border-primary/50 hover:bg-accent/50"
                                >
                                    <div className="flex items-center gap-2">
                                        <Tags className="h-5 w-5" />
                                        <span>{t.app?.tags || 'Tags'}</span>
                                    </div>
                                </Button>
                            </Link>

                            <Link href="/stats" className="w-full">
                                <Button
                                    variant="outline"
                                    size="lg"
                                    className="w-full h-auto py-4 text-base shadow-sm hover:shadow-md transition-all border hover:border-primary/50 hover:bg-accent/50"
                                >
                                    <div className="flex items-center gap-2">
                                        <BarChart3 className="h-5 w-5" />
                                        <span>{t.app?.stats || 'Stats'}</span>
                                    </div>
                                </Button>
                            </Link>
                        </>
                    )}
                </div>

                {step === "upload" && (
                    <div className="space-y-4 eink-hide">
                        {/* Input mode tabs */}
                        <div className="flex gap-2 border-b">
                            <button
                                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                                    inputMode === "image"
                                        ? "border-primary text-primary"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                }`}
                                onClick={() => setInputMode("image")}
                            >
                                <Upload className="h-4 w-4" />
                                {t.app?.uploadImage || "拍照上传"}
                            </button>
                            <button
                                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                                    inputMode === "text"
                                        ? "border-primary text-primary"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                }`}
                                onClick={() => setInputMode("text")}
                            >
                                <PenLine className="h-4 w-4" />
                                {t.app?.manualInput || "AI解题"}
                            </button>
                            <button
                                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                                    inputMode === "direct"
                                        ? "border-primary text-primary"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                }`}
                                onClick={() => setInputMode("direct")}
                            >
                                <PenLine className="h-4 w-4" />
                                直接录入
                            </button>
                        </div>

                        {inputMode === "image" ? (
                            <>
                                <UploadZone onImageSelect={onImageSelect} onImagesSelect={onImagesSelect} isAnalyzing={analysisStep !== 'idle'} />

                                {/* 分析失败的内联错误条（不用 alert，黑屏/墨水屏友好） + 一键重试 */}
                                {analyzeError && (
                                    <div className="mt-4 p-3 border border-destructive/50 rounded-lg bg-destructive/10 text-sm flex items-center justify-between gap-3">
                                        <span className="text-destructive">{analyzeError}</span>
                                        <div className="flex gap-2 shrink-0">
                                            <Button variant="outline" size="sm" onClick={() => setAnalyzeError(null)}>
                                                {t.common?.cancel || "关闭"}
                                            </Button>
                                            <Button size="sm" onClick={startAnalysis} disabled={pendingPages.length === 0}>
                                                {t.common?.retry || "重试"}
                                            </Button>
                                        </div>
                                    </div>
                                )}

                                {/* 连续扫描暂存条：多页试卷逐页添加，最后一并解析 */}
                                {pendingPages.length > 0 && (
                                <div className="mt-4 p-3 border rounded-lg bg-muted/40 space-y-3">
                                    <div className="flex items-center gap-3 flex-wrap">
                                        {pendingPages.map((pg, i) => (
                                            <div key={i} className="relative">
                                                <img
                                                    src={pg}
                                                    alt={`第${i + 1}页`}
                                                    className="h-20 rounded border cursor-pointer hover:border-primary"
                                                    title={t.paperStudio?.editHint || "点开可切边/选题"}
                                                    onClick={() => setStudioIndex(i)}
                                                />
                                                {rectifyingPages.has(pg) && (
                                                    <div className="absolute inset-0 rounded bg-background/60 flex items-center justify-center pointer-events-none">
                                                        <Loader2 className="h-5 w-5 animate-spin text-primary" />
                                                    </div>
                                                )}
                                                <button
                                                    type="button"
                                                    className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-destructive text-destructive-foreground text-xs leading-none"
                                                    onClick={() => setPendingPages((prev) => prev.filter((_, idx) => idx !== i))}
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                        <span className="text-xs text-muted-foreground">
                                            {(t.app?.pagesStaged || "已添加 {count} 页，可继续拍照添加").replace("{count}", String(pendingPages.length))}
                                        </span>
                                    </div>
                                    <Button onClick={startAnalysis} disabled={analysisStep !== 'idle'} className="w-full">
                                        {(t.app?.startAnalysis || "开始解析（{count} 页）").replace("{count}", String(pendingPages.length))}
                                    </Button>
                                </div>
                                )}
                            </>
                        ) : inputMode === "text" ? (
                            <TextInputZone
                                onSubmit={handleTextSubmit}
                                isAnalyzing={analysisStep !== 'idle'}
                                defaultNotebookName={
                                    (initialNotebookId || autoSelectedNotebookId)
                                        ? notebooks.find(n => n.id === (initialNotebookId || autoSelectedNotebookId))?.name
                                        : undefined
                                }
                            />
                        ) : (
                            <DirectTextEditor
                                onSubmit={handleDirectSave}
                                defaultNotebookId={initialNotebookId || autoSelectedNotebookId || undefined}
                                defaultNotebookName={
                                    (initialNotebookId || autoSelectedNotebookId)
                                        ? notebooks.find(n => n.id === (initialNotebookId || autoSelectedNotebookId))?.name
                                        : undefined
                                }
                                isSaving={analysisStep === 'saving'}
                            />
                        )}
                    </div>
                )}

                {studioIndex !== null && pendingPages[studioIndex] && (
                    <PaperStudio
                        imageSrc={pendingPages[studioIndex]}
                        open={studioIndex !== null}
                        onClose={() => setStudioIndex(null)}
                        onApply={(processed) => {
                            setPendingPages((prev) => prev.map((p, idx) => (idx === studioIndex ? processed : p)));
                            setStudioIndex(null);
                        }}
                    />
                )}

                {step === "review" && parsedData && (
                    <CorrectionEditor
                        initialData={parsedData}
                        onSave={handleSave}
                        onCancel={() => setStep("upload")}
                        imagePreview={currentImage}
                        initialSubjectId={initialNotebookId || autoSelectedNotebookId || undefined}
                        aiTimeout={aiTimeout}
                    />
                )}

                {step === "multi-review" && parsedQuestions.length > 0 && (
                    <MultiQuestionReview
                        questions={parsedQuestions}
                        pageImages={pageImages.length > 0 ? pageImages : (currentImage ? [currentImage] : [])}
                        defaultSubjectId={initialNotebookId || autoSelectedNotebookId || undefined}
                        onCancel={() => {
                            setStep("upload");
                            setParsedQuestions([]);
                            setCurrentImage(null);
                            setPageImages([]);
                            setPendingPages([]);
                        }}
                        onSaved={(count, subjectId) => {
                            setStep("upload");
                            setParsedQuestions([]);
                            setCurrentImage(null);
                            setPageImages([]);
                            setPendingPages([]);
                            alert((t.multiReview?.saved || "已保存 {count} 道错题！").replace("{count}", String(count)));
                            if (subjectId) {
                                router.push(`/notebooks/${subjectId}`);
                            }
                        }}
                    />
                )}

            </div>
        </main>
    );
}

export default function Home() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <HomeContent />
        </Suspense>
    );
}
