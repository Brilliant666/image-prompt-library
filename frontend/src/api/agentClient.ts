import type { GenerationJobRecord, OpenAICompatibleProfile } from '../types';
import type { AgentReference } from '../utils/playground/agentImageReferences';
import { acceptAgentSnapshot, applyAgentProgress, type AgentProgressState } from './agentProgress';

export interface AgentConfig {
  apiConfigMode: 'off' | 'native' | 'hybrid';
  textProfileId: string | null;
  imageProfileId: string | null;
  textModel: string;
  imageModel: string;
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  stream: boolean;
  partialImages: 0 | 1 | 2 | 3;
  maxToolRounds: number;
  maxImageJobs: number;
  webSearch: boolean;
  mathFormattingPrompt: boolean;
  professionalPromptWorkflows: boolean;
  experimentalImageDeduplication?: boolean;
}
export interface AgentConfigResponse {
  revision: number;
  config: AgentConfig;
  profiles: OpenAICompatibleProfile[];
  capabilities: { modes: Array<AgentConfig['apiConfigMode']>; maxInputImages: number; maxToolRounds: number; maxImageJobs: number; webSearch: boolean; masks: boolean; progressTransport: 'poll' | 'sse' };
  ready: boolean;
  imageReady: boolean;
  imageIssues: Array<{ code: string; field: string | null; message: string }>;
  issues: Array<{ code: string; field: string | null; message: string }>;
}
export interface AgentImage {
  id: string; source: AgentReference; status: 'available' | 'pending' | 'removed';
  url: string | null; thumbnailUrl: string | null; mimeType: string | null;
  width: number | null; height: number | null; sha256: string | null;
}
export interface AgentOutputItem {
  id?: string; type: string; call_id?: string; name?: string; status?: string;
  arguments?: string; content?: Array<{ type: string; text?: string; refusal?: string; annotations?: Array<{ type: string; url?: string; title?: string }> }>;
}
export interface AgentModelInfo {
  requestedModel: string | null;
  providerName: string | null;
  returnedModels: string[];
}
export interface AgentTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}
export interface AgentResponseDetails {
  version: 1;
  steps: Array<{
    id: string; step: number; kind: 'model' | 'native_image';
    responseId: string | null; model: string | null;
    usage: AgentTokenUsage; summaries: string[];
  }>;
  usage: AgentTokenUsage & { reportedSteps: number; totalSteps: number; complete: boolean };
  skills: Array<{ skill: string; section: string; title: string; source: string; revision: string; license: string }>;
}
export interface AgentResultSummary {
  requestState: AgentRequest['state']; textCompleted: boolean;
  imageJobsCreated: number; imageJobsQueued: number; imageJobsRunning: number;
  imageJobsSucceeded: number; imageJobsFailed: number; imageJobsCancelled: number;
  imageJobsAccepted: number; imageJobsDiscarded: number; imageJobsMissing: number;
  outcomeUnknown: boolean; maxImageJobs: number | null; outcome: string;
}
export interface AgentExecution {
  version: 1;
  phase: 'preparing' | 'waiting_model' | 'receiving_model' | 'waiting_jobs' | 'generating_images' | 'processing_results' | 'completed' | 'failed' | 'stopped' | 'unknown';
  timings: { preparationMs: number | null; modelHeadersMs: number | null; modelFirstEventMs: number | null; modelResponseMs: number | null; toolsMs: number | null; resultProcessingMs: number | null };
  modelSteps: Array<{
    step: number; state: string; preparationMs: number | null; headersMs: number | null; firstEventMs: number | null; responseMs: number | null;
    connectionMs?: number | null; tlsMs?: number | null; uploadMs?: number | null; waitHeadersMs?: number | null; requestBytes?: number | null;
  }>;
}
export interface AgentRound {
  id: string; index: number; parentRoundId: string | null; userMessageId: string; assistantMessageId?: string;
  prompt: string; inputImageIds: string[]; taskImageIds?: string[]; maskTargetImageId: string | null; maskImageId: string | null;
  outputTaskIds: string[]; responseId?: string; responseOutput?: AgentOutputItem[];
  status: 'running' | 'done' | 'error'; error: string | null; createdAt: number; finishedAt: number | null;
  requestId: string; derivedFromRoundId?: string | null;
  modelInfo?: AgentModelInfo;
  responseDetails?: AgentResponseDetails;
  resultSummary?: AgentResultSummary;
  execution?: AgentExecution | null;
  failure?: { kind: string; message: string; outcomeUnknown: boolean } | null;
  retryTaskIds?: string[];
  editingTask?: AgentEditingTask | null;
  taskContext?: AgentTaskContext | null;
}
export type AgentContextScope = 'task' | 'selected' | 'branch';
export interface AgentTaskPromptSource { kind: 'user' | 'model' | 'legacy'; roundId: string | null; messageId?: string }
export interface AgentTaskPromptVersion { id: string; text: string; kind: 'original' | 'candidate' | 'selected' | 'executed'; source: AgentTaskPromptSource; confirmedBy?: 'user' | null }
export interface AgentTaskContext {
  schemaVersion: 1; taskId: string; revision: number; branchRoundId: string | null;
  taskType: 'chat' | 'image_edit' | 'image_generation' | 'prompt' | 'analysis' | 'reverse' | 'prompt_optimization';
  startRoundId?: string | null; sourceRoundIds?: string[]; targetExplicit?: boolean;
  target: { assetId: string; source: AgentReference } | null;
  auxiliaries: Array<{ assetId: string; source: AgentReference; role: AgentReferenceRole }>;
  promptVersions: AgentTaskPromptVersion[];
  originalPromptVersionId: string | null; selectedPromptVersionId: string | null; executedPromptVersionId: string | null;
  constraints: Array<{ id: string; text: string; status: 'active' | 'proposed' | 'revoked'; source: AgentTaskPromptSource }>;
  latestUserAddition: { text: string; roundId: string } | null;
  unresolvedItems: string[]; completeness: 'complete' | 'partial' | 'history_required';
  historyDependencies: Array<{ roundId: string; reason: string }>;
}
export type AgentTaskContextOperation =
  | { op: 'new_task'; text?: string; taskType?: AgentTaskContext['taskType'] }
  | { op: 'set_task_type'; taskType: AgentTaskContext['taskType'] }
  | { op: 'set_target'; ref: AgentReference | null }
  | { op: 'set_auxiliaries'; auxiliaries: Array<{ ref: AgentReference; role: AgentReferenceRole }> }
  | { op: 'add_constraint'; text: string }
  | { op: 'update_constraint'; id: string; text: string }
  | { op: 'revoke_constraint'; id: string }
  | { op: 'set_prompt'; text: string; kind: 'candidate' | 'selected'; source?: { kind: 'user' | 'model'; roundId: string; messageId?: string } }
  | { op: 'select_prompt' | 'restore_prompt'; id: string }
  | { op: 'set_unresolved'; items: string[] };
