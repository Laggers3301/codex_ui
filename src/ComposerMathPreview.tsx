import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMathMarkdown } from "./markdown";

export function ComposerMathPreview({ value }: { value: string }) {
  return <div className="composerMathPreview" role="region" aria-label="草稿预览">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}>
      {normalizeMathMarkdown(value, true)}
    </ReactMarkdown>
  </div>;
}
