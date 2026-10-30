import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentApiError, agentApi, watchAgentRequest, type AgentConversationSummary, type AgentSnapshot } from '../../api/agentClient';
import { isAgentRequestActive } from '../../utils/playground/agentAssistantBlocks';
import { clearPendingAgentSubmission, getAgentResumeId, readPendingAgentSubmissions, savePendingAgentSubmission, type PendingAgentSubmission } from '../../utils/playground/agentSubmission';
import { readLocalPreferences } from '../../utils/localPreferences';

const ACTIVE_KEY = 'ipl.agent.active-conversation';
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '请求未完成';
const rejected = (reason: unknown) => reason instanceof AgentApiError && [400, 401, 403, 404, 409, 422].includes(reason.status);
const sendContext = (value: AgentSnapshot) => JSON.stringify([
  value.conversation.activeRoundId, value.editingTask ?? null, value.taskContext ?? null, value.contextMode ?? null,
  value.conversation.rounds.map(round => [round.id, round.parentRoundId, round.prompt, round.inputImageIds,
    round.taskImageIds || [], round.outputTaskIds, round.retryTaskIds || [], round.maskImageId ?? null,
    round.maskTargetImageId ?? null, round.editingTask ?? null, round.taskContext ?? null]),
]);
export interface AgentSubmissionBoundary { conversationId: string; draft: number; authorization: { images: number; search: number } }
export interface AgentRunCommand {
  current: () => boolean;
  createConversation: () => Promise<AgentSnapshot | null>;
}
interface Options {
  active: boolean;
  useStream: boolean;
  onSummary: (value: AgentConversationSummary) => void;
  onJobsChanged?: () => void;
  onAccepted: (entry: PendingAgentSubmission, boundary: AgentSubmissionBoundary) => void;
  onSelection: () => void;
}

