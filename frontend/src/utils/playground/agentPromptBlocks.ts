import type { Element } from 'hast';

const promptLanguages = new Set(['prompt', 'text', 'plaintext', 'txt']);

function adjacentPromptTitle(source: string, offset: number) {
  const line = source.slice(0, offset).trimEnd().split(/\r\n|\r|\n/).at(-1) || '';
  const title = line.trim().replace(/^#{1,6}\s+/, '').replace(/[:：]\s*$/, '').replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)$/, '$1').replace(/[:：]\s*$/, '');
  return /^(?:(?:原始|原文|反推|优化后|优化|执行|生成|中文|英文|中英双语|最终|可复制|生图)的?\s*)?提示词$/.test(title)
    || /^(?:(?:original|inferred|derived|optimized|final|image generation)\s+)?prompt$/i.test(title);
}

/** Read fence contents from source, so streaming and CRLF do not acquire the
 * extra terminal newline inserted by the Markdown renderer. Container prefixes
 * are Markdown syntax, not part of the prompt. Unknown containers use the
 * renderer's normal text instead of guessing which characters to remove. */
function sourceFenceText(source: string, node: Element): string | undefined {
  const start = node.position?.start.offset, end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;
  const raw = source.slice(start, end);
  const opening = /^(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n|$)/.exec(raw);
  if (!opening) return;
  const previous = source.slice(0, start);
  const prefix = previous.slice(Math.max(previous.lastIndexOf('\n'), previous.lastIndexOf('\r')) + 1);
  const spaces = /^ *$/.test(prefix);
  if (!spaces && !/^ {0,3}(?:>[ \t]*)+ *$/.test(prefix)) return;
  const lines = raw.slice(opening[0].length).match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || [];
  if (lines.at(-1) === '') lines.pop();
  const result: string[] = [];
  for (const line of lines) {
    if (spaces) result.push(line.replace(new RegExp(`^ {0,${prefix.length}}`), ''));
    else if (line.startsWith(prefix)) result.push(line.slice(prefix.length));
    else if (line.trim() === prefix.trim()) result.push(line.match(/\r\n|\r|\n$/)?.[0] || '');
    else return;
  }
  const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \t]*$`);
  if (result.length && closing.test(result[result.length - 1])) result.pop();
  return result.join('');
}

export function agentPromptBlock(source: string, node?: Element): { prompt: boolean; actionablePrompt?: boolean; copyText?: string } {
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  if (!code || code.type !== 'element' || !node) return { prompt: false };
  const classes = code.properties.className;
  const language = (Array.isArray(classes) ? classes : []).find(value => typeof value === 'string' && value.startsWith('language-'));
  const name = typeof language === 'string' ? language.slice('language-'.length).toLowerCase() : '';
  // An explicit programming language always wins over a nearby prompt heading.
  const titled = node.position?.start.offset !== undefined && adjacentPromptTitle(source, node.position.start.offset);
  const prompt = name ? promptLanguages.has(name) : titled;
  // Keep established plain-text copy styling, but a generic text/log fence is
  // not an instruction to turn that block into an executable image recipe.
  const actionablePrompt = prompt && (name === 'prompt' || titled);
  return prompt ? { prompt: true, actionablePrompt, copyText: sourceFenceText(source, node) } : { prompt: false };
}
