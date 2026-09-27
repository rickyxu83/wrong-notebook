"use client";

import { useState, Suspense, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Printer, ArrowLeft } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";

export const dynamic = 'force-dynamic';

const DIFFICULTY_LABELS: Record<string, string> = {
    easy: "简单", medium: "中等", hard: "困难", harder: "挑战",
};

function PracticePrintContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const jobId = searchParams.get("jobId");
    const { t } = useLanguage();

    const [job, setJob] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [withAnswer, setWithAnswer] = useState(false);

    useEffect(() => {
        if (!jobId) {
            setError("missing jobId");
            setLoading(false);
            return;
        }
        apiClient.get<any>(`/api/practice/jobs/${jobId}`)
            .then(j => {
                if (j.status !== "done" || !j.result) {
                    setError(t.practicePrint?.notReady || "题目尚未出好");
                } else {
                    setJob(j);
                }
            })
            .catch(() => setError(t.practicePrint?.loadFailed || "加载失败"))
            .finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobId]);

    if (loading) {
        return <div className="flex justify-center p-8"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
    }
    if (error || !job) {
        return <div className="p-8 text-center text-muted-foreground">{error}</div>;
    }

    const q = job.result;

    return (
        <div className="max-w-3xl mx-auto p-6">
            <div className="flex justify-between items-center mb-6 print:hidden">
                <Button variant="ghost" onClick={() => router.back()}>
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    {t.common?.back || "返回"}
                </Button>
                <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                            type="checkbox"
                            checked={withAnswer}
                            onChange={(e) => setWithAnswer(e.target.checked)}
                        />
                        {t.practicePrint?.withAnswer || "附答案与解析"}
                    </label>
                    <Button onClick={() => window.print()}>
                        <Printer className="mr-2 h-4 w-4" />
                        {t.practicePrint?.print || "打印 / 存 PDF"}
                    </Button>
                </div>
            </div>

            <div className="space-y-4">
                <div className="flex gap-4 text-sm text-muted-foreground border-b pb-3">
                    <span className="font-medium">{t.practicePrint?.title || "举一反三练习"}</span>
                    <span>{t.practice?.difficulty?.label || "难度"}: {DIFFICULTY_LABELS[job.difficulty] || job.difficulty}</span>
                    <span>{new Date(job.completedAt || job.createdAt).toLocaleDateString()}</span>
                </div>

                <MarkdownRenderer content={q.questionText} className="text-base leading-relaxed" />

                <div className="pt-4">
                    <p className="text-sm text-muted-foreground mb-2">{t.practicePrint?.answerArea || "作答区："}</p>
                    <div className="h-56 border border-dashed rounded-lg" />
                </div>
            </div>

            {withAnswer && (
                <div className="mt-8 space-y-4" style={{ pageBreakBefore: 'always' }}>
                    <h2 className="font-bold text-lg">{t.practice?.correctAnswer || "参考答案"}</h2>
                    <MarkdownRenderer content={q.answerText} />
                    <h2 className="font-bold text-lg pt-4">{t.practice?.detailedAnalysis || "详细解析"}</h2>
                    <MarkdownRenderer content={q.analysis} />
                </div>
            )}
        </div>
    );
}

export default function PracticePrintPage() {
    return (
        <main className="min-h-screen bg-background">
            <Suspense fallback={
                <div className="flex justify-center p-8">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
            }>
                <PracticePrintContent />
            </Suspense>
        </main>
    );
}
