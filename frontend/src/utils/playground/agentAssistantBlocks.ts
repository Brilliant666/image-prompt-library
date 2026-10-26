/* Adapted from CookSleep/gpt_image_playground src/lib/agentAssistantBlocks.ts
 * commit 1e9d5af60aadd9117a835cc2da43908b8e3370dd, MIT, Copyright (c) 2026 CookSleep.
 * Existing IPL generation jobs replace source TaskRecord, preserving tool/text
 * order and missing image slots without displaying hidden reasoning items.
 */
import type { AgentOutputItem, AgentRound, AgentRequest, AgentResultSummary } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';

export type AgentAssistantBlock =
  | { type: 'text'; key: string; content: string }
  | { type: 'image-task'; key: string; task: GenerationJobRecord }
  | { type: 'deleted-image-task'; key: string; taskId: string }
  | { type: 'tool'; key: string; callId: string; name: string; state?: string };

export function getAgentToolLabel(name: string): string {
  const labels: Record<string, string> = {
    generate_image: '生成图片', generate_image_batch: '批量生成图片', image_generation: '生成图片',
    continue_generation: '继续生成图片', web_search: '网络搜索', read_agent_skill: '读取创作技能',
  };
  return labels[name] || '执行工具';
}

function matchesCall(task: GenerationJobRecord, item: AgentOutputItem) {
  const link = task.metadata?.agent as Record<string, unknown> | undefined;
  const callId = item.type === 'image_generation_call' ? item.id : item.call_id;
  return Boolean(callId && link && [link.agentToolCallId, link.agentBatchCallId, link.toolCallId, link.callId].includes(callId));
}

const imageToolNames = new Set(['generate_image', 'generate_image_batch', 'image_generation']);

/** A completed function-call payload only says the model finished its arguments. */
function imageToolState(tasks: GenerationJobRecord[], missing: boolean, pending: boolean): string {
  if (tasks.some(task => task.status === 'running')) return 'generating_images';
  if (tasks.some(task => task.status === 'queued')) return 'waiting_jobs';
  if (missing || tasks.some(task => task.status === 'unknown' || (task.metadata?.failure as { outcomeUnknown?: boolean } | undefined)?.outcomeUnknown)) return 'unknown';
  const succeeded = tasks.filter(task => ['succeeded', 'accepted'].includes(task.status)).length;
  if (succeeded === tasks.length && succeeded) return 'images_succeeded';
  if (succeeded) return 'images_partial';
  if (tasks.some(task => task.status === 'failed')) return 'images_failed';
  if (tasks.some(task => task.status === 'cancelled')) return 'stopped';
  if (tasks.some(task => task.status === 'discarded')) return 'discarded';
  return pending ? 'waiting_jobs' : 'unknown';
}

export const agentPhaseLabels: Record<string, string> = {
  preparing: '准备参考图', waiting_model: '等待文字模型', receiving_model: '接收回答',
  waiting_jobs: '等待图片任务', generating_images: '正在生成图片', processing_results: '保存图片结果',
  images_succeeded: '图片全部成功', images_partial: '图片部分成功', images_failed: '本次未生成图片',
  completed: '已完成', failed: '执行失败', stopped: '请求已停止', unknown: '结果未知', discarded: '图片已清理',
};

export function getAgentRoundSummary(round: AgentRound, tasks: GenerationJobRecord[], request?: AgentRequest | null): AgentResultSummary {
  if (round.resultSummary) return round.resultSummary;
  const ids = [...new Set(round.outputTaskIds)];
  const jobs = ids.map(id => tasks.find(task => task.id === id));
  const ownRequest = request?.id === round.requestId ? request : null;
  const count = (status: string) => jobs.filter(task => task?.status === status).length;
  const requestState = ownRequest?.state || (round.status === 'running' ? 'running' : round.status === 'error' ? 'failed' : 'completed');
  const missing = jobs.filter(job => !job).length;
  const outcomeUnknown = requestState === 'unknown' || Boolean(missing) || jobs.some(job => job?.status === 'unknown' || (job?.metadata?.failure as { outcomeUnknown?: boolean } | undefined)?.outcomeUnknown);
  return {
    requestState, textCompleted: requestState === 'completed', imageJobsCreated: ids.length,
    imageJobsQueued: count('queued'), imageJobsRunning: count('running'), imageJobsSucceeded: count('succeeded') + count('accepted'),
    imageJobsFailed: count('failed'), imageJobsCancelled: count('cancelled'), imageJobsAccepted: count('accepted'),
    imageJobsDiscarded: count('discarded'), imageJobsMissing: missing, outcomeUnknown,
    maxImageJobs: ownRequest?.authorization.maxImageJobs ?? null, outcome: '',
  };
}

