import type { AgentRoundCreate } from '../../api/agentClient';
import type { ReferenceChoice } from './agentImageReferences';

export interface AgentDraft {
  text: string;
  refs: ReferenceChoice[];
  params: AgentRoundCreate['params'];
  imageConfig?: AgentRoundCreate['imageConfig'];
  sizeMode?: 'auto4k';
  editId: string | null;
  origin: AgentRoundCreate['origin'];
  contextScope?: NonNullable<AgentRoundCreate['contextScope']>;
  historyRoundIds?: string[];
}
export const AGENT_DRAFT_KEY = 'ipl.agent.drafts.v1';
export const AGENT_IMAGE_MODE_PREFIX = 'ipl.agent.image-mode.v1.';

// Store explicit conversation preferences separately from drafts and frozen
// request permissions. An unsent new conversation must never inherit a mode.
export function readAgentImageMode(storage: Pick<Storage, 'getItem'>, conversationId: string): boolean {
  try { return Boolean(conversationId && conversationId !== 'new' && storage.getItem(AGENT_IMAGE_MODE_PREFIX + conversationId) === 'true'); }
  catch { return false; }
}

export function saveAgentImageMode(storage: Pick<Storage, 'setItem' | 'removeItem'>, conversationId: string, enabled: boolean): void {
  if (!conversationId || conversationId === 'new') return;
  // Independent keys prevent another tab updating a different conversation
  // from restoring a choice this tab has just switched off.
  const key = AGENT_IMAGE_MODE_PREFIX + conversationId;
  if (enabled) storage.setItem(key, 'true');
  else storage.removeItem(key);
}

export function acknowledgeAgentDraft(draft: AgentDraft, clearInput: boolean): AgentDraft {
  return { ...draft, ...(clearInput ? { text: '', refs: [] } : {}), origin: 'send', editId: null };
}

export function readAgentDrafts(storage: Pick<Storage, 'getItem'>, enabled: boolean): Record<string, AgentDraft> {
  if (!enabled) return {};
  try {
    const value = JSON.parse(storage.getItem(AGENT_DRAFT_KEY) || '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const output: Record<string, AgentDraft> = {};
    for (const [id, draft] of Object.entries(value)) {
      if (!draft || typeof draft !== 'object' || typeof draft.text !== 'string' || !Array.isArray(draft.refs) || !draft.params || typeof draft.params !== 'object' || typeof draft.params.size !== 'string' || typeof draft.params.quality !== 'string') continue;
      if (!draft.refs.every((ref: ReferenceChoice) => ref && typeof ref === 'object' && typeof ref.label === 'string' && typeof ref.url === 'string' && ref.reference && (ref.reference.kind === 'library' && typeof ref.reference.imageId === 'string' || ref.reference.kind === 'job' && typeof ref.reference.jobId === 'string' || ref.reference.kind === 'upload' && typeof ref.reference.uploadId === 'string'))) continue;
      if (!['send', 'edit', 'regenerate'].includes(draft.origin) || (draft.editId !== null && typeof draft.editId !== 'string')) continue;
      // Older drafts have no context choice. Invalid stored scopes must never
      // silently widen a new request to the complete branch.
      output[id] = { ...draft,
        ...('contextScope' in draft ? { contextScope: ['task', 'selected', 'branch'].includes(draft.contextScope) ? draft.contextScope : 'task' } : {}),
        ...('historyRoundIds' in draft ? { historyRoundIds: Array.isArray(draft.historyRoundIds) ? draft.historyRoundIds.filter((roundId: unknown) => typeof roundId === 'string') : [] } : {}),
      };
    }
    return output;
  } catch { return {}; }
}

export interface PendingAgentSubmission { conversationId: string; payload: AgentRoundCreate; preserveDraft?: boolean }
const JOURNAL = 'ipl.agent.pending-submissions.v1';

// A safety journal is independent from the optional draft preference. A reload
// after an uncertain POST must still show the original text and selected IDs.
export function draftFromPendingAgentSubmission(entry: PendingAgentSubmission, previous?: AgentDraft): AgentDraft {
  const { payload } = entry;
  return {
    text: payload.prompt,
    refs: payload.refs.map(reference => {
      const prior = previous?.refs.find(choice => JSON.stringify(choice.reference) === JSON.stringify(reference));
      return prior ? structuredClone(prior) : { reference: structuredClone(reference), label: '已冻结的参考图', url: '' };
    }),
    params: structuredClone(payload.params),
    ...(payload.imageConfig ? { imageConfig: structuredClone(payload.imageConfig) } : {}),
    editId: payload.derivedFromRoundId || null,
    origin: payload.origin,
    ...(payload.contextScope ? { contextScope: payload.contextScope } : {}),
    ...(payload.historyRoundIds ? { historyRoundIds: [...payload.historyRoundIds] } : {}),
  };
}

// Only uncertain, user-submitted requests live here. Images, responses and all
// model credentials stay on the backend; reloading never dispatches this data.
export function readPendingAgentSubmissions(storage: Pick<Storage, 'getItem'>): PendingAgentSubmission[] {
  try {
    const value = JSON.parse(storage.getItem(JOURNAL) || '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is PendingAgentSubmission => Boolean(entry && typeof entry === 'object' && typeof entry.conversationId === 'string' && typeof entry.payload?.requestId === 'string' && typeof entry.payload?.prompt === 'string' && Array.isArray(entry.payload?.refs)));
  } catch { return []; }
}

export function savePendingAgentSubmission(storage: Pick<Storage, 'getItem' | 'setItem'>, entry: PendingAgentSubmission): void {
  const existing = readPendingAgentSubmissions(storage);
  const previous = existing.find(item => item.payload.requestId === entry.payload.requestId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error('同一请求 ID 的冻结内容不能改变。');
  storage.setItem(JOURNAL, JSON.stringify([...existing.filter(item => item.payload.requestId !== entry.payload.requestId), structuredClone(entry)]));
}

export function clearPendingAgentSubmission(storage: Pick<Storage, 'getItem' | 'setItem'>, requestId: string) {
  storage.setItem(JOURNAL, JSON.stringify(readPendingAgentSubmissions(storage).filter(item => item.payload.requestId !== requestId)));
}

export function getAgentResumeId(storage: Pick<Storage, 'getItem' | 'setItem'>, requestId: string, createId: () => string): string {
  const key = `ipl.agent.resume.${requestId}`;
  const existing = storage.getItem(key);
  if (existing) return existing;
  const id = createId(); storage.setItem(key, id); return id;
}

export function shouldSubmitAgentOnKey(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean; keyCode?: number }, enterSubmit: boolean) {
  if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return false;
  return enterSubmit ? !event.shiftKey : event.ctrlKey || event.metaKey;
}