export type AgentReferenceRole = 'lighting' | 'style' | 'subject' | 'composition' | 'other';
export interface AgentEditingTaskInput {
  target: AgentReference | null;
  auxiliaries: Array<{ ref: AgentReference; role: AgentReferenceRole }>;
  requirements: string; constraints: string[];
  workflow: 'auto' | 'image-prompt-reverse' | 'gpt-image';
}
export interface AgentEditingTask {
  version: 1; conversationId: string; branchRoundId: string | null;
  target: { assetId: string; source: AgentReference } | null;
  auxiliaries: Array<{ assetId: string; source: AgentReference; role: AgentReferenceRole }>;
  requirements: string; constraints: string[]; workflow: AgentEditingTaskInput['workflow'];
  needsTargetSelection: boolean;
  configIdentity: { mode: AgentConfig['apiConfigMode']; textProfileId: string | null; textModel: string; imageProfileId: string | null; imageModel: string };
}
export interface AgentImageRetryInput {
  retryId: string; conversationId: string; configRevision: number;
  imageConfig: { profileId?: string | null; model: string };
  params: AgentImageParams; confirmed: true;
}
export interface AgentImageRetryReceipt { retryId: string; sourceJobId: string; job: GenerationJobRecord }
export interface AgentMessage {
  id: string; role: 'user' | 'assistant'; content: string; roundId: string;
  inputImageIds?: string[]; outputTaskIds?: string[]; createdAt: number;
}
export interface AgentConversation {
  id: string; title: string; activeRoundId: string | null; createdAt: number; updatedAt: number;
  rounds: AgentRound[]; messages: AgentMessage[];
}
export interface AgentConversationSummary {
  id: string; title: string; activeRoundId: string | null; createdAt: number; updatedAt: number;
  roundCount: number; runningRequestId: string | null; revision: number;
}
export interface AgentImageParams {
  size: string; quality: string; output_format: 'png' | 'jpeg' | 'webp';
  output_compression?: number | null; moderation?: string; background?: string;
}
export interface AgentRoundCreate {
  requestId: string; expectedRevision: number; parentRoundId: string | null;
  origin: 'send' | 'edit' | 'regenerate'; derivedFromRoundId?: string | null;
  prompt: string; refs: AgentReference[]; mask?: { targetRefIndex: number; uploadId: string } | null;
  configRevision: number; activeProfileId?: string | null; params: AgentImageParams;
  imageCount?: 1 | 3 | 5 | 10;
  imageConfig?: { profileId?: string | null; model: string };
  contextScope?: AgentContextScope;
  historyRoundIds?: string[];
  taskRevision?: number | null;
  authorization: { scope: 'this_request'; allowImageGeneration: boolean; allowWebSearch: boolean; maxToolRounds: number; maxImageJobs: number };
}
export interface AgentToolCall {
  id: string; step: number; callId: string; name: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  itemIds: string[]; jobIds: string[]; error: string | null;
}
export interface AgentRequest {
  id: string; conversationId: string; roundId: string;
  params: AgentImageParams;
  state: 'queued' | 'running' | 'waiting_for_jobs' | 'stop_requested' | 'completed' | 'stopped' | 'failed' | 'interrupted' | 'unknown';
  frozenConfig: AgentConfig & { textProfileFingerprint: string; imageProfileFingerprint: string | null };
  authorization: AgentRoundCreate['authorization'];
  usage: { responseStepsStarted: number; imageJobsCreated: number };
  toolCalls: AgentToolCall[];
  modelInfo?: AgentModelInfo;
  canResume: boolean; recoveryReason: string | null; upstreamOutcome: 'not_sent' | 'known' | 'unknown';
  stopRequested: boolean; upstreamMayContinue: boolean; error: { code: string; message: string } | null;
}
export interface AgentSnapshot {
  schemaVersion: 1; revision: number; conversation: AgentConversation; request: AgentRequest | null;
  jobs: GenerationJobRecord[]; images: AgentImage[];
  editingTask?: AgentEditingTask | null;
  taskContext?: AgentTaskContext | null;
  contextMode?: 'task' | 'legacy';
}

