/* Adapted from CookSleep/gpt_image_playground src/lib/agentAssistantBlocks.ts
 * commit 1e9d5af60aadd9117a835cc2da43908b8e3370dd, MIT, Copyright (c) 2026 CookSleep.
 * Existing IPL generation jobs replace source TaskRecord, preserving tool/text
 * order and missing image slots without displaying hidden reasoning items.
 */
import type { AgentOutputItem, AgentRound } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';

export type AgentAssistantBlock =
  | { type: 'text'; key: string; content: string }
  | { type: 'image-task'; key: string; task: GenerationJobRecord }
  | { type: 'deleted-image-task'; key: string; taskId: string }
  | { type: 'tool'; key: string; callId: string; name: string; state?: string };

function matchesCall(task: GenerationJobRecord, item: AgentOutputItem) {
  const link = task.metadata?.agent as Record<string, unknown> | undefined;
  const callId = item.type === 'image_generation_call' ? item.id : item.call_id;
  return Boolean(callId && link && [link.agentToolCallId, link.agentBatchCallId, link.toolCallId, link.callId].includes(callId));
}

function messagePartText(part: NonNullable<AgentOutputItem['content']>[number]): string {
  const text = part.type === 'output_text' || part.type === 'text' ? part.text || '' : part.type === 'refusal' ? part.refusal || '' : '';
  if (!text) return '';
  const links: string[] = [];
  const seen = new Set<string>();
  for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
    if (!annotation || annotation.type !== 'url_citation' || typeof annotation.url !== 'string') continue;
    try {
      const url = new URL(annotation.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href);
      // These provider-supplied values become Markdown. Escape the title and
      // destination so a citation cannot introduce extra links or inline HTML.
      const title = (typeof annotation.title === 'string' && annotation.title.trim() ? annotation.title : url.href)
        .replace(/\s+/g, ' ').replace(/([\\`*_{}\[\]()#+\-.!|<>~])/g, '\\$1');
      const href = url.href.replace(/[()\[\]<>\\"'`]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      links.push(`[${title}](${href})`);
    } catch { /* Ignore malformed citations without losing the model's text. */ }
  }
  return text + (links.length ? `\n\n${links.join(' · ')}` : '');
}

export function getAgentAssistantBlocks(round: AgentRound, tasks: GenerationJobRecord[], fallback: string): AgentAssistantBlock[] {
  const blocks: AgentAssistantBlock[] = [];
  const rendered = new Set<string>();
  const calls = new Set<string>();
  const slots = [...new Set(round.outputTaskIds)].map(id => ({ id, task: tasks.find(task => task.id === id) }));
  const pushSlot = (slot: typeof slots[number]) => {
    if (rendered.has(slot.id)) return;
    rendered.add(slot.id);
    blocks.push(slot.task ? { type: 'image-task', key: `image:${slot.id}`, task: slot.task } : { type: 'deleted-image-task', key: `missing:${slot.id}`, taskId: slot.id });
  };
  const output: AgentOutputItem[] = [];
  const messagePositions = new Map<string, number>();
  for (const item of round.responseOutput || []) {
    if ((item.type === 'message' || item.type === 'web_search_call') && item.id) {
      const identity = `${item.type}:${item.id}`;
      const previous = messagePositions.get(identity);
      if (previous !== undefined) { output[previous] = item; continue; }
      messagePositions.set(identity, output.length);
    }
    output.push(item);
  }
  for (const [index, item] of output.entries()) {
    if (item.type === 'message') {
      const text = (item.content || []).map(messagePartText).filter(Boolean).join('\n');
      if (text) blocks.push({ type: 'text', key: `text:${item.id || index}:${index}`, content: text });
    }
    if (item.type !== 'image_generation_call' && item.type !== 'function_call' && item.type !== 'web_search_call') continue;
    const id = item.call_id || item.id || `call-${index}`;
    if (calls.has(id)) continue;
    calls.add(id);
    blocks.push({ type: 'tool', key: `tool:${id}`, callId: id, name: item.type === 'web_search_call' ? 'web_search' : item.name || 'image_generation', state: item.status });
    const matchingSlots = slots.filter(slot => slot.task && matchesCall(slot.task, item));
    // A missing slot retains its place before the next still-identifiable call.
    const firstIndex = matchingSlots.length ? slots.indexOf(matchingSlots[0]) : -1;
    if (firstIndex >= 0) slots.slice(0, firstIndex).filter(slot => !slot.task).forEach(pushSlot);
    matchingSlots.forEach(pushSlot);
  }
  if (fallback && !blocks.some(block => block.type === 'text')) blocks.unshift({ type: 'text', key: 'text:fallback', content: fallback });
  slots.forEach(pushSlot);
  return blocks;
}

export const isAgentRequestActive = (state?: string) => ['queued', 'running', 'waiting_for_jobs', 'stop_requested'].includes(state || '');
