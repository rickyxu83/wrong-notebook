import { AIService } from "./types";
import { GeminiProvider } from "./gemini-provider";
import { OpenAIProvider } from "./openai-provider";
import { AzureOpenAIProvider } from "./azure-provider";

export * from "./types";

import { getAppConfig, getActiveOpenAIConfig, getMultiAnalyzeOpenAIConfig } from "../config";
import { createLogger } from "../logger";

const logger = createLogger('ai');

export function getAIService(): AIService {
    // Always get fresh config
    const config = getAppConfig();
    const provider = config.aiProvider;

    if (provider === "openai") {
        const activeConfig = getActiveOpenAIConfig();
        logger.info({ activeInstance: activeConfig?.name }, 'Using OpenAI Provider');
        return new OpenAIProvider(activeConfig);
    } else if (provider === "azure") {
        logger.info({ deployment: config.azure?.deploymentName }, 'Using Azure OpenAI Provider');
        return new AzureOpenAIProvider(config.azure);
    } else {
        logger.info('Using Gemini Provider');
        return new GeminiProvider(config.gemini);
    }
}

/**
 * 整卷拆分（多题识别）专用 AI 服务：坐标定位对模型能力要求高，
 * 可在设置中指定专用实例（如 Kimi），未配置时回退活跃实例。
 */
export function getAIServiceForMultiAnalyze(): AIService {
    const config = getAppConfig();
    if (config.aiProvider === 'openai') {
        const instance = getMultiAnalyzeOpenAIConfig();
        logger.info({ multiAnalyzeInstance: instance?.name }, 'Using OpenAI Provider for multi-analyze');
        return new OpenAIProvider(instance);
    }
    return getAIService();
}

