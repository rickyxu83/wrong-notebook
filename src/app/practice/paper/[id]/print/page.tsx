"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Printer, ArrowLeft } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";

export const dynamic = 'force-dynamic';

const DIFFICULTY_LABELS: Record<string, string> = {
    easy: "简单", medium: "中等", hard: "困难", harder: "挑战",
};

interface PaperJob {
    id: string;
    orderIndex: number | null;
    status: string;
    difficulty: string;
    result: {
        questionText: string;
        answerText: string;
        analysis: string;
    } | null;
}

interface Paper {
    id: string;
    status: string;
    difficulty: string;
    createdAt: string;
    completedAt: string | null;
    total: number;
    doneCount: number;
    failedCount: number;
    jobs: PaperJob[];
}

export default function PracticePaperPrintPage() {
    const params = useParams();
    const paperId = params.id as string;
    const router = useRouter();
    const { t } = useLanguage();

    const [paper, setPaper] = useState<Paper | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [withAnswer, setWithAnswer] = useState(false);

    useEffect(() => {
        apiClient.get<Paper>(`/api/practice/papers/${paperId}`)
            .then(setPaper)
            .catch(() => setError(t.practicePrint?.loadFailed || "加载失败"))
            .finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paperId]);

    if (loading) {
        return <div className="flex justify-center p-8"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
    }
    if (error || !paper) {
        return <div className="p-8 text-center text-muted-foreground">{error}</div>;
    }

    const doneJobs = paper.jobs.filter((j) => j.status === "done" && j.result);

    return (
        <main className="min-h-screen bg-background">
            <div className="max-w-3xl mx-auto p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center mb-6 print:hidden">
                    <Button variant="ghost" onClick={() => router.back()}>
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        {t.common?.back || "返回"}
                    </Button>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                                type="checkbox"
                                checked={withAnswer}
                                onChange={(e) => setWithAnswer(e.target.checked)}
                            />
                            {t.practicePaper?.withAnswer || "附答案与解析"}
                        </label>
                        <Button onClick={() => window.print()}>
                            <Printer className="mr-2 h-4 w-4" />
                            {t.practicePaper?.print || "打印 / 存 PDF"}
                        </Button>
                    </div>
                </div>

                {/* 卷头 */}
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground border-b pb-3 mb-6">
                    <span className="font-medium text-base">{t.practicePaper?.title || "举一反三试卷"}</span>
                    <span>{t.practice?.difficulty?.label || "难度"}: {DIFFICULTY_LABELS[paper.difficulty] || paper.difficulty}</span>
                    <span>{new Date(paper.createdAt).toLocaleDateString()}</span>
                    <span>{t.practicePaper?.progress?.replace("{done}", String(doneJobs.length)).replace("{total}", String(paper.total)) || `${doneJobs.length}/${paper.total}`}</span>
                </div>

                {/* 题目区：每题带作答区 */}
                <div className="space-y-10">
                    {doneJobs.map((job, idx) => (
                        <div key={job.id} className="print:break-inside-avoid">
                            <h3 className="font-bold mb-3">
                                {(t.practicePaper?.questionNumber || "第 {index} 题").replace("{index}", String(idx + 1))}
                            </h3>
                            <MarkdownRenderer content={job.result!.questionText} className="text-base leading-relaxed" />

                            <div className="pt-4">
                                <p className="text-sm text-muted-foreground mb-2">{t.practicePaper?.answerArea || "作答区："}</p>
                                <div className="h-48 border border-dashed rounded-lg" />
                            </div>
                        </div>
                    ))}
                </div>

                {/* 答案解析区（可选，另起一页） */}
                {withAnswer && (
                    <div className="mt-8 space-y-8" style={{ pageBreakBefore: 'always' }}>
                        <h2 className="font-bold text-xl border-b pb-2">{t.practice?.correctAnswer || "参考答案"}</h2>
                        {doneJobs.map((job, idx) => (
                            <div key={job.id} className="print:break-inside-avoid">
                                <h3 className="font-bold mb-2">
                                    {(t.practicePaper?.questionNumber || "第 {index} 题").replace("{index}", String(idx + 1))}
                                </h3>
                                <MarkdownRenderer content={job.result!.answerText} className="font-semibold mb-3" />
                                <h4 className="font-semibold text-sm text-muted-foreground mb-1">{t.practice?.detailedAnalysis || "详细解析"}</h4>
                                <MarkdownRenderer content={job.result!.analysis} />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