// The only owner of an observed run and its durable submission journal. UI
// drafts are acknowledged through a captured boundary, never inferred from a
// stream terminal. Detaching the observer does not stop background execution.
export function useAgentRunState(options: Options) {
  const callbacks = useRef(options); callbacks.current = options;
  const mounted = useRef(true);
  const [activeId, updateActiveId] = useState<string | null>(() => { try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; } });
  const activeIdRef = useRef(activeId);
  const selection = useRef(0);
  const operation = useRef(0);
  const commandBusy = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, updateError] = useState('');
  const [notice, updateNotice] = useState('');
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const snapshotRef = useRef<AgentSnapshot | null>(null);
  const snapshotVersion = useRef(0);
  const summaryRevisions = useRef(new Map<string, number>());
  const [pending, setPending] = useState(() => readPendingAgentSubmissions(localStorage));
  const [submittingRequestIds, setSubmittingRequestIds] = useState<ReadonlySet<string>>(() => new Set());
  const boundaries = useRef<Record<string, AgentSubmissionBoundary>>(Object.fromEntries(pending.map(entry => [entry.payload.requestId, { conversationId: entry.conversationId, draft: 0, authorization: { images: 0, search: 0 } }])));
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationLoadError, setConversationLoadError] = useState('');
  const [loadVersion, setLoadVersion] = useState(0);
  const [observeVersion, setObserveVersion] = useState(0);
  const observer = useRef<(() => void) | undefined>(undefined);
  const observation = useRef(0);
  const starts = useRef(new Map<string, number>());
  const completed = useRef(new Set<string>());
  const [terminalObservations, setTerminalObservations] = useState<Record<string, number>>({});
  const setError = useCallback((value: string) => { if (mounted.current) updateError(value); }, []);
  const setNotice = useCallback((value: string) => { if (mounted.current) updateNotice(value); }, []);
  const detach = useCallback(() => { observation.current++; observer.current?.(); observer.current = undefined; }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; selection.current++; operation.current++; detach(); }; }, [detach]);

  const setActiveId = useCallback((id: string | null) => {
    if (!mounted.current || id === activeIdRef.current) return;
    selection.current++; operation.current++; commandBusy.current = false;
    detach(); activeIdRef.current = id; snapshotRef.current = null;
    updateActiveId(id); setSnapshot(null); setBusy(false); updateError(''); updateNotice('');
    setConversationLoadError(''); callbacks.current.onSelection();
    try { if (id) localStorage.setItem(ACTIVE_KEY, id); else localStorage.removeItem(ACTIVE_KEY); } catch { /* optional preference */ }
  }, [detach]);
  const apply = useCallback((value: AgentSnapshot, receipt = false) => {
    if (!mounted.current || value.revision < (summaryRevisions.current.get(value.conversation.id) ?? -1)) return false;
    const previous = snapshotRef.current;
    if (activeIdRef.current === value.conversation.id && (!previous || value.revision >= previous.revision)) {
      if (receipt) { detach(); setObserveVersion(version => version + 1); }
      snapshotVersion.current++; snapshotRef.current = value; setSnapshot(value);
    }
    const request = value.request, started = request ? starts.current.get(request.id) : undefined;
    if (request && started !== undefined && !isAgentRequestActive(request.state)) {
      starts.current.delete(request.id);
      setTerminalObservations(old => ({ ...old, [request.id]: Math.max(0, performance.now() - started) }));
    }
    summaryRevisions.current.set(value.conversation.id, value.revision);
    callbacks.current.onSummary({ id: value.conversation.id, title: value.conversation.title, activeRoundId: value.conversation.activeRoundId,
      createdAt: value.conversation.createdAt, updatedAt: value.conversation.updatedAt, roundCount: value.conversation.rounds.length,
      runningRequestId: isAgentRequestActive(request?.state) ? request!.id : null, revision: value.revision });
    return true;
  }, [detach]);
  const applySnapshot = useCallback((value: AgentSnapshot) => apply(value, true), [apply]);
  const reloadConversation = useCallback(() => { if (mounted.current) setLoadVersion(version => version + 1); }, []);
  useEffect(() => {
    const epoch = selection.current, version = snapshotVersion.current, controller = new AbortController();
    let disposed = false;
    setConversationLoadError('');
    if (!activeId) { setConversationLoading(false); return; }
    // Background refreshes must not toggle scroll readiness or replay the
    // initial conversation positioning for someone reading older messages.
    setConversationLoading(!snapshotRef.current);
    if (!snapshotRef.current) { updateError(''); callbacks.current.onSelection(); }
    const live = () => mounted.current && !disposed && epoch === selection.current && activeIdRef.current === activeId;
    void agentApi.conversation(activeId, controller.signal).then(value => { if (live() && (version === snapshotVersion.current || value.revision > (snapshotRef.current?.revision ?? -1))) applySnapshot(value); })
      .catch(reason => { if (live() && version === snapshotVersion.current) setConversationLoadError(errorText(reason)); })
      .finally(() => { if (live()) setConversationLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [activeId, loadVersion, applySnapshot]);
  const current = snapshot?.conversation.id === activeId ? snapshot : null;
  const inFlight = Boolean(current && isAgentRequestActive(current.request?.state));
  const wasActive = useRef(options.active);
  useEffect(() => {
    const returned = options.active && !wasActive.current;
    wasActive.current = options.active;
    // Active runs already reattach to a fresh observer snapshot. An idle tab
    // must discover work that another tab started while it was hidden.
    if (returned && activeIdRef.current && !isAgentRequestActive(snapshotRef.current?.request?.state)) reloadConversation();
  }, [options.active, reloadConversation]);
  useEffect(() => {
    if (!options.active || !current?.request || !inFlight) return;
    const epoch = selection.current, token = ++observation.current, requestId = current.request.id;
    const live = () => mounted.current && selection.current === epoch && observation.current === token;
    const jobVersion = (value: AgentSnapshot) => JSON.stringify(value.jobs.map(job => [job.id, job.status, job.result_path, job.accepted_image_id, job.error]));
    let lastJobs = jobVersion(current);
    const close = watchAgentRequest(requestId, value => {
      if (!live() || value.request?.id !== requestId || value.conversation.id !== activeIdRef.current) return;
      if (!apply(value)) return;
      const nextJobs = jobVersion(value);
      if (nextJobs !== lastJobs) { lastJobs = nextJobs; callbacks.current.onJobsChanged?.(); }
      if (!isAgentRequestActive(value.request?.state) && !completed.current.has(requestId)) {
        completed.current.add(requestId);
        if (readLocalPreferences().notifyOnCompletion) setNotice(value.request?.state === 'completed' ? 'Agent 本轮已完成' : 'Agent 本轮已结束，请查看状态');
      }
    }, reason => { if (live()) setError(`状态读取失败：${errorText(reason)}。不会重新提交模型请求。`); }, options.useStream);
    observer.current = close;
    return () => { close(); if (observation.current === token) observation.current++; if (observer.current === close) observer.current = undefined; };
  }, [options.active, options.useStream, activeId, current?.request?.id, inFlight, observeVersion, apply, setError, setNotice]);
  const retryProgress = current?.jobs.filter(job => (job.metadata?.agentRetry || current.conversation.rounds.some(round => round.retryTaskIds?.includes(job.id))) && ['queued', 'running'].includes(job.status)).map(job => job.id).join(',') || '';
  useEffect(() => {
    if (!options.active || !activeId || !retryProgress || inFlight) return;
    const epoch = selection.current, controller = new AbortController();
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await agentApi.conversation(activeId, controller.signal); if (!disposed && mounted.current && selection.current === epoch) { apply(value); callbacks.current.onJobsChanged?.(); } } catch { /* Read-only recovery, no image retry. */ }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [options.active, activeId, retryProgress, inFlight, apply]);
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key !== null && event.key !== 'ipl.agent.pending-submissions.v1') return;
      setPending(readPendingAgentSubmissions(localStorage));
      // Another tab may have accepted a new run while this tab was idle.
      // Reading its receipt discovers that run without replaying its POST.
      if (callbacks.current.active && activeIdRef.current) setLoadVersion(version => version + 1);
    };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);

  const runCommand = useCallback(async <T,>(action: (command: AgentRunCommand) => Promise<T>): Promise<T | undefined> => {
    if (!mounted.current || commandBusy.current) return;
    const token = ++operation.current;
    let epoch = selection.current;
    commandBusy.current = true; setBusy(true); updateError('');
    const command: AgentRunCommand = {
      current: () => mounted.current && selection.current === epoch && operation.current === token,
      createConversation: async () => {
        const value = await agentApi.createConversation(crypto.randomUUID());
        if (!command.current()) return null;
        // Adopt the newly created conversation without cancelling its own send.
        selection.current++; epoch = selection.current; detach();
        activeIdRef.current = value.conversation.id; snapshotRef.current = null;
        updateActiveId(value.conversation.id); callbacks.current.onSelection();
        try { localStorage.setItem(ACTIVE_KEY, value.conversation.id); } catch { /* optional */ }
        applySnapshot(value); return value;
      },
    };
    try { return await action(command); }
    catch (reason) { if (command.current()) updateError(errorText(reason)); return undefined; }
    finally { if (mounted.current && operation.current === token) { commandBusy.current = false; setBusy(false); } }
  }, [detach, applySnapshot]);
  const refreshPending = () => { if (mounted.current) setPending(readPendingAgentSubmissions(localStorage)); };
  const acknowledge = (entry: PendingAgentSubmission, value: AgentSnapshot, publish: boolean) => {
    if (value.request?.id !== entry.payload.requestId || value.conversation.id !== entry.conversationId) throw Error('请求回执身份不匹配；原请求已保留。');
    clearPendingAgentSubmission(localStorage, entry.payload.requestId); refreshPending();
    if (mounted.current) {
      // A historical request GET can carry the newest conversation revision
      // while still describing the old request. Resolve the journal without
      // replacing a later selected run with that historical request view.
      if (publish) {
        if (value.conversation.activeRoundId && value.request.roundId !== value.conversation.activeRoundId) reloadConversation();
        else applySnapshot(value);
      }
      callbacks.current.onJobsChanged?.();
      const boundary = boundaries.current[entry.payload.requestId];
      if (!entry.preserveDraft && boundary?.conversationId === entry.conversationId) callbacks.current.onAccepted(entry, boundary);
    }
    delete boundaries.current[entry.payload.requestId];
  };
  const submitPrepared = async (prepare: (command: AgentRunCommand) => Promise<{ entry: PendingAgentSubmission; boundary?: AgentSubmissionBoundary } | null>) => runCommand(async command => {
    const base = snapshotRef.current;
    const prepared = await prepare(command);
    if (!prepared || !command.current()) return;
    const entry = structuredClone(prepared.entry);
    // Stopping detaches observation before the local worker necessarily finishes
    // recording its timing/error metadata. Refresh that revision on the next
    // explicit send, before the first POST or durable frozen journal exists.
    if (base?.conversation.id === entry.conversationId && base.request && (base.request.stopRequested || ['stopped', 'unknown', 'interrupted'].includes(base.request.state))) {
      const latest = await agentApi.conversation(entry.conversationId);
      if (!command.current()) return;
      if (latest.conversation.id !== entry.conversationId) throw Error('会话读取身份不匹配；草稿保留，尚未发送。');
      applySnapshot(latest);
      if (sendContext(base) !== sendContext(latest) || base.request.id !== latest.request?.id || isAgentRequestActive(latest.request?.state)) {
        throw Error('会话分支、编辑对象或运行状态已改变；已读取最新状态，草稿与附件保留，请确认后再发送。');
      }
      entry.payload.expectedRevision = latest.revision;
    }
    setSubmittingRequestIds(ids => new Set(ids).add(entry.payload.requestId));
    try {
      savePendingAgentSubmission(localStorage, entry);
      if (prepared.boundary) boundaries.current[entry.payload.requestId] = prepared.boundary;
      refreshPending(); starts.current.set(entry.payload.requestId, performance.now());
      const value = await agentApi.submit(entry.conversationId, entry.payload);
      acknowledge(entry, value, command.current());
      return command.current() ? value : undefined;
    } catch (reason) {
      if (rejected(reason)) { clearPendingAgentSubmission(localStorage, entry.payload.requestId); refreshPending(); delete boundaries.current[entry.payload.requestId]; starts.current.delete(entry.payload.requestId); }
      if (reason instanceof AgentApiError && ['revision_conflict', 'task_revision_conflict', 'task_branch_conflict'].includes(reason.code) && command.current()) {
        try {
          const latest = await agentApi.conversation(entry.conversationId);
          if (command.current() && latest.conversation.id === entry.conversationId) applySnapshot(latest);
        } catch { /* Keep the original conflict and draft; never replay the POST. */ }
        throw Error('对话已改变；已尝试读取最新状态。草稿与附件保留，请确认后再次发送。');
      }
      throw new Error(`${errorText(reason)}${!(reason instanceof AgentApiError) ? '。提交结果不确定；请检查原请求，不要重新发起。' : ''}`);
    } finally {
      if (mounted.current) setSubmittingRequestIds(ids => { const next = new Set(ids); next.delete(entry.payload.requestId); return next; });
    }
  });
  const reconcile = async (entry: PendingAgentSubmission, retry = false) => runCommand(async command => {
    let replayed = false;
    try {
      let value: AgentSnapshot;
      try { value = await agentApi.request(entry.payload.requestId); }
      catch (reason) {
        if (!(reason instanceof AgentApiError) || reason.status !== 404 || !retry || !command.current()) throw reason;
        replayed = true; value = await agentApi.submit(entry.conversationId, entry.payload);
      }
      acknowledge(entry, value, command.current());
      if (command.current()) setNotice('已确认原请求状态；没有创建第二个请求。');
    } catch (reason) {
      if (replayed && rejected(reason)) {
        clearPendingAgentSubmission(localStorage, entry.payload.requestId); refreshPending(); delete boundaries.current[entry.payload.requestId];
        throw Error(`${errorText(reason)}。图库已明确拒绝该请求；图文仍保留，可修改后发送。`);
      }
      throw Error(`${errorText(reason)}。原请求 ID 与内容已保留。`);
    }
  });
  const stop = () => runCommand(async command => {
    const request = snapshotRef.current?.request;
    if (!request) return;
    const value = await agentApi.stop(request.id);
    if (command.current()) {
      if (value.request?.id !== request.id || value.conversation.id !== request.conversationId) throw Error('停止回执身份不匹配，请重新读取原请求状态。');
      applySnapshot(value); callbacks.current.onJobsChanged?.();
    }
  });
  const resume = () => runCommand(async command => {
    const request = snapshotRef.current?.request;
    if (!request?.canResume) return;
    const key = [request.id, request.usage.responseStepsStarted, request.usage.imageJobsCreated].join(':');
    const value = await agentApi.resume(request.id, getAgentResumeId(localStorage, key, () => crypto.randomUUID()));
    if (command.current()) {
      if (value.request?.id !== request.id || value.conversation.id !== request.conversationId) throw Error('继续回执身份不匹配，请重新读取原请求状态。');
      applySnapshot(value); callbacks.current.onJobsChanged?.();
    }
  });
  const newConversation = () => runCommand(command => command.createConversation());
  return { activeId, activeIdRef, setActiveId, current, busy, error, setError, notice, setNotice, pending, submittingRequestIds,
    conversationLoading, conversationLoadError, reloadConversation, terminalObservations, inFlight,
    applySnapshot, runCommand, submitPrepared, reconcile, stop, resume, newConversation };
}
