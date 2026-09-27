"use client";

import { useState, useEffect } from "react";
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
import { cropByBoundaries, computeQuestionBoundaries } from "@/lib/image-utils";
import { PageCutEditor } from "@/components/page-cut-editor";
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
    // 图片切线（归一化 0-1，N+1 条）：null = 不切分，共用整页原图
    const [boundaries, setBoundaries] = useState<number[] | null>(null);
    const [showCutEditor, setShowCutEditor] = useState(false);

    // 挂载后自动计算建议切线（AI bbox 提示 + 空白带精修）
    useEffect(() => {
        if (!imagePreview || questions.length < 2) return;
        const boxes = questions.map((q) => q.bbox as [number, number, number, number] | undefined);
        if (!boxes.some(Boolean)) return;
        computeQuestionBoundaries(imagePreview, boxes).then((b) => {
            if (b && b.length === questions.length + 1) {
                setBoundaries(b);
                setShowCutEditor(true);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
            // 整卷拆分：按（可能被用户调整过的）切线逐题裁图；无切线时共用整页原图
            let crops: string[] | null = null;
            if (imagePreview && boundaries && boundaries.length === items.length + 1) {
                try {
                    crops = await cropByBoundaries(imagePreview, boundaries);
                } catch {
                    crops = null; // 失败回退整页原图
                }
            }
            for (const q of toSave) {
                const itemImage = crops?.[items.indexOf(q)] ?? imagePreview ?? "";
                await apiClient.post("/api/error-items", {
                    questionText: q.questionText,
                    answerText: q.answerText,
                    analysis: q.analysis,
                    wrongAnswerText: q.wrongAnswerText || "",
                    mistakeAnalysis: q.mistakeAnalysis || "",
                    mistakeStatus: q.mistakeStatus || "unknown",
                    knowledgePoints: q.knowledgePoints || [],
                    originalImageUrl: itemImage,
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

            {/* 图片裁切：有自动切线时可拖拽调整；无切线时仅查看原图 */}
            {imagePreview && boundaries ? (
                <div className="space-y-2">
                    <button
                        type="button"
                        className="text-sm text-muted-foreground underline underline-offset-2"
                        onClick={() => setShowCutEditor(!showCutEditor)}
                    >
                        {showCutEditor
                            ? (t.multiReview?.hideCutLines || "收起图片裁切")
                            : (t.multiReview?.showCutLines || "调整图片裁切")}
                    </button>
                    {showCutEditor && (
                        <>
                            <p className="text-xs text-muted-foreground text-center">
                                {t.multiReview?.cutHint || "拖动红线调整每道题的裁切范围"}
                            </p>
                            <PageCutEditor imageUrl={imagePreview} boundaries={boundaries} onChange={setBoundaries} />
                        </>
                    )}
                </div>
            ) : imagePreview ? (
                <details className="text-center">
                    <summary className="text-sm text-muted-foreground cursor-pointer">
                        {t.detail?.originalProblem || "查看原图"}
                    </summary>
                    <img src={imagePreview} alt="original" className="mt-2 mx-auto max-h-96 rounded-lg border" />
                </details>
            ) : null}

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
