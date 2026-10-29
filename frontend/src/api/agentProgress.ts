import type { AgentConversation, AgentMessage, AgentRound, AgentSnapshot } from './agentClient';

// A connection owns a bounded current-round view. Canonical history stays in
// the snapshot; patch paths can never reach another round or arbitrary objects.
export interface AgentProgressView {
  revision: number;
  conversation: Omit<AgentConversation, 'rounds' | 'messages'>;
  request: NonNullable<AgentSnapshot['request']>;
  editingTask: AgentSnapshot['editingTask'];
  taskContext?: AgentSnapshot['taskContext'];
  contextMode?: AgentSnapshot['contextMode'];
  round: AgentRound;
  messages: AgentMessage[];
  images: AgentSnapshot['images'];
  jobs: AgentSnapshot['jobs'];
}
interface Identity { version: 1; epoch: string; sequence: number; requestId: string; conversationId: string; roundId: string }
export interface AgentProgressBaseline extends Identity { view: AgentProgressView }
export interface AgentProgressState { snapshot: AgentSnapshot; stream?: AgentProgressBaseline }
type Operation = { op: 'replace'; path: Array<string | number>; value: unknown } | { op: 'append'; path: Array<string | number>; offset: number; value: string };
interface Patch extends Identity { baseSequence: number; operations: Operation[] }
export type AgentProgressResult = { kind: 'applied'; state: AgentProgressState } | { kind: 'ignore' | 'resync' };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function identity(value: unknown): value is Identity {
  return record(value) && value.version === 1 && typeof value.epoch === 'string' && value.epoch.length > 0 && integer(value.sequence) &&
    ['requestId', 'conversationId', 'roundId'].every(key => typeof value[key] === 'string' && Boolean(value[key]));
}
function viewValid(value: unknown, owner: Identity): value is AgentProgressView {
  if (!record(value) || !integer(value.revision) || !record(value.conversation) || !record(value.request) || !record(value.round)) return false;
  if (value.conversation.id !== owner.conversationId || value.request.id !== owner.requestId || value.request.conversationId !== owner.conversationId || value.request.roundId !== owner.roundId || value.round.id !== owner.roundId || value.round.requestId !== owner.requestId) return false;
  if (!Array.isArray(value.messages) || !Array.isArray(value.images) || !Array.isArray(value.jobs)) return false;
  if (Object.hasOwn(value, 'contextMode') && value.contextMode !== 'task' && value.contextMode !== 'legacy') return false;
  if (Object.hasOwn(value, 'taskContext') && value.taskContext !== null && (!record(value.taskContext) || value.taskContext.schemaVersion !== 1 || typeof value.taskContext.taskId !== 'string' || !integer(value.taskContext.revision))) return false;
  if (!value.messages.every(message => record(message) && typeof message.id === 'string' && message.roundId === owner.roundId && typeof message.content === 'string')) return false;
  return [value.messages, value.images, value.jobs].every(rows => rows.every(row => record(row) && typeof row.id === 'string') && new Set(rows.map(row => row.id)).size === rows.length);
}
function mergeRows<T extends { id: string }>(previous: T[], changed: T[]): T[] {
  const byId = new Map(changed.map(value => [value.id, value]));
  const output = previous.map(value => { const next = byId.get(value.id); byId.delete(value.id); return next || value; });
  return [...output, ...byId.values()];
}
function mergeView(snapshot: AgentSnapshot, view: AgentProgressView, previous: AgentProgressView): AgentSnapshot {
  const nextImages = new Set(view.images.map(image => image.id));
  const expiredPreviews = new Set(previous.jobs.map(job => (job.metadata?.agent as Record<string, unknown> | undefined)?.partialImageId).filter((id): id is string => typeof id === 'string' && !nextImages.has(id)));
  const protectedImages = new Set(expiredPreviews.size ? snapshot.conversation.rounds.flatMap(round => [
    ...(round.inputImageIds || []), ...(round.taskImageIds || []), round.maskImageId, round.maskTargetImageId,
    round.editingTask?.target?.assetId, ...(round.editingTask?.auxiliaries.map(image => image.assetId) || []),
    round.taskContext?.target?.assetId, ...(round.taskContext?.auxiliaries.map(image => image.assetId) || []),
  ]) : []);
  if (view.editingTask?.target) protectedImages.add(view.editingTask.target.assetId);
  for (const auxiliary of view.editingTask?.auxiliaries || []) protectedImages.add(auxiliary.assetId);
  for (const task of [snapshot.taskContext, view.taskContext]) {
    if (task?.target) protectedImages.add(task.target.assetId);
    for (const auxiliary of task?.auxiliaries || []) protectedImages.add(auxiliary.assetId);
  }
  const retainedImages = expiredPreviews.size ? snapshot.images.filter(image => !expiredPreviews.has(image.id) || protectedImages.has(image.id)) : snapshot.images;
  return { ...snapshot, revision: view.revision, conversation: { ...snapshot.conversation, ...view.conversation,
    rounds: mergeRows(snapshot.conversation.rounds, [view.round]), messages: mergeRows(snapshot.conversation.messages, view.messages) },
  request: view.request, editingTask: view.editingTask,
  // New streams carry the active task explicitly. An older bounded view may
  // omit these fields; omission must not erase a task from its full snapshot.
  ...(Object.hasOwn(view, 'taskContext') ? { taskContext: view.taskContext } : {}),
  ...(Object.hasOwn(view, 'contextMode') ? { contextMode: view.contextMode } : {}),
  images: mergeRows(retainedImages, view.images), jobs: mergeRows(snapshot.jobs, view.jobs) };
}
function patchValue(root: unknown, operation: Operation): unknown {
  if (!record(operation) || !Array.isArray(operation.path) || operation.path.length > 20 || !['replace', 'append'].includes(operation.op)) throw Error('Invalid patch');
  const walk = (value: unknown, depth: number): unknown => {
    if (depth === operation.path.length) {
      if (operation.op === 'replace') return operation.value;
      // Python emits UTF-16 code-unit offsets, matching JS string.length even
      // for emoji. Never deduplicate by text value: repeated words are valid.
      if (typeof value !== 'string' || typeof operation.value !== 'string' || !integer(operation.offset) || value.length !== operation.offset) throw Error('Text baseline mismatch');
      return value + operation.value;
    }
    const key = operation.path[depth];
    if (typeof key !== 'string' && typeof key !== 'number' || ['__proto__', 'prototype', 'constructor'].includes(String(key))) throw Error('Unsafe patch path');
    if (Array.isArray(value)) {
      if (!integer(key) || key >= value.length) throw Error('Invalid array index');
      const copy = value.slice(); copy[key] = walk(value[key], depth + 1); return copy;
    }
    if (!record(value) || typeof key !== 'string' || !Object.hasOwn(value, key)) throw Error('Missing patch path');
    return { ...value, [key]: walk(value[key], depth + 1) };
  };
  return walk(root, 0);
}

