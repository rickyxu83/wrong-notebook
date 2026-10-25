"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { NotebookSelector } from "@/components/notebook-selector";
import { InlineMath } from "@/components/inline-math";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { Loader2, Save, X, ImagePlus, Pencil, Eye } from "lucide-react";
import { ParsedQuestion } from "@/lib/ai";
import { apiClient } from "@/lib/api-client";
import { cropByBoundaries, computeQuestionBoundaries } from "@/lib/image-utils";
import { PageCutEditor } from "@/components/page-cut-editor";
import { ImageCropper } from "@/components/image-cropper";
import { useLanguage } from "@/contexts/LanguageContext";

interface EditableQuestion extends ParsedQuestion {
    included: boolean;
}

interface MultiQuestionReviewProps {
    questions: ParsedQuestion[];
    pageImages: string[]; // 每页整图（与题目的 page 字段对应，单页时长度为 1）
    defaultSubjectId?: string | null;
    onSaved: (count: number, subjectId?: string) => void;
    onCancel: () => void;
}

/**
 * 整卷拆分导入确认页：AI 一次识别出多道题，逐题核对/勾选后批量保存。
 * 每道题保存为一条独立错题，共用整页原图。
 */
export function MultiQuestionReview({ questions, pageImages, defaultSubjectId, onSaved, onCancel }: MultiQuestionReviewProps) {
    // 单页兼容：绝大多数逻辑只看第一页；多页时按题目的 page 字段取页图
    const imagePreview = pageImages[0] ?? null;
    const pageOf = (q: EditableQuestion) => pageImages[(q.page ?? 1) - 1] ?? imagePreview;
    const { t } = useLanguage();
    // 批改模式：任一题带对错判定即为批改场景，默认只勾错题；否则（未作答卷子）默认全勾
    const gradingMode = questions.some((q) => q.isCorrect !== null && q.isCorrect !== undefined);
    const [items, setItems] = useState<EditableQuestion[]>(
        questions.map((q) => ({ ...q, included: gradingMode ? q.isCorrect === false : true }))
    );
    const [notebookId, setNotebookId] = useState<string | null>(defaultSubjectId || null);
    const [saving, setSaving] = useState(false);
    const [saveProgress, setSaveProgress] = useState(0);
    // 图片切线（归一化 0-1，N+1 条）：null = 不切分，共用整页原图
    const [boundaries, setBoundaries] = useState<number[] | null>(null);
    const [showCutEditor, setShowCutEditor] = useState(false);
    // 每题图片预览（按切线自动裁出）与手动重裁覆盖
    const [previews, setPreviews] = useState<string[] | null>(null);
    const [customImages, setCustomImages] = useState<Record<number, string>>({});
    const [cropTarget, setCropTarget] = useState<number | null>(null); // 正在为哪一道题手动裁图
    // 默认展示渲染后的数学公式；只有需要修改时才进入源码编辑
    const [editingItems, setEditingItems] = useState<Set<number>>(new Set());

    const toggleEditing = (index: number) => {
        setEditingItems((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    // 挂载后自动计算建议切线（AI bbox 提示 + 空白带精修）
    useEffect(() => {
        if (!imagePreview || questions.length < 2 || pageImages.length > 1) return;
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

    // 切线变化后重新生成每题预览图
    useEffect(() => {
        if (!imagePreview || !boundaries || boundaries.length !== questions.length + 1) return;
        cropByBoundaries(imagePreview, boundaries).then(setPreviews).catch(() => setPreviews(null));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [boundaries]);

    /** 手动裁图完成：Blob → dataURL，覆盖该题图片 */
    const handleManualCrop = (index: number) => (blob: Blob) => {
        const reader = new FileReader();
        reader.onload = () => {
            setCustomImages((prev) => ({ ...prev, [index]: reader.result as string }));
            setCropTarget(null);
        };
        reader.readAsDataURL(blob);
    };

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
                // 优先级：手动重裁 > 切线自动裁 > 整页原图
                const itemImage = customImages[items.indexOf(q)] ?? crops?.[items.indexOf(q)] ?? pageOf(q) ?? "";
                await apiClient.post("/api/error-items", {
                    questionText: q.questionText,
                    answerText: q.answerText,
                    analysis: q.analysis,
                    wrongAnswerText: q.wrongAnswerText || "",
                    mistakeAnalysis: q.mistakeAnalysis || "",
                    mistakeStatus: q.isCorrect === false ? "wrong_attempt" : (q.mistakeStatus || "unknown"),
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
                    {(gradingMode
                        ? (t.multiReview?.gradeTitle || "批改完成：共 {count} 题")
                        : (t.multiReview?.title || "识别到 {count} 道题"))
                        .replace("{count}", String(questions.length))}
                </h2>
                <p className="text-muted-foreground">
                    {gradingMode
                        ? (t.multiReview?.gradeSubtitle || "错题已默认勾选，确认后加入错题集")
                        : (t.multiReview?.subtitle || "逐题核对内容，不需要导入的取消勾选")}
                </p>
                {gradingMode && (
                    <p className="text-sm">
                        <span className="text-red-600 font-medium">
                            {(t.multiReview?.gradeWrongCount || "错 {count} 题").replace("{count}", String(items.filter((q) => q.isCorrect === false).length))}
                        </span>
                        {" · "}
                        <span className="text-green-600">
                            {(t.multiReview?.gradeCorrectCount || "对 {count} 题").replace("{count}", String(items.filter((q) => q.isCorrect === true).length))}
                        </span>
                        {" · "}
                        <span className="text-muted-foreground">
                            {(t.multiReview?.gradeUnknownCount || "{count} 题未作答/无法判定").replace("{count}", String(items.filter((q) => q.isCorrect == null).length))}
                        </span>
                    </p>
                )}
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
                                {/* 批改判定徽章 */}
                                {q.isCorrect === true && (
                                    <Badge className="bg-green-600 text-white">{t.multiReview?.verdictCorrect || "答对"}</Badge>
                                )}
                                {q.isCorrect === false && (
                                    <Badge variant="destructive">{t.multiReview?.verdictWrong || "答错"}</Badge>
                                )}
                                {gradingMode && q.isCorrect == null && (
                                    <Badge variant="secondary">{t.multiReview?.verdictUnknown || "未作答/未知"}</Badge>
                                )}
                                {q.subject && <Badge variant="secondary">{q.subject}</Badge>}
                                {q.knowledgePoints?.map((kp) => (
                                    <Badge key={kp} variant="outline" className="font-normal">
                                        <InlineMath content={kp} />
                                    </Badge>
                                ))}
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto h-7 px-2 text-xs"
                                    onClick={() => toggleEditing(i)}
                                    disabled={saving}
                                >
                                    {editingItems.has(i) ? <><Eye className="mr-1 h-3.5 w-3.5" />预览</> : <><Pencil className="mr-1 h-3.5 w-3.5" />{t.common?.edit || "编辑"}</>}
                                </Button>
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {/* 批改模式：展示学生手写作答转录 */}
                            {q.wrongAnswerText && (
                                <p className="text-sm bg-muted/60 rounded px-3 py-2">
                                    <span className="text-muted-foreground">{t.multiReview?.studentAnswer || "学生作答"}：</span>
                                    <span className="font-medium">{q.wrongAnswerText}</span>
                                </p>
                            )}
                            {/* 本题图片：手动重裁 > 自动裁切预览；提供手动补充按钮兜底 */}
                            {(customImages[i] || previews?.[i] || pageOf(q)) && (
                                <div className="flex items-start gap-3">
                                    <img
                                        src={customImages[i] || previews?.[i] || pageOf(q) || ""}
                                        alt={`question-${i + 1}`}
                                        className="max-h-28 rounded border"
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={saving}
                                        onClick={() => setCropTarget(i)}
                                    >
                                        <ImagePlus className="mr-1 h-3.5 w-3.5" />
                                        {t.multiReview?.adjustImage || "手动裁图"}
                                    </Button>
                                </div>
                            )}
                            {editingItems.has(i) ? (
                                <>
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
                                </>
                            ) : (
                                <>
                                    <div className="rounded-md border bg-muted/20 px-3 py-2 min-w-0">
                                        <MarkdownRenderer content={q.questionText} />
                                    </div>
                                    <div className="grid gap-3 md:grid-cols-2">
                                        <div className="min-w-0">
                                            <p className="text-xs text-muted-foreground mb-1">{t.detail?.correctAnswer || "答案"}</p>
                                            <div className="rounded-md border bg-muted/20 px-3 py-2">
                                                <MarkdownRenderer content={q.answerText} />
                                            </div>
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-xs text-muted-foreground mb-1">{t.detail?.analysis || "解析"}</p>
                                            <div className="rounded-md border bg-muted/20 px-3 py-2">
                                                <MarkdownRenderer content={q.analysis} />
                                            </div>
                                        </div>
                                    </div>
                                </>
                            )}
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* 手动裁图：在整页原图上框选本题区域 */}
            {cropTarget !== null && pageOf(items[cropTarget]) && (
                <ImageCropper
                    imageSrc={pageOf(items[cropTarget])!}
                    open={cropTarget !== null}
                    onClose={() => setCropTarget(null)}
                    onCropComplete={handleManualCrop(cropTarget)}
                />
            )}

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
                            {(t.multiReview?.saveAll || "保存 {count} 道错题").replace("{count}", String(includedCount))}                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}
