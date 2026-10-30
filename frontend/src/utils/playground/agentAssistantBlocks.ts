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
    generate_image: '生成图片', generate_image_batch: '生成图片', image_generation: '生成图片',
    continue_generation: '继续生成图片', web_search: '网络搜索', read_agent_skill: '读取创作技能',
  };
  return labels[name] || '执行工具';
}

function matchesCall(task: GenerationJobRecord, item: AgentOutputItem) {
  const link = task.metadata?.agent as Record<string, unknown> | undefined;
  const callId = item.type === 'image_generation_call' ? item.id : item.call_id;
  return Boolean(callId && link && [link.agentToolCallId, link.agentBatchCallId, link.toolCallId, link.callId].includes(callId));
}

const imageJobToolNames = new Set(['generate_image', 'generate_image_batch', 'image_generation']);
// A continuation authorizes the next step; it does not create an image job.
export const isAgentImageTool = (name: string) => imageJobToolNames.has(name) || name === 'continue_generation';

/** One result-area status, based on actual jobs rather than authorization caps. */
export function getAgentImageProgress(round: AgentRound, tasks: GenerationJobRecord[], request?: AgentRequest | null): { text: string; kind: 'progress' | 'warning' | 'error' } | null {
  const ids = [...new Set(round.outputTaskIds)];
  const calls = (round.responseOutput || []).filter(item => item.type === 'image_generation_call' || item.type === 'function_call' && imageJobToolNames.has(item.name || ''));
  if (!ids.length && !calls.length) return null;
  const own = request?.id === round.requestId ? request : null;
  const jobs = ids.map(id => tasks.find(task => task.id === id));
  const count = (statuses: string[]) => jobs.filter(job => job && statuses.includes(job.status)).length;
  const succeeded = count(['succeeded', 'accepted']), failed = count(['failed']), stopped = count(['cancelled']);
  const missing = jobs.some(job => !job);
  const unknown = jobs.some(job => job?.status === 'unknown' || (job?.metadata?.failure as { outcomeUnknown?: boolean } | undefined)?.outcomeUnknown)
    || own?.state === 'unknown' || round.resultSummary?.outcomeUnknown;
  if (unknown) return { text: '图片结果未知；请先检查原请求状态，不会自动重发。', kind: 'warning' };
  if (missing) return { text: '图片结果未知：部分图片记录不可用；请查看回答详情，不会自动重发。', kind: 'warning' };
  if (own?.stopRequested || own?.state === 'stop_requested' || own?.state === 'stopped') {
    return { text: own.upstreamMayContinue ? '已停止后续调用；已发出的图片请求可能仍在继续，请先检查原请求状态。' : `图片生成已停止${succeeded ? `，已保留 ${succeeded} 张结果` : ''}。`, kind: 'warning' };
  }
  if (count(['running', 'queued'])) {
    const waiting = !count(['running']);
    return { text: ids.length === 1 ? (waiting ? '图片已排队，等待生成' : '正在生成图片')
      : `${waiting ? '等待生成' : '正在生成'} ${ids.length} 张 · 已完成 ${succeeded} 张${failed ? ` · 失败 ${failed} 张` : ''}`, kind: 'progress' };
  }
  if (ids.length && succeeded === ids.length) {
    const matched = calls.filter(call => jobs.some(job => job && matchesCall(job, call)));
    if (calls.length > matched.length && (round.status === 'running' || own?.state === 'running' || own?.state === 'waiting_for_jobs')) {
      return { text: `正在准备后续图片请求 · 已完成 ${succeeded} 张`, kind: 'progress' };
    }
    if (matched.length && calls.length > matched.length) return { text: `已保留 ${succeeded} 张结果；另有图片调用未获得结果，请查看回答详情。`, kind: 'warning' };
    return null;
  }
  if (succeeded) return { text: `部分图片生成成功 · 已完成 ${succeeded} / ${ids.length} 张${failed ? `，失败 ${failed} 张` : stopped ? `，停止 ${stopped} 张` : ''}`, kind: 'warning' };
  if (failed) return { text: '本次未生成图片，请查看结果卡中的失败原因。', kind: 'error' };
  if (stopped || round.resultSummary?.requestState === 'stopped') return { text: '图片生成已停止。', kind: 'warning' };
  if (count(['discarded'])) return { text: '图片结果已清理。', kind: 'warning' };
  if (round.failure || round.status === 'error' || own?.state === 'failed' || own?.state === 'interrupted') {
    const failure = getAgentFailure(round.failure || 'unknown');
    return { text: `${failure.label} · ${failure.detail || failure.action}`, kind: 'error' };
  }
  if (round.status === 'running' || own?.state === 'running' || own?.state === 'queued' || own?.state === 'waiting_for_jobs') {
    return { text: '正在准备图片请求', kind: 'progress' };
  }
  return { text: '未获得图片结果，请查看回答详情。', kind: 'warning' };
}

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
  if (summary.requestState === 'failed' || summary.requestState === 'interrupted') {
    if (!round.failure) return '本轮请求未完成';
    const failure = getAgentFailure(round.failure);
    return [failure.label, failure.detail].filter(Boolean).join(' · ');
  }
  if (round.execution && agentPhaseLabels[round.execution.phase]) return agentPhaseLabels[round.execution.phase];
  return summary.requestState === 'queued' ? '等待执行' : summary.requestState === 'running' ? '等待文字模型' : '已完成';
}