export class AgentApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'AgentApiError'; }
}

async function request<T>(path: string, init: RequestInit = {}, prefix = '/api/agent'): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  try {
    // No automatic retry, including after a timeout. Mutating submissions retain
    // their original request ID in the workspace's uncertain-submission journal.
    const response = await fetch(`${prefix}${path}`, {
      ...init, signal, credentials: 'same-origin',
      headers: init.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { detail?: unknown } | null;
      const detail = data?.detail;
      const value = typeof detail === 'object' && detail !== null ? detail as { code?: string; message?: string } : null;
      throw new AgentApiError(response.status, value?.code || 'request_failed', value?.message || (typeof detail === 'string' ? detail : `请求未完成（HTTP ${response.status}）`));
    }
    return response.json() as Promise<T>;
  } finally { clearTimeout(timer); }
}

export const getAgentConfig = (signal?: AbortSignal) => request<AgentConfigResponse>('/config', { signal });
export const saveAgentConfig = (expectedRevision: number, config: AgentConfig, signal?: AbortSignal) => request<AgentConfigResponse>('/config', { method: 'PUT', signal, body: JSON.stringify({ expectedRevision, config }) });

// Observe an already accepted request. Reconnection/fallback may only read it;
// they must never retry the provider POST or recreate a conversation/round.
export function watchAgentRequest(id: string, onSnapshot: (value: AgentSnapshot) => void, onError: (reason: unknown) => void, useStream = true): () => void {
  let disposed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let state: AgentProgressState | undefined;
  let resyncs = 0;
  const controller = new AbortController();
  const active = (value: AgentSnapshot) => ['queued', 'running', 'waiting_for_jobs', 'stop_requested'].includes(value.request?.state || '');
  const stopStream = () => { source?.close(); source = undefined; clearTimeout(watchdog); };
  const close = () => { disposed = true; stopStream(); clearTimeout(timer); controller.abort(); };
  const accept = (value: AgentSnapshot) => {
    if (disposed || value.request?.id !== id) return;
    onSnapshot(value);
    if (!active(value)) close();
  };
  const poll = async () => {
    try { accept(await agentApi.request(id, controller.signal)); }
    catch (reason) { if (!disposed) onError(reason); }
    if (!disposed) timer = setTimeout(poll, 1200);
  };
  const fallback = () => {
    if (disposed || polling) return;
    polling = true; stopStream(); void poll();
  };
  const heartbeat = () => { if (disposed || polling) return; clearTimeout(watchdog); watchdog = setTimeout(fallback, 20_000); };
  const openStream = () => {
    try {
      const stream = new EventSource(`/api/agent/requests/${encodeURIComponent(id)}/events`);
      source = stream;
      const live = () => !disposed && !polling && source === stream;
      const resync = () => {
        if (!live()) return;
        stopStream(); state = undefined;
        // A new GET establishes an epoch from persisted state. If a bounded
        // baseline stays unavailable, settle on read-only polling.
        if (++resyncs > 2) fallback(); else timer = setTimeout(openStream, 100);
      };
      const receive = (kind: 'snapshot' | 'patch', event: Event) => {
        if (!live()) return;
        try {
          const data = (event as MessageEvent).data as string;
          if (typeof data !== 'string' || data.length > (kind === 'patch' ? 512 * 1024 : 8 * 1024 * 1024)) { fallback(); return; }
          const result = kind === 'snapshot' ? acceptAgentSnapshot(JSON.parse(data), id) : applyAgentProgress(state, JSON.parse(data), id);
          heartbeat();
          if (result.kind === 'resync') { resync(); return; }
          if (result.kind === 'applied') { state = result.state; accept(state.snapshot); }
        } catch { fallback(); }
      };
      stream.addEventListener('snapshot', event => receive('snapshot', event));
      stream.addEventListener('patch', event => receive('patch', event));
      stream.addEventListener('resync', resync);
      stream.addEventListener('fallback', () => { if (live()) fallback(); });
      stream.addEventListener('heartbeat', () => { if (live()) heartbeat(); });
      stream.onerror = () => { if (live()) fallback(); };
      heartbeat();
    } catch { fallback(); }
  };
  if (useStream && typeof EventSource !== 'undefined') openStream(); else fallback();
  return close;
}

