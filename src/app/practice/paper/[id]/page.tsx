"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, ArrowLeft, House, Printer, Eye, CheckCircle, XCircle, PenLine } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { SketchPad } from "@/components/sketch-pad";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";

export const dynamic = 'force-dynamic';

interface PaperJob {
    id: string;
    errorItemId: string;
    orderIndex: number | null;
    status: "pending" | "running" | "done" | "failed";
    difficulty: string;
    error: string | null;
    result: {
        questionText: string;
        answerText: string;
        analysis: string;
        subject?: string;
    } | null;
}

interface Paper {
    id: string;
    status: "running" | "done" | "partial" | "failed";
    difficulty: string;
    createdAt: string;
    completedAt: string | null;
    total: number;
    doneCount: number;
    failedCount: number;
    jobs: PaperJob[];
}

/** 每题的作答状态：查看答案 → 自评对错 */
interface AnswerState {
    showAnswer: boolean;
    submitted: boolean;
    isCorrect: boolean | null;
}

export default function PracticePaperPage() {
    const params = useParams();
    const paperId = params.id as string;
    const router = useRouter();
    const { t } = useLanguage();

    const [paper, setPaper] = useState<Paper | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
    const [retrying, setRetrying] = useState(false);
    // 每题手写演算区开关
    const [sketchOpen, setSketchOpen] = useState<Record<string, boolean>>({});
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const stopPolling = () => {
        if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    };

    const fetchPaper = async (): Promise<Paper | null> => {
        try {
            const data = await apiClient.get<Paper>(`/api/practice/papers/${paperId}`);
            setPaper(data);
            return data;
        } catch (e) {
            console.error(e);
            setError(t.practicePrint?.loadFailed || "加载失败");
            return null;
        }
    };

    const startPolling = () => {
        stopPolling();
        pollTimerRef.current = setInterval(async () => {
            const d = await fetchPaper();
            if (d && d.status !== "running") stopPolling();
        }, 3000);
    };

    useEffect(() => {
        fetchPaper().then((data) => {
            if (data && data.status === "running") startPolling();
        });
        return () => stopPolling();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paperId]);

    const retryFailed = async () => {
        if (!paper || retrying) return;
        setRetrying(true);
        try {
            await apiClient.post(`/api/practice/papers/${paper.id}`, { action: "retryFailed" });
            const data = await fetchPaper();
            if (data?.status === "running") startPolling();
        } catch (e) {
            console.error(e);
            alert(t.practicePaper?.retryRequestFailed || "重试失败，请稍后再试");
        } finally {
            setRetrying(false);
        }
    };

    const getAnswerState = (jobId: string): AnswerState =>
        answers[jobId] || { showAnswer: false, submitted: false, isCorrect: null };

    const patchAnswerState = (jobId: string, patch: Partial<AnswerState>) =>
        setAnswers((prev) => ({
            ...prev,
            [jobId]: { ...getAnswerState(jobId), ...patch },
        }));

    /** 自评对错：记录练习结果 + 推进该错题的复习排期 */
    const selfAssess = (job: PaperJob, correct: boolean) => {
        patchAnswerState(job.id, { submitted: true, isCorrect: correct, showAnswer: true });
        apiClient.post("/api/practice/record", {
            subject: job.result?.subject || "Unknown",
            difficulty: job.difficulty,
            isCorrect: correct,
        }).catch((err) => console.error("Failed to save practice record:", err));
        apiClient.post("/api/review/complete", {
            errorItemId: job.errorItemId,
            isCorrect: correct,
        }).catch((err) => console.error("Failed to complete review:", err));
    };

    if (error) {
        return <div className="p-8 text-center text-muted-foreground">{error}</div>;
    }
    if (!paper) {
        return (
            <div className="flex justify-center p-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const progressText = (t.practicePaper?.progress || "{done}/{total} questions ready")
        .replace("{done}", String(paper.doneCount))
        .replace("{total}", String(paper.total));

    return (
        <main className="min-h-screen p-4 md:p-8 bg-background">
            <div className="max-w-3xl mx-auto space-y-6">
                {/* 头部：返回 / 标题 / 进度 / 打印 */}
                <div className="flex justify-between items-center">
                    <Button variant="ghost" onClick={() => router.back()}>
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        {t.common?.back || "返回"}
                    </Button>
                    <div className="flex items-center gap-2">
                        {paper.status !== "running" && paper.doneCount > 0 && (
                            <Link href={`/practice/paper/${paper.id}/print`} target="_blank">
                                <Button variant="outline" size="sm">
                                    <Printer className="mr-2 h-4 w-4" />
                                    {t.practicePaper?.print || "打印 / 存 PDF"}
                                </Button>
                            </Link>
                        )}
                        <Link href="/">
                            <Button variant="ghost" size="icon">
                                <House className="h-5 w-5" />
                            </Button>
                        </Link>
                    </div>
                </div>

                <div className="text-center space-y-2">
                    <h1 className="text-2xl md:text-3xl font-bold">{t.practicePaper?.title || "举一反三试卷"}</h1>
                    <p className="text-muted-foreground">{progressText}</p>
                    {paper.status === "running" && (
                        <p className="text-sm text-muted-foreground flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t.practicePaper?.generating || "AI 正在后台逐题生成，可以离开本页稍后再来。"}
                        </p>
                    )}
                    {(paper.status === "partial" || paper.failedCount > 0) && (
                        <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-orange-600">
                            <span>{t.practicePaper?.partialHint || "部分题目生成失败"}（{paper.failedCount}）</span>
                            {paper.status !== "running" && paper.failedCount > 0 && (
                                <Button variant="outline" size="sm" onClick={retryFailed} disabled={retrying}>
                                    {retrying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    {t.practicePaper?.retryFailed || "重试失败题"}
                                </Button>
                            )}
                        </div>
                    )}
                </div>

                {/* 题目卡片 */}
                {paper.jobs.map((job, idx) => {
                    const st = getAnswerState(job.id);
                    return (
                        <Card key={job.id} className="border-primary/30">
                            <CardHeader>
                                <CardTitle className="text-base flex justify-between items-center">
                                    <span>
                                        {(t.practicePaper?.questionNumber || "第 {index} 题").replace("{index}", String(idx + 1))}
                                    </span>
                                    {(job.status === "pending" || job.status === "running") && (
                                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                    )}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {job.status === "failed" && (
                                    <p className="text-sm text-muted-foreground">
                                        {t.practicePaper?.questionFailed || "本题生成失败"}
                                    </p>
                                )}
                                {(job.status === "pending" || job.status === "running") && (
                                    <p className="text-sm text-muted-foreground">{t.practice?.generating || "AI 正在出题..."}</p>
                                )}
                                {job.status === "done" && job.result && (
                                    <>
                                        <MarkdownRenderer content={job.result.questionText} className="font-medium" />

                                        {/* 手写演算区（墨水屏手写笔友好） */}
                                        <div>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={() => setSketchOpen((prev) => ({ ...prev, [job.id]: !prev[job.id] }))}
                                            >
                                                <PenLine className="mr-2 h-4 w-4" />
                                                {sketchOpen[job.id]
                                                    ? (t.practicePaper?.hideSketch || "收起演算区")
                                                    : (t.practicePaper?.showSketch || "手写演算")}
                                            </Button>
                                            {sketchOpen[job.id] && <SketchPad className="mt-3" />}
                                        </div>

                                        {/* 自评流：查看答案 → 答对/答错 */}
                                        {!st.showAnswer ? (
                                            <Button
                                                variant="outline"
                                                className="w-full"
                                                onClick={() => patchAnswerState(job.id, { showAnswer: true })}
                                            >
                                                <Eye className="mr-2 h-4 w-4" />
                                                {t.practice?.checkAnswer || "查看答案"}
                                            </Button>
                                        ) : (
                                            <div className="space-y-4 pt-2 border-t">
                                                <div>
                                                    <h4 className="font-semibold text-green-600 mb-2">{t.practice?.correctAnswer || "参考答案"}</h4>
                                                    <MarkdownRenderer content={job.result.answerText} className="font-bold" />
                                                </div>
                                                <div>
                                                    <h4 className="font-semibold mb-2">{t.practice?.detailedAnalysis || "详细解析"}</h4>
                                                    <MarkdownRenderer content={job.result.analysis} />
                                                </div>

                                                {!st.submitted ? (
                                                    <div className="space-y-3 pt-2">
                                                        <p className="text-center text-muted-foreground">
                                                            {t.practice?.selfAssessPrompt || "对照答案，自评一下："}
                                                        </p>
                                                        <div className="flex gap-4">
                                                            <Button
                                                                variant="outline"
                                                                className="flex-1 border-2"
                                                                size="lg"
                                                                onClick={() => selfAssess(job, false)}
                                                            >
                                                                <XCircle className="mr-2 h-5 w-5" />
                                                                {t.practice?.selfIncorrect || "答错了"}
                                                            </Button>
                                                            <Button
                                                                className="flex-1"
                                                                size="lg"
                                                                onClick={() => selfAssess(job, true)}
                                                            >
                                                                <CheckCircle className="mr-2 h-5 w-5" />
                                                                {t.practice?.selfCorrect || "答对了"}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <p className={`text-center font-medium ${st.isCorrect ? "text-green-600" : "text-red-600"}`}>
                                                        {st.isCorrect
                                                            ? (t.practice?.correct || "回答正确！")
                                                            : (t.practice?.incorrect || "答案有误")}
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    );
                })}

                {paper.jobs.length === 0 && (
                    <p className="text-center text-muted-foreground">{t.practicePaper?.empty || "还没有题目"}</p>
                )}
            </div>
        </main>
    );
}