export function getAgentRoundStatus(round: AgentRound, summary: AgentResultSummary): string {
  if (summary.outcomeUnknown) return agentPhaseLabels.unknown;
  if (summary.imageJobsRunning) return agentPhaseLabels.generating_images;
  if (summary.imageJobsQueued) return agentPhaseLabels.waiting_jobs;
  if (summary.imageJobsCreated) {
    if (summary.imageJobsSucceeded === summary.imageJobsCreated) return agentPhaseLabels.images_succeeded;
    if (summary.imageJobsSucceeded) return `图片部分成功，已保留 ${summary.imageJobsSucceeded} 张结果`;
    if (summary.imageJobsFailed) return agentPhaseLabels.images_failed;
    if (summary.imageJobsCancelled) return agentPhaseLabels.stopped;
    if (summary.imageJobsDiscarded) return agentPhaseLabels.discarded;
  }
  if (summary.requestState === 'stopped' || summary.requestState === 'stop_requested') return summary.requestState === 'stopped' ? agentPhaseLabels.stopped : '正在停止后续调用';
  if (summary.requestState === 'failed' || summary.requestState === 'interrupted') return round.failure ? getAgentFailure(round.failure.kind).label : '本轮请求未完成';
  if (round.execution && agentPhaseLabels[round.execution.phase]) return agentPhaseLabels[round.execution.phase];
  return summary.requestState === 'queued' ? '等待执行' : summary.requestState === 'running' ? '等待文字模型' : '已完成';
}

export function getAgentJobFailure(job: GenerationJobRecord): { label: string; action: string; kind: string } {
  const kind = (job.metadata?.failure as { kind?: string } | undefined)?.kind || 'unknown';
  return getAgentFailure(kind);
}

export function getAgentFailure(kind: string): { label: string; action: string; kind: string } {
  const messages: Record<string, [string, string]> = {
    quota: ['余额不足', '请检查生图供应商余额后再决定是否重试。'],
    authentication: ['认证或权限问题', '请检查供应商配置与访问权限。'],
    model_unsupported: ['模型或接口不支持', '请检查生图供应商与模型是否匹配。'],
    moderation: ['供应商审核拒绝', '请检查请求内容；不会自动改写或切换供应商。'],
    rate_limit: ['供应商限流', '请稍后再决定是否重试。'],
    service: ['供应商服务暂时异常', '请稍后检查原请求状态。'],
    network: ['网络超时或连接中断', '请先检查原请求状态，避免重复生成。'],
    reference_missing: ['参考图片不可用', '请重新选择有效的参考图片。'],
    unknown: ['图片请求未完成', '请查看详情并检查原请求状态。'],
  };
  const [label, action] = messages[kind] || messages.unknown;
  return { label, action, kind: messages[kind] ? kind : 'unknown' };
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
    const skillCompleted = item.name === 'read_agent_skill' && output.some(result => result.type === 'function_call_output' && result.call_id === id);
    const matchingSlots = slots.filter(slot => slot.task && matchesCall(slot.task, item));
    const name = item.type === 'web_search_call' ? 'web_search' : item.name || 'image_generation';
    const state = imageToolNames.has(name)
      ? imageToolState(matchingSlots.flatMap(slot => slot.task ? [slot.task] : []), slots.some(slot => !slot.task), round.status === 'running')
      : skillCompleted ? 'completed' : item.status;
    blocks.push({ type: 'tool', key: `tool:${id}`, callId: id, name, state });
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