export const agentApi = {
  updateTaskContext: (id: string, payload: { expectedRevision: number; branchRoundId: string | null; taskRevision: number | null; operations: AgentTaskContextOperation[] }) => request<AgentSnapshot>(`/conversations/${encodeURIComponent(id)}/task-context`, { method: 'PATCH', body: JSON.stringify(payload) }),
  updateEditingTask: (id: string, payload: { expectedRevision: number; branchRoundId: string | null; task: AgentEditingTaskInput | null }) => request<AgentSnapshot>(`/conversations/${encodeURIComponent(id)}/editing-task`, { method: 'PATCH', body: JSON.stringify(payload) }),
  retryImage: (jobId: string, payload: AgentImageRetryInput) => request<AgentImageRetryReceipt>(`/${encodeURIComponent(jobId)}/retry-current`, { method: 'POST', body: JSON.stringify(payload) }, '/api/generation-jobs'),
  imageRetryReceipt: (retryId: string, conversationId: string) => request<AgentImageRetryReceipt>(`/retry-submissions/${encodeURIComponent(retryId)}?conversation_id=${encodeURIComponent(conversationId)}`, {}, '/api/generation-jobs'),
  conversations: (cursor?: string, signal?: AbortSignal, query?: string) => request<{ conversations: AgentConversationSummary[]; nextCursor: string | null }>(`/conversations?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${query?.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`, { signal }),
  createConversation: (id: string, title?: string) => request<AgentSnapshot>('/conversations', { method: 'POST', body: JSON.stringify({ id, title }) }),
  conversation: (id: string, signal?: AbortSignal) => request<AgentSnapshot>(`/conversations/${encodeURIComponent(id)}`, { signal }),
  updateConversation: (id: string, payload: { expectedRevision: number; title?: string; activeRoundId?: string | null }) => request<AgentSnapshot>(`/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteConversation: (id: string) => request<{ id: string; deleted: true }>(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  submit: (conversationId: string, payload: AgentRoundCreate) => request<AgentSnapshot>(`/conversations/${encodeURIComponent(conversationId)}/rounds`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteRound: (conversationId: string, roundId: string) => request<AgentSnapshot>(`/conversations/${encodeURIComponent(conversationId)}/rounds/${encodeURIComponent(roundId)}`, { method: 'DELETE' }),
  request: (id: string, signal?: AbortSignal) => request<AgentSnapshot>(`/requests/${encodeURIComponent(id)}`, { signal }),
  stop: (id: string) => request<AgentSnapshot>(`/requests/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' }),
  resume: (id: string, resumeId: string) => request<AgentSnapshot>(`/requests/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ resumeId }) }),
  upload: (file: File, kind: 'reference' | 'mask' = 'reference') => {
    const body = new FormData(); body.append('file', file); body.append('kind', kind);
    return request<{ uploadId: string; image: AgentImage }>('/uploads', { method: 'POST', body });
  },
};