export function acceptAgentSnapshot(value: unknown, requestId: string): AgentProgressResult {
  if (!record(value) || !record(value.request) || value.request.id !== requestId) return { kind: 'ignore' };
  const snapshot = value as unknown as AgentSnapshot & { stream?: AgentProgressBaseline };
  if (snapshot.schemaVersion !== 1 || !integer(snapshot.revision) || !record(snapshot.conversation) || snapshot.conversation.id !== snapshot.request!.conversationId || !Array.isArray(snapshot.conversation.rounds) || !Array.isArray(snapshot.conversation.messages) || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.images)) return { kind: 'resync' };
  const { stream, ...canonical } = snapshot;
  if (stream) {
    if (!identity(stream) || stream.sequence !== 0 || stream.requestId !== requestId || stream.conversationId !== snapshot.conversation.id || stream.roundId !== snapshot.request!.roundId) return { kind: 'resync' };
    // Oversized views publish this full snapshot followed by a fallback event;
    // terminal snapshots may omit the view too. Do not start a reconnect loop.
    if (!Object.hasOwn(stream, 'view')) return { kind: 'applied', state: { snapshot: canonical } };
    if (!viewValid(stream.view, stream) || stream.view.revision !== snapshot.revision || !snapshot.conversation.rounds.some(round => round.id === stream.roundId)) return { kind: 'resync' };
    return { kind: 'applied', state: { snapshot: canonical, stream } };
  }
  // Full snapshots remain readable when talking to an older server, but do not
  // establish a delta baseline. A later patch then requires a fresh read.
  return { kind: 'applied', state: { snapshot: canonical } };
}

export function applyAgentProgress(state: AgentProgressState | undefined, value: unknown, requestId: string): AgentProgressResult {
  if (!record(value) || value.requestId !== requestId) return { kind: 'ignore' };
  if (!identity(value) || !state?.stream) return { kind: 'resync' };
  const patch = value as unknown as Patch, previous = state.stream;
  if (patch.conversationId !== previous.conversationId || patch.roundId !== previous.roundId) return { kind: 'ignore' };
  if (patch.epoch !== previous.epoch) return { kind: 'resync' };
  if (patch.sequence <= previous.sequence) return { kind: 'ignore' };
  if (patch.baseSequence !== previous.sequence || patch.sequence !== previous.sequence + 1 || !Array.isArray(patch.operations) || patch.operations.length > 512) return { kind: 'resync' };
  try {
    let view: unknown = previous.view;
    for (const operation of patch.operations) view = patchValue(view, operation);
    if (!viewValid(view, patch) || view.revision < state.snapshot.revision) return { kind: 'resync' };
    return { kind: 'applied', state: { snapshot: mergeView(state.snapshot, view, previous.view), stream: { ...previous, sequence: patch.sequence, view } } };
  } catch { return { kind: 'resync' }; }
}
