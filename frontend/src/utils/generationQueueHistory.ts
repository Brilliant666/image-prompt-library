import type { GenerationJobRecord, GenerationJobSetRecord, GenerationJobStatusCounts } from '../types';

const KEY = 'image-prompt-library:generation-queue-history:v1';
const MAX_ROWS = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE = 30 * 60 * 1000;
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'accepted', 'discarded', 'cancelled'] as const;
export interface GenerationQueueHistory {
  jobs: GenerationJobRecord[];
  generationSets: GenerationJobSetRecord[];
  statusCounts?: GenerationJobStatusCounts;
  total: number;
  savedAt: number;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/^\s*(?:data|blob):/i.test(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string => text(v, 64) && Number.isFinite(Date.parse(v));
const scopeValid = (v: unknown): v is string => text(v, 4096);
const pendingMutations = new Map<string, number>();
const mutationListeners = new Map<string, Map<symbol, (confirmed?: GenerationJobRecord | true) => void>>();

export function generationQueueMutationPending(scope?: string): boolean {
  return !!scope && (pendingMutations.get(scope) || 0) > 0;
}
export function subscribeGenerationQueueMutation(scope: string | undefined, owner: symbol, callback: (confirmed?: GenerationJobRecord | true) => void): () => void {
  if (!scopeValid(scope)) return () => undefined;
  const listeners = mutationListeners.get(scope) || new Map<symbol, (confirmed?: GenerationJobRecord | true) => void>();
  mutationListeners.set(scope, listeners);
  listeners.set(owner, callback);
  return () => {
    listeners.delete(owner);
    if (!listeners.size) mutationListeners.delete(scope);
  };
}
/** A server mutation outlives its initiating drawer. Keep remounts from trusting
 * pre-mutation reads, then notify only other live drawers for the same library. */
export function beginGenerationQueueMutation(scope: string | undefined, owner: symbol): (confirmed?: GenerationJobRecord | true) => void {
  if (!scopeValid(scope)) return () => undefined;
  const notify = (confirmed?: GenerationJobRecord | true) => mutationListeners.get(scope)?.forEach((callback, key) => { if (key !== owner) callback(confirmed); });
  pendingMutations.set(scope, (pendingMutations.get(scope) || 0) + 1);
  clearGenerationQueueHistory(scope);
  notify();
  let finished = false;
  return (confirmed) => {
    if (finished) return;
    finished = true;
    const count = (pendingMutations.get(scope) || 1) - 1;
    if (count) pendingMutations.set(scope, count);
    else pendingMutations.delete(scope);
    clearGenerationQueueHistory(scope);
    notify(confirmed);
  };
}

// A bounded display projection, never a recipe or authorization for a mutation.
function job(value: unknown): GenerationJobRecord | undefined {
  if (!record(value) || !text(value.id) || !text(value.provider, 128)
    || typeof value.prompt_text !== 'string' || !STATUSES.includes(value.status as typeof STATUSES[number])
    || !date(value.created_at) || !date(value.updated_at)) return;
  const out: GenerationJobRecord = {
    id: value.id, provider: value.provider, prompt_text: value.prompt_text.slice(0, 4096),
    status: value.status as string, created_at: value.created_at, updated_at: value.updated_at,
  };
  for (const key of ['model', 'mode', 'accepted_image_id', 'generation_group_id'] as const) {
    if (text(value[key])) out[key] = value[key];
  }
  if (typeof value.edited_prompt_text === 'string') out.edited_prompt_text = value.edited_prompt_text.slice(0, 4096);
  if (text(value.result_path, 2048) && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(value.result_path)
    && !/[?#]/.test(value.result_path) && !value.result_path.split(/[\\/]/).includes('..')) out.result_path = value.result_path;
  for (const key of ['generation_group_index', 'generation_group_size', 'result_width', 'result_height'] as const) {
    if (number(value[key])) out[key] = value[key];
  }
  for (const key of ['started_at', 'completed_at', 'accepted_at', 'discarded_at', 'cancelled_at'] as const) {
    if (date(value[key])) out[key] = value[key];
  }
  if (record(value.parameters)) {
    out.parameters = {};
    for (const key of ['quality', 'requested_aspect_ratio', 'orchestrator_model']) {
      if (text(value.parameters[key])) out.parameters[key] = value.parameters[key];
    }
  }
  if (record(value.metadata)) {
    out.metadata = {};
    for (const key of ['retry_of_generation_job_id', 'retried_by_generation_job_id', 'generation_group_id', 'retry_generation_group_id']) {
      if (text(value.metadata[key])) out.metadata[key] = value.metadata[key];
    }
    for (const key of ['generation_group_index', 'generation_group_size', 'retry_generation_group_index', 'retry_generation_group_size']) {
      if (number(value.metadata[key])) out.metadata[key] = value.metadata[key];
    }
    if (['failed_retry', 'discard_and_retry'].includes(String(value.metadata.retry_reason))) out.metadata.retry_reason = value.metadata.retry_reason;
  }
  return out;
}
function counts(value: unknown): GenerationJobStatusCounts | undefined {
  if (!record(value) || STATUSES.some(key => !number(value[key]))) return;
  return Object.fromEntries(STATUSES.map(key => [key, value[key]])) as unknown as GenerationJobStatusCounts;
}
function set(value: unknown): GenerationJobSetRecord | undefined {
  if (!record(value) || !text(value.generation_group_id) || !text(value.provider, 128) || !date(value.created_at)
    || !counts(value) || ['total', 'completed', 'remaining'].some(key => !number(value[key]))) return;
  return { generation_group_id: value.generation_group_id, provider: value.provider, created_at: value.created_at,
    ...counts(value)!, total: value.total as number, completed: value.completed as number, remaining: value.remaining as number, jobs: [] };
}
export function clearGenerationQueueHistory(scope?: string): void {
  try {
    if (scope) {
      const raw = sessionStorage.getItem(KEY);
      if (raw && JSON.parse(raw)?.scope !== scope) return;
    }
    sessionStorage.removeItem(KEY);
  } catch { /* Storage is optional. */ }
}
export function readGenerationQueueHistory(scope?: string): GenerationQueueHistory | undefined {
  if (!scopeValid(scope)) return;
  if (generationQueueMutationPending(scope)) return;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return;
    if (raw.length * 2 > MAX_BYTES) { clearGenerationQueueHistory(); return; }
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || value.scope !== scope) return;
    if (!Array.isArray(value.jobs) || value.jobs.length > MAX_ROWS || !number(value.total) || value.total < value.jobs.length
      || !Array.isArray(value.generationSets) || value.generationSets.length > MAX_ROWS
      || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt > Date.now() || Date.now() - value.savedAt > MAX_AGE) {
      clearGenerationQueueHistory(); return;
    }
    const jobs = value.jobs.map(job), generationSets = value.generationSets.map(set);
    if (jobs.some(v => !v) || generationSets.some(v => !v)
      || new Set(jobs.map(v => v?.id)).size !== jobs.length || (value.statusCounts !== undefined && !counts(value.statusCounts))) {
      clearGenerationQueueHistory(); return;
    }
    return { jobs: jobs as GenerationJobRecord[], generationSets: generationSets as GenerationJobSetRecord[],
      statusCounts: counts(value.statusCounts), total: value.total, savedAt: value.savedAt };
  } catch { clearGenerationQueueHistory(); return; }
}
export function saveGenerationQueueHistory(scope: string | undefined, value: Omit<GenerationQueueHistory, 'savedAt'>): void {
  if (!scopeValid(scope)) return;
  if (generationQueueMutationPending(scope)) return;
  try {
    const jobs = value.jobs.slice(0, MAX_ROWS).map(job);
    if (!number(value.total) || value.total < jobs.length || jobs.some(v => !v) || new Set(jobs.map(v => v?.id)).size !== jobs.length) return;
    const groupIds = new Set(jobs.map(v => v?.generation_group_id).filter(Boolean));
    const generationSets = value.generationSets.filter(v => groupIds.has(v.generation_group_id)).slice(0, MAX_ROWS).map(set).filter(Boolean);
    const raw = JSON.stringify({ version: 1, scope, jobs, generationSets, total: value.total,
      statusCounts: counts(value.statusCounts), savedAt: Date.now() });
    if (raw.length * 2 > MAX_BYTES) { clearGenerationQueueHistory(); return; }
    sessionStorage.setItem(KEY, raw);
  } catch { clearGenerationQueueHistory(); }
}
