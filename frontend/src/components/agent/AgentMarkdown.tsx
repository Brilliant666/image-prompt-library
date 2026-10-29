import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { AgentCodeBlock } from './AgentCodeBlock';
import { agentPromptBlock } from '../../utils/playground/agentPromptBlocks';

// Rendering works for saved answers too. mathFormattingPrompt only controls
// instructions sent to the model, not whether an existing formula is readable.
export function AgentMarkdown({ text, onSelectPrompt, onOptimizePrompt, onGeneratePrompt, sourceId, getGenerationSummary, referenceSummary, promptSelectionDisabled = false }: { text: string; onSelectPrompt?: (text: string) => void; onOptimizePrompt?: (text: string) => void; onGeneratePrompt?: (text: string) => void; sourceId?: string; getGenerationSummary?: (text: string) => string; referenceSummary?: string; promptSelectionDisabled?: boolean }) {
  return <div className="agent-markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }]]}
    skipHtml
    components={{
      pre: ({ children, node }) => { const block = agentPromptBlock(text, node); return <AgentCodeBlock {...block} onSelectPrompt={onSelectPrompt} onOptimizePrompt={block.actionablePrompt ? onOptimizePrompt : undefined} onGeneratePrompt={block.actionablePrompt ? onGeneratePrompt : undefined} sourceId={`${sourceId || "answer"}:${node?.position?.start.offset ?? "unknown"}`} generationSummary={block.actionablePrompt && block.copyText ? getGenerationSummary?.(block.copyText) : undefined} referenceSummary={referenceSummary} promptSelectionDisabled={promptSelectionDisabled}>{children}</AgentCodeBlock>; },
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      // Model text cannot cause arbitrary remote image requests. Image results
      // use server-issued handles elsewhere in the workspace.
      img: ({ alt }) => <span className="agent-help">[图片链接：{alt || '未自动加载'}]</span>,
    }}
  >{text}</ReactMarkdown></div>;
}
