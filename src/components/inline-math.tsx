import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from '@/components/markdown-renderer';

/**
 * 行内渲染含 LaTeX 的短文本（如知识点标签 "速度公式 $v=\frac{s}{t}$ 的应用"）。
 * 与 MarkdownRenderer 的区别：不产生块级元素（p → span），可嵌入 Badge 等行内容器。
 */
export function InlineMath({ content }: { content: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
                p: ({ node, ...props }) => <span {...props} />,
            }}
        >
            {normalizeMathDelimiters(content)}
        </ReactMarkdown>
    );
}
