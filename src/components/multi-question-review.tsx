"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { NotebookSelector } from "@/components/notebook-selector";
import { InlineMath } from "@/components/inline-math";
import { Loader2, Save, X } from "lucide-react";
import { ParsedQuestion } from "@/lib/ai";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";

interface EditableQuestion extends ParsedQuestion {
    included: boolean;
}

interface MultiQuestionReviewProps {
    questions: ParsedQuestion[];
    imagePreview: string | null;
    defaultSubjectId?: string | null;
    onSaved: (count: number, subjectId?: string) => void;
    onCancel: () => void;
}

/**
 * 整卷拆分导入确认页：AI 一次识别出多道题，逐题核对/勾选后批量保存。
 * 每道题保存为一条独立错题，共用整页原图。
 */
export function MultiQuestionReview({ questions, imagePreview, defaultSubjectId, onSaved, onCancel }: MultiQuestionReviewProps) {
    const { t } = useLanguage();
    const [items, setItems] = useState<EditableQuestion[]>(questions.map((q) => ({ ...q, included: true })));
    const [notebookId, setNotebookId] = useState<string | null>(defaultSubjectId || null);
    const [saving, setSaving] = useState(false);
    const [saveProgress, setSaveProgress] = useState(0);

    const patch = (index: number, p: Partial<EditableQuestion>) =>
        setItems((prev) => prev.map((q, i) => (i === index ? { ...q, ...p } : q)));

    const includedCount = items.filter((q) => q.included).length;

    const saveAll = async () => {
        const toSave = items.filter((q) => q.included);
        if (toSave.length === 0 || saving) return;
        setSaving(true);
        setSaveProgress(0);
        try {
            let done = 0;
            for (const q of toSave) {
                await apiClient.post("/api/error-items", {
                    questionText: q.questionText,
                    answerText: q.answerText,
                    analysis: q.analysis,
                    wrongAnswerText: q.wrongAnswerText || "",
                    mistakeAnalysis: q.mistakeAnalysis || "",
                    mistakeStatus: q.mistakeStatus || "unknown",
                    knowledgePoints: q.knowledgePoints || [],
                    originalImageUrl: imagePreview || "",
                    subjectId: notebookId || undefined,
                });
                done++;
                setSaveProgress(done);
            }
            onSaved(done, notebookId || undefined);
        } catch (e) {
            console.error(e);
            alert(t.common?.messages?.saveFailed || "保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="text-center space-y-2">
                <h2 className="text-2xl font-bold">
                    {(t.multiReview?.title || "识别到 {count} 道题").replace("{count}", String(questions.length))}
                </h2>
                <p className="text-muted-foreground">
                    {t.multiReview?.subtitle || "逐题核对内容，不需要导入的取消勾选"}
                </p>
            </div>

            {/* 目标错题本（对整卷生效） */}
            <div className="flex items-center gap-3 justify-center">
                <span className="text-sm text-muted-foreground shrink-0">
                    {t.multiReview?.notebook || "保存到错题本"}：
                </span>
                <div className="w-64">
                    <NotebookSelector value={notebookId || undefined} onChange={(v) => setNotebookId(v)} />
                </div>
            </div>

            {imagePreview && (
                <details className="text-center">
                    <summary className="text-sm text-muted-foreground cursor-pointer">
                        {t.detail?.originalProblem || "查看原图"}
                    </summary>
                    <img src={imagePreview} alt="original" className="mt-2 mx-auto max-h-96 rounded-lg border" />
                </details>
            )}

            <div className="space-y-4">
                {items.map((q, i) => (
                    <Card key={i} className={q.included ? "" : "opacity-50"}>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base flex items-center gap-3 flex-wrap">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <Checkbox
                                        checked={q.included}
                                        onCheckedChange={(checked) => patch(i, { included: !!checked })}
                                        disabled={saving}
                                    />
                                    <span>{(t.multiReview?.questionNumber || "第 {index} 题").replace("{index}", String(i + 1))}</span>
                                </label>
                                {q.subject && <Badge variant="secondary">{q.subject}</Badge>}
                                {q.knowledgePoints?.map((kp) => (
                                    <Badge key={kp} variant="outline" className="font-normal">
                                        <InlineMath content={kp} />
                                    </Badge>
                                ))}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <Textarea
                                value={q.questionText}
                                onChange={(e) => patch(i, { questionText: e.target.value })}
                                rows={4}
                                disabled={!q.included || saving}
                                className="font-mono text-sm"
                            />
                            <div className="grid gap-3 md:grid-cols-2">
                                <div>
                                    <p className="text-xs text-muted-foreground mb-1">{t.detail?.correctAnswer || "答案"}</p>
                                    <Textarea
                                        value={q.answerText}
                                        onChange={(e) => patch(i, { answerText: e.target.value })}
                                        rows={2}
                                        disabled={!q.included || saving}
                                        className="font-mono text-sm"
                                    />
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground mb-1">{t.detail?.analysis || "解析"}</p>
                                    <Textarea
                                        value={q.analysis}
                                        onChange={(e) => patch(i, { analysis: e.target.value })}
                                        rows={2}
                                        disabled={!q.included || saving}
                                        className="font-mono text-sm"
                                    />
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="flex justify-center gap-4 pb-8">
                <Button variant="outline" onClick={onCancel} disabled={saving}>
                    <X className="mr-2 h-4 w-4" />
                    {t.common?.back || "返回"}
                </Button>
                <Button size="lg" onClick={saveAll} disabled={includedCount === 0 || saving}>
                    {saving ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {(t.multiReview?.saving || "保存中 {current}/{total}...")
                                .replace("{current}", String(saveProgress))
                                .replace("{total}", String(includedCount))}
                        </>
                    ) : (
                        <>
                            <Save className="mr-2 h-4 w-4" />
                            {(t.multiReview?.saveAll || "保存 {count} 道错题").replace("{count}", String(includedCount))}
                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}