interface AgentFailureData { kind?: string; detail?: string; reasonProvided?: boolean; outcomeUnknown?: boolean }
export interface AgentFailurePresentation { label: string; action: string; kind: string; detail?: string }

/** A rejected request can finish before an image job exists. Never invent one. */
export function getAgentRequestFailure(round: AgentRound, request?: AgentRequest | null): AgentFailurePresentation | null {
  if (round.outputTaskIds.length || round.retryTaskIds?.length || !round.failure) return null;
  const own = request?.id === round.requestId ? request : null;
  const state = own?.state || round.resultSummary?.requestState || (round.status === 'error' ? 'failed' : round.status);
  if (!['failed', 'interrupted'].includes(state) || round.failure.outcomeUnknown
    || round.resultSummary?.outcomeUnknown || own?.stopRequested || own?.upstreamMayContinue) return null;
  const failure = getAgentFailure(round.failure);
  const imageCall = (round.responseOutput || []).some(item => item.type === 'image_generation_call'
    || item.type === 'function_call' && imageJobToolNames.has(item.name || ''));
  return failure.kind === 'unknown' && !imageCall && !round.directRecipe
    ? { ...failure, label: '本次请求未完成' } : failure;
}

export function getAgentJobFailure(job: GenerationJobRecord): AgentFailurePresentation {
  const value = getAgentFailure(job.metadata?.failure as AgentFailureData | undefined);
  return job.status === 'unknown' ? { ...value, label: '图片结果未知', action: '请先查看原请求状态，确认结果前不要重复生成。' } : value;
}

export function getAgentFailure(failure: string | AgentFailureData | null | undefined): AgentFailurePresentation {
  const data = typeof failure === 'string' ? { kind: failure } : failure;
  const kind = data?.kind || 'unknown';
  const messages: Record<string, [string, string]> = {
    quota: ['余额不足', '请检查生图供应商余额后再决定是否重试。'],
    authentication: ['认证或权限问题', '请检查供应商配置与访问权限。'],
    model_unsupported: ['模型或接口不支持', '请检查生图供应商与模型是否匹配。'],
    moderation: ['供应商审核拒绝', '可查看失败详情，或在对话中修改要求。'],
    rate_limit: ['供应商限流', '请稍后再决定是否重试。'],
    service: ['供应商服务暂时异常', '请稍后检查原请求状态。'],
    network: ['网络超时或连接中断', '请先检查原请求状态，避免重复生成。'],
    reference_missing: ['参考图片不可用', '请重新选择有效的参考图片。'],
    configuration: ['网络或请求配置需要检查', '请检查 API 配置后再发送；不会自动重试。'],
    request_too_large: ['请求内容过大', '请减少本次发送的图片或上下文内容后再试；不会自动重发。'],
    unknown: ['图片请求未完成', '请查看详情并检查原请求状态。'],
  };
  const [label, action] = messages[kind] || messages.unknown;
  // Only the backend's bounded, sanitized public detail is displayed. Never use
  // raw job.error, request.error.message or arbitrary provider response bodies.
  const detail = typeof data?.detail === 'string' && data.detail.trim()
    ? data.detail.trim().slice(0, 1600)
    : kind === 'moderation' ? '供应商未提供更具体的拒绝原因。' : undefined;
  return { label, action, kind: messages[kind] ? kind : 'unknown', ...(detail ? { detail } : {}) };
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
    const state = imageJobToolNames.has(name)
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
