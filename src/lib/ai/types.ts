// Re-export the Zod-validated type from schema.ts
export type { ParsedQuestionFromSchema as ParsedQuestion } from './schema';
import type { ParsedQuestionFromSchema } from './schema';

// Import and re-export MistakeStatus from the single source of truth
import type { MistakeStatus } from '../mistake-status';
export type { MistakeStatus };

export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'harder';

export interface ReanswerQuestionResult {
    answerText: string;
    analysis: string;
    knowledgePoints: string[];
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: MistakeStatus;
}

export interface GeogebraAnalysisResult {
    suitable: boolean;
    commands: string[];
    description: string;
}

export interface AIService {
    analyzeImage(imageBase64: string, mimeType?: string, language?: 'zh' | 'en', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema>;
    /** 多题识别：整卷/整页照片中的所有题目拆分返回，一题一个元素。支持多页（传入数组） */
    analyzeImageMulti(imageBase64: string | string[], mimeType?: string, language?: 'zh' | 'en', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema[]>;
    /** 批改：已作答试卷识别全部题目 + 转录学生作答 + 逐题判定对错（isCorrect 字段）。支持多页 */
    gradeExamMulti(imageBase64: string | string[], mimeType?: string, language?: 'zh' | 'en', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema[]>;
    generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language?: 'zh' | 'en', difficulty?: DifficultyLevel, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema>;
    reanswerQuestion(questionText: string, language?: 'zh' | 'en', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult>;
    analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult>;
}

export interface AIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    // Azure OpenAI 特有字段
    azureDeployment?: string;   // Azure 部署名称
    azureApiVersion?: string;   // API 版本 (如 2024-02-15-preview)
}
