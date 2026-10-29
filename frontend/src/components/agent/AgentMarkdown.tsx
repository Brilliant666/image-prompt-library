import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { AgentCodeBlock } from './AgentCodeBlock';
import { agentPromptBlock } from '../../utils/playground/agentPromptBlocks';

// Rendering works for saved answers too. mathFormattingPrompt only controls
// instructions sent to the model, not whether an existing formula is readable.
export function AgentMarkdown({ text, onSelectPrompt, promptSelectionDisabled = false }: { text: string; onSelectPrompt?: (text: string) => void; promptSelectionDisabled?: boolean }) {
  return <div className="agent-markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }]]}
    skipHtml
    components={{
      pre: ({ children, node }) => <AgentCodeBlock {...agentPromptBlock(text, node)} onSelectPrompt={onSelectPrompt} promptSelectionDisabled={promptSelectionDisabled}>{children}</AgentCodeBlock>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      // Model text cannot cause arbitrary remote image requests. Image results
      // use server-issued handles elsewhere in the workspace.
      img: ({ alt }) => <span className="agent-help">[图片链接：{alt || '未自动加载'}]</span>,
    }}
  >{text}</ReactMarkdown></div>;
}
