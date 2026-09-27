import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/**
 * 修复 AI 生成的“伪表格”：连续的 `a | b | c` 行若缺少 Markdown 分隔行，
 * 自动在首行后插入 `|---|---|`（remark-gfm 才会将其识别为真表格）。
 */
export function fixMalformedTables(text: string): string {
    const lines = text.split('\n');
    // 表格行：≥2 个竖线且不含 LaTeX 定界符（避免把 $|x|$ 这类公式行当表格）
    const isTableRow = (s: string) => !s.includes('$') && (s.match(/\|/g) || []).length >= 2;
    const isSeparatorRow = (s: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && s.includes('-');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // 检测表格块起点：当前行像表格行，下一行也是表格行，且下一行不是分隔行
        if (
            isTableRow(line) &&
            i + 1 < lines.length &&
            isTableRow(lines[i + 1]) &&
            !isSeparatorRow(lines[i + 1]) &&
            !isSeparatorRow(line)
        ) {
            // 收集整个表格块
            const block: string[] = [];
            while (i < lines.length && isTableRow(lines[i])) {
                block.push(lines[i]);
                i++;
            }
            if (block.length >= 2) {
                // 规范化为 | cell | cell | 形式，并补分隔行
                const norm = block.map((row) => {
                    const cells = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
                    return `| ${cells.join(' | ')} |`;
                });
                const colCount = norm[0].split('|').length - 2;
                const sep = `| ${Array(colCount).fill('---').join(' | ')} |`;
                out.push(norm[0], sep, ...norm.slice(1));
                continue;
            }
            out.push(...block);
            continue;
        }
        out.push(line);
        i++;
    }
    return out.join('\n');
}

interface MarkdownRendererProps {
    content: string;
    className?: string;
}

export function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
    // Preprocess content to ensure proper paragraph breaks and LaTeX rendering
    // Convert single line breaks to double line breaks for better readability
    const processedContent = fixMalformedTables(content
        // First, convert literal \n sequences to actual newlines (fix for AI responses)
        .replace(/\\n/g, '\n')
        // Preserve existing double line breaks with a unique marker
        .replace(/\n\n/g, '\n\n###PRESERVE_BREAK###\n\n')
        // Convert patterns that should be new paragraphs
        .replace(/([。！？；])\n(?!\n)/g, '$1\n\n')  // Chinese punctuation followed by single newline
        .replace(/([.!?;])\s*\n(?!\n)/g, '$1\n\n')   // English punctuation followed by single newline
        .replace(/(\d+\))\s*\n(?!\n)/g, '$1\n\n')    // Numbered items like (1), (2)
        .replace(/([\u2460-\u2473])\s*\n(?!\n)/g, '$1\n\n')  // Circled numbers ①②③
        // Fix: Remove indentation for lines starting with circled numbers or (n) to prevent code block rendering
        .replace(/\n\s+([\u2460-\u2473])/g, '\n$1')
        .replace(/\n\s+(\d+\))/g, '\n$1')
        // Fix LaTeX formulas: Ensure proper spacing around $ delimiters
        // This handles cases where $ might be directly adjacent to text
        .replace(/([^\s$])(\$[^$]+\$)([^\s$])/g, '$1 $2 $3')
        // Restore preserved double line breaks (use flexible whitespace matching)
        .replace(/\s*###PRESERVE_BREAK###\s*/g, '\n\n')
    );

    return (
        <div className={`markdown-content overflow-x-auto min-w-0 ${className}`}>
            <ReactMarkdown
                remarkPlugins={[remarkMath, remarkGfm]}
                rehypePlugins={[rehypeKatex]}
                components={{
                    // 自定义样式
                    h1: ({ node, ...props }) => <h1 className="text-2xl font-bold mt-6 mb-4" {...props} />,
                    h2: ({ node, ...props }) => <h2 className="text-xl font-bold mt-5 mb-3" {...props} />,
                    h3: ({ node, ...props }) => <h3 className="text-lg font-bold mt-4 mb-2" {...props} />,
                    p: ({ node, ...props }) => <p className="mb-3 leading-relaxed" {...props} />,
                    ul: ({ node, ...props }) => <ul className="list-disc list-inside mb-3 space-y-1" {...props} />,
                    ol: ({ node, ...props }) => <ol className="list-decimal list-inside mb-3 space-y-1" {...props} />,
                    li: ({ node, ...props }) => <li className="ml-4" {...props} />,
                    blockquote: ({ node, ...props }) => (
                        <blockquote className="border-l-4 border-primary pl-4 italic my-4 text-muted-foreground" {...props} />
                    ),
                    code: ({ node, inline, className, children, ...props }: any) => {
                        if (inline) {
                            return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono text-foreground" {...props}>{children}</code>;
                        }
                        return (
                            <code className="block bg-muted p-4 rounded-lg overflow-x-auto my-3 font-mono text-sm" {...props}>
                                {children}
                            </code>
                        );
                    },
                    table: ({ node, ...props }) => (
                        <div className="overflow-x-auto my-4">
                            <table className="min-w-full border-collapse border border-border" {...props} />
                        </div>
                    ),
                    th: ({ node, ...props }) => (
                        <th className="border border-border px-4 py-2 bg-muted font-semibold text-left" {...props} />
                    ),
                    td: ({ node, ...props }) => (
                        <td className="border border-border px-4 py-2" {...props} />
                    ),
                    strong: ({ node, ...props }) => <strong className="font-bold text-foreground" {...props} />,
                    em: ({ node, ...props }) => <em className="italic" {...props} />,
                }}
            >
                {processedContent}
            </ReactMarkdown>
        </div>
    );
}
