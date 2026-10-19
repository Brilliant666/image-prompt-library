/* Adapted interaction structure from CookSleep/gpt_image_playground
 * src/components/AgentWorkspace.tsx, commit 1e9d5af60aadd9117a835cc2da43908b8e3370dd.
 * MIT, Copyright (c) 2026 CookSleep. Server snapshots replace the source store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Copy, Download, ImagePlus, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Search, Settings, Square, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, mediaUrl } from '../../api/client';
import { AgentApiError, agentApi, getAgentConfig, type AgentConfigResponse, type AgentConversationSummary, type AgentImage, type AgentImageParams, type AgentRound, type AgentRoundCreate, type AgentSnapshot } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';
import { getActiveAgentRounds, getAgentBranchLeafId, getAgentSiblingRounds } from '../../utils/playground/agentConversationState';
import { getAgentAssistantBlocks, isAgentRequestActive } from '../../utils/playground/agentAssistantBlocks';
import { insertMention, referenceKey, resolveAgentPromptImageReferences, type ReferenceChoice } from '../../utils/playground/agentImageReferences';
import { AGENT_DRAFT_KEY, clearPendingAgentSubmission, draftFromPendingAgentSubmission, getAgentResumeId, readAgentDrafts, readPendingAgentSubmissions, savePendingAgentSubmission, shouldSubmitAgentOnKey, type AgentDraft, type PendingAgentSubmission } from '../../utils/playground/agentSubmission';
import { COMPATIBLE_SIZE_OPTIONS, IMAGE25_QUALITIES, imageSizeLabel } from '../../utils/compatibleRecipe';
import { readLocalPreferences } from '../../utils/localPreferences';
import { copyTextToClipboard } from '../../utils/clipboard';
import { AgentReferencePicker } from './AgentReferencePicker';
import './AgentWorkspace.css';

export interface AgentWorkspaceProps {
  active: boolean;
  onOpenSettings: () => void;
  onOpenJob: (jobId: string) => void;
  onLibraryChanged: () => void;
  onJobsChanged?: () => void;
  focusConversationId?: string;
  focusToken?: number;
}
type Draft = AgentDraft;
const emptyDraft = (): Draft => ({ text: '', refs: [], params: { size: 'auto', quality: 'auto', background: 'auto', output_format: 'png' }, editId: null, origin: 'send' });
const statusText: Record<string, string> = { queued: '等待执行', running: '正在响应', waiting_for_jobs: '等待图片任务', stop_requested: '正在停止后续调用', completed: '已完成', stopped: '已停止后续调用', failed: '执行失败', interrupted: '执行已中断', unknown: '上游结果未知', succeeded: '已生成', accepted: '已收录', discarded: '已清理', cancelled: '已取消', pending: '等待执行' };
const ACTIVE_KEY = 'ipl.agent.active-conversation';
function safeStorageGet(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function safeStorageSet(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* UI preferences may be unavailable; submission journal is handled separately. */ } }
function errorText(reason: unknown) { return reason instanceof Error ? reason.message : '请求未完成'; }
function sameOriginImage(url?: string | null) { if (!url) return ''; try { const value = new URL(url, location.origin); return value.origin === location.origin ? value.href : ''; } catch { return ''; } }

function MarkdownMessage({ text }: { text: string }) {
  return <div className="agent-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    // A model cannot trigger arbitrary image fetches through Markdown. Actual
    // images below are server-issued handles from the generation job store.
    img: ({ alt }) => <span className="agent-help">[图片链接：{alt || '未自动加载'}]</span>,
  }}>{text}</ReactMarkdown></div>;
}

function ResultCard({ job, preview, onOpen, onSaved, onError }: { job: GenerationJobRecord; preview?: AgentImage; onOpen: () => void; onSaved: () => void; onError: (value: string) => void }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(Boolean(job.accepted_image_id));
  useEffect(() => setSaved(Boolean(job.accepted_image_id)), [job.accepted_image_id]);
  async function save() {
    if (saving || saved) return;
    setSaving(true);
    try { await api.acceptGenerationJobAsNewItem(job.id); setSaved(true); onSaved(); }
    catch (reason) { onError(errorText(reason)); }
    finally { setSaving(false); }
  }
  return <article className="agent-result-card">
    {job.result_path ? <button className="agent-result-image" onClick={onOpen}><img src={mediaUrl(job.result_path)} alt="生成结果" loading="lazy" /></button> : preview?.status === 'available' && sameOriginImage(preview.url) ? <div className="agent-result-image"><img src={sameOriginImage(preview.url)} alt="生成中预览，非最终结果" /><p className="agent-help">生成中预览 · 非最终结果，尚不可收录</p></div> : <div className="agent-result-placeholder">{['queued', 'running'].includes(job.status) && <LoaderCircle size={22} className="spin" />}<span>{statusText[job.status] || job.status}</span></div>}
    <div className="agent-result-meta"><span>{statusText[job.status] || job.status}</span><span>{job.result_width && job.result_height ? `${job.result_width} × ${job.result_height}` : '文件尺寸未知'}</span></div>
    {job.error && <p className="agent-error">{job.error}</p>}
    <footer><button onClick={onOpen}>查看 / 编辑</button>{job.result_path && <><a href={mediaUrl(job.result_path)} download title="下载原文件"><Download size={16} /></a><button disabled={saving || saved} onClick={() => void save()}>{saved ? <Check size={16} /> : <Plus size={16} />}{saved ? '已收录' : saving ? '保存中' : '保存到 Library'}</button></>}</footer>
  </article>;
}

export default function AgentWorkspace({ active, onOpenSettings, onOpenJob, onLibraryChanged, onJobsChanged, focusConversationId, focusToken }: AgentWorkspaceProps) {
  const [config, setConfig] = useState<AgentConfigResponse | null>(null);
  const [conversations, setConversations] = useState<AgentConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [preferences, setPreferences] = useState(readLocalPreferences);
  const [activeId, setActiveId] = useState<string | null>(() => safeStorageGet(ACTIVE_KEY));
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const restored = readAgentDrafts(localStorage, readLocalPreferences().persistInputOnRestart);
    for (const entry of readPendingAgentSubmissions(localStorage)) restored[entry.conversationId] = draftFromPendingAgentSubmission(entry, restored[entry.conversationId]);
    return restored;
  });
  const [pending, setPending] = useState<PendingAgentSubmission[]>(() => readPendingAgentSubmissions(localStorage));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [picker, setPicker] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [allowImages, setAllowImages] = useState(false);
  const [allowWebSearch, setAllowWebSearch] = useState(false);
  const [imageBudget, setImageBudget] = useState(1);
  const [toolBudget, setToolBudget] = useState(5);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);
  const activeIdRef = useRef(activeId);
  const sending = useRef(false);
  const lastCompleted = useRef(new Set<string>());
  activeIdRef.current = activeId;
  const draftKey = activeId || 'new';
  const draft = drafts[draftKey] || emptyDraft();
  const current = snapshot?.conversation.id === activeId ? snapshot : null;
  const rounds = useMemo(() => current ? getActiveAgentRounds(current.conversation) : [], [current]);
  const inFlight = Boolean(current && isAgentRequestActive(current.request?.state));
  const uncertain = pending.find(entry => entry.conversationId === activeId);
  const inputLimit = config?.capabilities.maxInputImages ?? 4;

  useEffect(() => {
    if (focusConversationId) { setActiveId(focusConversationId); setDeleteTarget(null); }
  }, [focusConversationId, focusToken]);

  function updateDraft(change: Partial<Draft>) {
    if (busy || uncertain) return;
    setDrafts(old => ({ ...old, [draftKey]: { ...(old[draftKey] || emptyDraft()), ...change } }));
  }
  const refreshList = useCallback(async () => {
    const result = await agentApi.conversations(); setConversations(result.conversations); setNextCursor(result.nextCursor);
    return result.conversations;
  }, []);
  const applySnapshot = useCallback((value: AgentSnapshot) => {
    if (activeIdRef.current === value.conversation.id) setSnapshot(old => !old || old.conversation.id !== value.conversation.id || value.revision >= old.revision ? value : old);
    const row: AgentConversationSummary = { id: value.conversation.id, title: value.conversation.title, activeRoundId: value.conversation.activeRoundId, createdAt: value.conversation.createdAt, updatedAt: value.conversation.updatedAt, roundCount: value.conversation.rounds.length, runningRequestId: isAgentRequestActive(value.request?.state) ? value.request!.id : null, revision: value.revision };
    setConversations(old => [row, ...old.filter(item => item.id !== row.id)].sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setError('');
    void Promise.all([getAgentConfig(), refreshList()]).then(([value, rows]) => {
      if (disposed) return;
      setConfig(value); setToolBudget(old => Math.min(old, value.config.maxToolRounds)); setImageBudget(old => Math.min(old, value.config.maxImageJobs));
      if (!activeIdRef.current && rows.length) setActiveId(rows[0].id);
    }).catch(reason => { if (!disposed) setError(errorText(reason)); }).finally(() => { if (!disposed) setLoading(false); });
    const refreshConfig = () => { void getAgentConfig().then(value => {
      if (disposed) return;
      setConfig(value); setToolBudget(old => Math.min(old, value.config.maxToolRounds)); setImageBudget(old => Math.min(old, value.config.maxImageJobs));
      if (!value.config.webSearch || !value.capabilities.webSearch) setAllowWebSearch(false);
    }).catch(reason => { if (!disposed) setError(errorText(reason)); }); };
    window.addEventListener('ipl:agent-config-changed', refreshConfig);
    return () => { disposed = true; window.removeEventListener('ipl:agent-config-changed', refreshConfig); };
  }, [active, refreshList]);
  useEffect(() => {
    if (!activeId) { setSnapshot(null); try { localStorage.removeItem(ACTIVE_KEY); } catch { /* optional UI preference */ } return; }
    const sequence = ++requestSequence.current;
    setLoading(true); setError(''); setAllowImages(false); setAllowWebSearch(false);
    safeStorageSet(ACTIVE_KEY, activeId);
    void agentApi.conversation(activeId).then(value => { if (sequence === requestSequence.current) applySnapshot(value); }).catch(reason => { if (sequence === requestSequence.current) setError(errorText(reason)); }).finally(() => { if (sequence === requestSequence.current) setLoading(false); });
  }, [activeId, applySnapshot]);
  useEffect(() => {
    const refreshPreferences = () => setPreferences(readLocalPreferences());
    window.addEventListener('ipl:local-preferences-changed', refreshPreferences);
    window.addEventListener('storage', refreshPreferences);
    return () => { window.removeEventListener('ipl:local-preferences-changed', refreshPreferences); window.removeEventListener('storage', refreshPreferences); };
  }, []);
  useEffect(() => {
    if (!preferences.persistInputOnRestart) { try { localStorage.removeItem(AGENT_DRAFT_KEY); } catch { /* optional */ } return; }
    safeStorageSet(AGENT_DRAFT_KEY, JSON.stringify(drafts));
  }, [drafts, preferences.persistInputOnRestart]);
  useEffect(() => {
    if (!active || !current?.request || !isAgentRequestActive(current.request.state)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const requestId = current.request.id;
    const tick = async () => {
      try {
        const value = await agentApi.request(requestId);
        if (disposed) return;
        applySnapshot(value); onJobsChanged?.();
        if (!isAgentRequestActive(value.request?.state)) {
          if (!lastCompleted.current.has(requestId)) {
            lastCompleted.current.add(requestId);
            if (readLocalPreferences().notifyOnCompletion) setNotice(value.request?.state === 'completed' ? 'Agent 本轮已完成' : 'Agent 本轮已结束，请查看状态');
          }
          return;
        }
      } catch (reason) { if (!disposed) setError(`状态读取失败：${errorText(reason)}。不会重新提交模型请求。`); }
      if (!disposed) timer = setTimeout(tick, 1200);
    };
    timer = setTimeout(tick, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, current?.request?.id, current?.request?.state, applySnapshot, onJobsChanged]);
  useEffect(() => { if (active && scroll.current && scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 220) scroll.current.scrollTo({ top: scroll.current.scrollHeight }); }, [active, current?.revision]);

  async function newConversation() {
    setBusy(true); setError('');
    try { const value = await agentApi.createConversation(crypto.randomUUID()); activeIdRef.current = value.conversation.id; setActiveId(value.conversation.id); applySnapshot(value); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function selectBranch(id: string) {
    if (!current || busy) return;
    setBusy(true);
    try { applySnapshot(await agentApi.updateConversation(current.conversation.id, { expectedRevision: current.revision, activeRoundId: getAgentBranchLeafId(current.conversation, id) })); updateDraft({ editId: null, origin: 'send' }); setAllowImages(false); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function prepareEdit(round: AgentRound, origin: 'edit' | 'regenerate') {
    if (!current || inFlight || uncertain) return;
    setBusy(true); setError('');
    try {
      const original = await agentApi.request(round.requestId);
      const choices = round.inputImageIds.map(id => {
        const image = original.images.find(image => image.id === id) || current.images.find(image => image.id === id);
        return image ? { reference: image.source, label: '原始参考图', url: sameOriginImage(image.thumbnailUrl || image.url), missing: image.status !== 'available' } : null;
      });
      if (choices.some(choice => !choice)) throw new Error('原始参考图记录缺失，不能悄悄改为无参考图生成。');
      updateDraft({ text: round.prompt, refs: choices as ReferenceChoice[], editId: round.id, origin, params: original.request?.params || draft.params });
      setAllowImages(false); textarea.current?.focus();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function addFiles(files: File[]) {
    if (uploading || busy || uncertain) return;
    if (files.length + draft.refs.length > inputLimit) { setError(`当前接口最多使用 ${inputLimit} 张参考图；没有截断或上传本次文件。`); return; }
    if (files.some(file => !file.type.startsWith('image/') || file.size > 30 * 1024 * 1024)) { setError('请选择不超过 30 MB 的图片文件。'); return; }
    setUploading(true); setError('');
    const targetKey = draftKey;
    try {
      const added: ReferenceChoice[] = [];
      for (const file of files) { const result = await agentApi.upload(file); added.push({ reference: { kind: 'upload', uploadId: result.uploadId }, label: file.name, url: sameOriginImage(result.image.thumbnailUrl || result.image.url) }); }
      setDrafts(old => ({ ...old, [targetKey]: { ...(old[targetKey] || emptyDraft()), refs: [...(old[targetKey]?.refs || []), ...added] } }));
    } catch (reason) { setError(errorText(reason)); } finally { setUploading(false); }
  }
  async function reconcile(entry: PendingAgentSubmission, retry = false) {
    setBusy(true); setError('');
    let replayedMissingRequest = false;
    try {
      let value: AgentSnapshot;
      try { value = await agentApi.request(entry.payload.requestId); }
      catch (reason) {
        if (!(reason instanceof AgentApiError) || reason.status !== 404 || !retry) throw reason;
        replayedMissingRequest = true;
        value = await agentApi.submit(entry.conversationId, entry.payload);
      }
      applySnapshot(value); clearPendingAgentSubmission(localStorage, entry.payload.requestId); setPending(readPendingAgentSubmissions(localStorage)); onJobsChanged?.();
      setDrafts(old => ({ ...old, [entry.conversationId]: readLocalPreferences().clearInputAfterSubmit ? emptyDraft() : { ...(old[entry.conversationId] || emptyDraft()), origin: 'send', editId: null } }));
      setNotice('已确认原请求状态；没有创建第二个请求。');
    } catch (reason) {
      if (replayedMissingRequest && reason instanceof AgentApiError && [400, 404, 409, 422].includes(reason.status)) {
        // A missing request followed by an explicit local validation rejection
        // has not entered the paid execution queue. Unlock the preserved draft.
        clearPendingAgentSubmission(localStorage, entry.payload.requestId); setPending(readPendingAgentSubmissions(localStorage));
        setError(`${errorText(reason)}。图库已明确拒绝该请求；图文仍保留，可修改后发送。`);
      } else setError(`${errorText(reason)}。原请求 ID 与内容已保留。`);
    } finally { setBusy(false); }
  }
  async function submit() {
    if (sending.current || busy || uploading || inFlight || uncertain || !draft.text.trim() || !config) return;
    if (draft.refs.some(ref => ref.missing)) { setError('存在缺失参考图，请明确替换或移除后再发送。'); return; }
    const derived = draft.editId ? current?.conversation.rounds.find(round => round.id === draft.editId) : null;
    if (draft.editId && !derived) { setError('原分支已不存在，请重新选择。'); return; }
    const branch = derived ? rounds.slice(0, rounds.findIndex(round => round.id === derived.id)) : rounds;
    const resolved = resolveAgentPromptImageReferences(draft.text, branch, new Set((current?.jobs || []).filter(job => job.result_path && ['succeeded', 'accepted'].includes(job.status)).map(job => job.id)), draft.refs.map(choice => choice.reference));
    if (resolved.missing.length) { setError(`引用不存在或图片尚未完成：${resolved.missing.join('、')}`); return; }
    if (resolved.refs.length > inputLimit) { setError(`包括 @ 引用在内最多 ${inputLimit} 张图片。`); return; }
    sending.current = true; setBusy(true); setError(''); setNotice('');
    let entry: PendingAgentSubmission | null = null;
    try {
      let value = current;
      if (!value) {
        value = await agentApi.createConversation(crypto.randomUUID());
        activeIdRef.current = value.conversation.id; setActiveId(value.conversation.id); applySnapshot(value);
        setDrafts(old => { const next = { ...old, [value!.conversation.id]: draft }; delete next.new; return next; });
      }
      const payload: AgentRoundCreate = {
        requestId: crypto.randomUUID(), expectedRevision: value.revision, parentRoundId: derived ? derived.parentRoundId : value.conversation.activeRoundId,
        origin: draft.origin, derivedFromRoundId: derived?.id, prompt: draft.text, refs: resolved.refs,
        configRevision: config.revision, activeProfileId: activeProfileId || null, params: structuredClone(draft.params),
        authorization: { scope: 'this_request', allowImageGeneration: allowImages, allowWebSearch: Boolean(allowWebSearch && config.config.webSearch && config.capabilities.webSearch), maxImageJobs: allowImages ? imageBudget : 0, maxToolRounds: toolBudget },
      };
      entry = { conversationId: value.conversation.id, payload };
      savePendingAgentSubmission(localStorage, entry); setPending(readPendingAgentSubmissions(localStorage));
      const result = await agentApi.submit(entry.conversationId, payload);
      clearPendingAgentSubmission(localStorage, payload.requestId); setPending(readPendingAgentSubmissions(localStorage)); applySnapshot(result); onJobsChanged?.(); setAllowImages(false); setAllowWebSearch(false);
      setDrafts(old => ({ ...old, [entry!.conversationId]: readLocalPreferences().clearInputAfterSubmit ? emptyDraft() : { ...draft, origin: 'send', editId: null } }));
      requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }));
    } catch (reason) {
      // An explicit schema/config rejection is safe to edit. Network errors and
      // server errors retain the frozen request for read-only reconciliation.
      if (entry && reason instanceof AgentApiError && [400, 404, 409, 422].includes(reason.status)) { clearPendingAgentSubmission(localStorage, entry.payload.requestId); setPending(readPendingAgentSubmissions(localStorage)); }
      setError(`${errorText(reason)}${entry && !(reason instanceof AgentApiError) ? '。提交结果不确定；请检查原请求，不要重新发起。' : ''}`);
    } finally { sending.current = false; setBusy(false); }
  }
  function mention(value: string) {
    if (busy || uncertain) return;
    const element = textarea.current;
    const result = insertMention(draft.text, element?.selectionStart ?? draft.text.length, element?.selectionEnd ?? draft.text.length, value);
    updateDraft({ text: result.text }); setShowMentions(false);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(result.caret, result.caret); });
  }
  async function stop() {
    if (!current?.request || busy) return;
    setBusy(true);
    try { applySnapshot(await agentApi.stop(current.request.id)); onJobsChanged?.(); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }

  return <section className={`agent-workspace ${collapsed ? 'sidebar-collapsed' : ''}`} aria-label="Agent 创作工作区" hidden={!active}>
    <aside className="agent-conversations">
      <div className="agent-sidebar-head"><strong>创作会话</strong><button onClick={() => setCollapsed(true)} title="收起会话列表" aria-label="收起会话列表"><PanelLeftClose size={18} /></button></div>
      <button className="agent-new-conversation" disabled={busy} onClick={() => void newConversation()}><Plus size={17} />新建会话</button>
      <label className="agent-conversation-search"><Search size={16} /><input aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <nav>{conversations.filter(item => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item => <div key={item.id} className={`agent-conversation-row ${item.id === activeId ? 'selected' : ''}`}>
        {renaming === item.id ? <form onSubmit={async event => { event.preventDefault(); try { const existing = await agentApi.conversation(item.id); const value = await agentApi.updateConversation(item.id, { expectedRevision: existing.revision, title: titleDraft }); applySnapshot(value); setRenaming(null); } catch (reason) { setError(errorText(reason)); } }}><input aria-label="会话名称" autoFocus value={titleDraft} onChange={event => setTitleDraft(event.target.value)} maxLength={200} /><button title="保存名称" type="submit"><Check size={15} /></button><button aria-label="取消重命名" type="button" onClick={() => setRenaming(null)}><X size={15} /></button></form> : <>
          <button className="agent-conversation-link" onClick={() => { setActiveId(item.id); setDeleteTarget(null); }}><span>{item.runningRequestId ? <LoaderCircle size={15} className="spin" /> : <MessageSquare size={15} />}{item.title}</span><small>{item.roundCount} 轮 · {new Date(item.updatedAt).toLocaleDateString()}</small></button>
          <div className="agent-conversation-actions"><button title="重命名会话" aria-label={`重命名 ${item.title}`} onClick={() => { setRenaming(item.id); setTitleDraft(item.title); }}><Pencil size={14} /></button><button title="删除会话" aria-label={`删除 ${item.title}`} onClick={() => setDeleteTarget(item.id)}><Trash2 size={14} /></button></div>
        </>}
        {deleteTarget === item.id && <div className="agent-delete-confirm"><p>删除会话？画廊结果与 Library 资产会保留。</p><button onClick={async () => { try { await agentApi.deleteConversation(item.id); setConversations(old => old.filter(row => row.id !== item.id)); if (item.id === activeId) { setActiveId(null); setSnapshot(null); } setDeleteTarget(null); } catch (reason) { setError(errorText(reason)); } }}>确认删除</button><button onClick={() => setDeleteTarget(null)}>取消</button></div>}
      </div>)}</nav>
      {nextCursor && <button onClick={async () => { try { const result = await agentApi.conversations(nextCursor); setConversations(old => [...old, ...result.conversations.filter(item => !old.some(row => row.id === item.id))]); setNextCursor(result.nextCursor); } catch (reason) { setError(errorText(reason)); } }}>加载更多会话</button>}
    </aside>
    <main className="agent-main">
      <header className="agent-workspace-head"><div>{collapsed && <button onClick={() => setCollapsed(false)} aria-label="展开会话列表"><PanelLeftOpen size={18} /></button>}<strong>{current?.conversation.title || 'Agent'}</strong><span>{config?.config.apiConfigMode === 'hybrid' ? '混合工具模式' : config?.config.apiConfigMode === 'native' ? 'Responses 原生模式' : '跟随当前 API 配置'}</span></div><button onClick={onOpenSettings} title="Agent 设置"><Settings size={18} /><span>设置</span></button></header>
      <div className="agent-messages" ref={scroll}>
        {loading && !current && <p className="agent-center"><LoaderCircle className="spin" />读取会话…</p>}
        {!loading && !rounds.length && <div className="agent-welcome"><MessageSquare size={34} /><h2>从一个想法开始</h2><p>讨论提示词，选入参考图，再按需要授权本轮生成。<br />文字讨论不会调用图片工具。</p><button onClick={onOpenSettings}>配置 Agent 调用路径</button></div>}
        {rounds.map((round, roundIndex) => {
          const assistant = current!.conversation.messages.find(message => message.id === round.assistantMessageId || message.roundId === round.id && message.role === 'assistant');
          const siblings = getAgentSiblingRounds(current!.conversation, round);
          const branchIndex = siblings.findIndex(item => item.id === round.id);
          const blocks = getAgentAssistantBlocks(round, current!.jobs, assistant?.content || '');
          return <article className="agent-round" key={round.id}>
            <div className="agent-user-message"><div className="agent-message-label">你 · 第 {roundIndex + 1} 轮</div>{round.inputImageIds.length > 0 && <div className="agent-reference-strip">{round.inputImageIds.map((id, i) => { const image = current!.images.find(image => image.id === id); const url = sameOriginImage(image?.thumbnailUrl || image?.url); return <div key={id} title={`参考图 ${i + 1}`}>{image?.status === 'available' && url ? <a href={sameOriginImage(image.url)} target="_blank" rel="noreferrer"><img src={url} alt={`参考图 ${i + 1}`} /></a> : <span>图片缺失</span>}<small>{i + 1}</small></div>; })}</div>}<p className="agent-original-text">{round.prompt}</p>
              <div className="agent-message-actions"><button title="复制原文" onClick={() => void copyTextToClipboard(round.prompt).then(ok => setNotice(ok ? '已复制原文' : '复制失败'))}><Copy size={15} /></button><button title="编辑重发为新分支" disabled={inFlight || busy || Boolean(uncertain)} onClick={() => void prepareEdit(round, 'edit')}><Pencil size={15} /></button><button title="重新生成为新分支" disabled={inFlight || busy || Boolean(uncertain)} onClick={() => void prepareEdit(round, 'regenerate')}><RotateCcw size={15} /></button>{siblings.length > 1 && <span className="agent-branch-controls"><button aria-label="上一分支" disabled={branchIndex === 0 || busy} onClick={() => void selectBranch(siblings[branchIndex - 1].id)}><ChevronLeft size={15} /></button>{branchIndex + 1} / {siblings.length}<button aria-label="下一分支" disabled={branchIndex === siblings.length - 1 || busy} onClick={() => void selectBranch(siblings[branchIndex + 1].id)}><ChevronRight size={15} /></button></span>}</div>
            </div>
            <div className="agent-assistant-message"><div className="agent-message-label">Agent {round.status === 'running' && <LoaderCircle size={14} className="spin" />}</div>
              {blocks.map(block => block.type === 'text' ? <MarkdownMessage key={block.key} text={block.content} /> : block.type === 'image-task' ? <ResultCard key={block.key} job={block.task} preview={current!.images.find(image => image.id === (block.task.metadata?.agent as Record<string, unknown> | undefined)?.partialImageId)} onOpen={() => onOpenJob(block.task.id)} onSaved={() => { onLibraryChanged(); onJobsChanged?.(); void agentApi.conversation(current!.conversation.id).then(applySnapshot).catch(() => {}); }} onError={setError} /> : block.type === 'deleted-image-task' ? <p key={block.key} className="agent-missing-image">原图片任务已不可用，保留引用位置。</p> : <div key={block.key} className="agent-tool-status"><span>{block.name === 'web_search' ? '网络搜索' : block.name}</span><small>{statusText[current?.request?.toolCalls.find(call => call.callId === block.callId)?.state || block.state || ''] || (block.state === 'in_progress' ? '进行中' : '工具调用')}</small></div>)}
              {!blocks.length && round.status === 'running' && <p className="agent-help">等待模型响应…</p>}
              {round.error && <p className="agent-error">{round.error}</p>}
              {assistant?.content && <button className="agent-text-button" title="复制回答" onClick={() => void copyTextToClipboard(assistant.content).then(ok => setNotice(ok ? '已复制回答' : '复制失败'))}><Copy size={14} />复制回答</button>}
            </div>
          </article>;
        })}
        {current?.request && <div className="agent-request-status"><strong>{statusText[current.request.state] || current.request.state}</strong><span>工具轮次 {current.request.usage.responseStepsStarted} / {current.request.authorization.maxToolRounds} · 图片 {current.request.usage.imageJobsCreated} / {current.request.authorization.maxImageJobs}</span>{current.request.recoveryReason && <p>{current.request.recoveryReason}</p>}{current.request.upstreamMayContinue && <p>已发送的上游请求可能仍在执行或计费；停止只阻止后续新调用。</p>}{current.request.canResume && <button disabled={busy} onClick={async () => { setBusy(true); try { applySnapshot(await agentApi.resume(current.request!.id, getAgentResumeId(localStorage, [current.request!.id, current.request!.usage.responseStepsStarted, current.request!.usage.imageJobsCreated].join(':'), () => crypto.randomUUID()))); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); } }}>继续已确认安全的步骤</button>}</div>}
      </div>
      <div className="agent-scroll-anchor">
        <button className="agent-scroll-bottom" aria-label="滚动到最新消息" onClick={() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' })}><ArrowDown size={16} /></button>
      </div>
      <div className="agent-input-area">
        {notice && <p role="status" className="agent-notice">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={13} /></button></p>}
        {error && <p role="alert" className="agent-error">{error}<button aria-label="关闭错误" onClick={() => setError('')}><X size={13} /></button></p>}
        {uncertain && <div className="agent-uncertain"><strong>上次提交结果尚未确认</strong><p>冻结的内容与请求 ID 已保留，重载不会自动重新收费提交。</p><button disabled={busy} onClick={() => void reconcile(uncertain)}>检查原请求状态</button><button disabled={busy} onClick={() => void reconcile(uncertain, true)}>用同一请求恢复</button></div>}
        {config && !config.ready && <p className="agent-help">{config.issues.map(issue => issue.message).join('；')} <button className="agent-text-button" onClick={onOpenSettings}>打开设置</button></p>}
        {draft.editId && <div className="agent-edit-notice">{draft.origin === 'regenerate' ? '重新生成' : '编辑重发'}会建立新分支，原记录保留。<button onClick={() => updateDraft({ editId: null, origin: 'send' })}>取消分支编辑</button></div>}
        <div className="agent-composer" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)); }}>
          {draft.refs.length > 0 && <div className="agent-reference-strip">{draft.refs.map((choice, index) => <div key={referenceKey(choice.reference)} className={choice.missing ? 'missing' : ''}>{choice.url ? <img src={sameOriginImage(choice.url)} alt={choice.label} /> : <span>{choice.missing ? '图片缺失' : '已选择图片'}</span>}<button title="插入图片引用" onClick={() => mention(`@图${index + 1}`)}>{index + 1}</button><button className="agent-remove-ref" title="移除参考图" disabled={Boolean(uncertain)} onClick={() => updateDraft({ refs: draft.refs.filter((_, i) => i !== index) })}><X size={12} /></button></div>)}</div>}
          <textarea ref={textarea} aria-label="Agent 消息" placeholder="输入想法、提示词或修改要求；输入 @ 引用图片" value={draft.text} disabled={Boolean(uncertain)} readOnly={draft.origin === 'regenerate'} rows={3} onChange={event => { updateDraft({ text: event.target.value }); if (event.target.value.slice(0, event.target.selectionStart).endsWith('@')) setShowMentions(true); }} onKeyDown={event => { if (shouldSubmitAgentOnKey({ ...event, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, readLocalPreferences().enterSubmit)) { event.preventDefault(); void submit(); } }} onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void addFiles(files); } }} />
          {showMentions && <div className="agent-mention-menu"><header>插入图片引用<button aria-label="关闭引用菜单" onClick={() => setShowMentions(false)}><X size={14} /></button></header>{draft.refs.map((choice, i) => <button key={referenceKey(choice.reference)} onClick={() => mention(`@图${i + 1}`)}>当前图 {i + 1} · {choice.label}</button>)}{rounds.flatMap((round, r) => round.outputTaskIds.map((jobId, i) => <button key={jobId} onClick={() => mention(`@第${r + 1}轮图${i + 1}`)}>第 {r + 1} 轮 · 图 {i + 1}</button>))}{!draft.refs.length && !rounds.some(round => round.outputTaskIds.length) && <p>先添加图片，或等待本轮生成结果。</p>}</div>}
          <div className="agent-composer-toolbar"><div><button title="从 Library 或画廊选择图片" disabled={Boolean(uncertain) || uploading || draft.refs.length >= inputLimit} onClick={() => setPicker(true)}><ImagePlus size={18} /></button><button title="上传图片文件" disabled={Boolean(uncertain) || uploading || draft.refs.length >= inputLimit} onClick={() => fileInput.current?.click()}><Plus size={18} /></button><button title="引用图片" onClick={() => setShowMentions(value => !value)}>＠</button>{uploading && <LoaderCircle size={17} className="spin" />}</div><span className="agent-help">{draft.refs.length} / {inputLimit} 张参考</span><button className="agent-send" title={inFlight ? '停止后续调用' : '发送本轮'} aria-label={inFlight ? '停止后续调用' : '发送 Agent 消息'} disabled={inFlight ? busy : busy || uploading || !draft.text.trim() || Boolean(uncertain) || !config || (!config.ready && config.config.apiConfigMode !== 'off')} onClick={() => void (inFlight ? stop() : submit())}>{busy ? <LoaderCircle className="spin" size={18} /> : inFlight ? <Square size={17} /> : <ArrowUp size={19} />}</button></div>
        </div>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void addFiles(files); }} />
        <div className="agent-authorization">{config?.config.webSearch && config.capabilities.webSearch && <label><input type="checkbox" checked={allowWebSearch} disabled={inFlight || Boolean(uncertain)} onChange={event => setAllowWebSearch(event.target.checked)} />本轮允许网络搜索</label>}<label><input type="checkbox" checked={allowImages} disabled={inFlight || Boolean(uncertain)} onChange={event => setAllowImages(event.target.checked)} />本轮允许生成图片</label><label>图片上限 <input type="number" aria-label="本轮图片上限" min={1} max={config?.config.maxImageJobs || 1} value={imageBudget} disabled={!allowImages || inFlight} onChange={event => setImageBudget(Math.max(1, Math.min(config?.config.maxImageJobs || 1, Number(event.target.value) || 1)))} /></label><label>工具轮次 <input type="number" aria-label="本轮工具轮次" min={1} max={config?.config.maxToolRounds || 1} value={toolBudget} disabled={inFlight} onChange={event => setToolBudget(Math.max(1, Math.min(config?.config.maxToolRounds || 1, Number(event.target.value) || 1)))} /></label></div>
        {config?.config.apiConfigMode === 'off' && <label className="agent-profile-select">本轮 API 配置<select value={activeProfileId} onChange={event => setActiveProfileId(event.target.value)}><option value="">选择配置</option>{config.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}</select></label>}
        <details className="agent-image-params"><summary>图片请求设置 · {draft.params.size} · {draft.params.quality}</summary><div><label>尺寸<input aria-label="Agent 图片尺寸" list="agent-size-options" value={draft.params.size} onChange={event => updateDraft({ params: { ...draft.params, size: event.target.value } })} /><datalist id="agent-size-options">{COMPATIBLE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{imageSizeLabel(size)}</option>)}</datalist></label><label>质量<select value={draft.params.quality} onChange={event => updateDraft({ params: { ...draft.params, quality: event.target.value } })}>{IMAGE25_QUALITIES.map(value => <option key={value}>{value}</option>)}</select></label><label>背景<select value={draft.params.background} onChange={event => updateDraft({ params: { ...draft.params, background: event.target.value } })}>{['auto', 'opaque', 'transparent'].map(value => <option key={value}>{value}</option>)}</select></label><label>格式<select value={draft.params.output_format} onChange={event => updateDraft({ params: { ...draft.params, output_format: event.target.value as AgentImageParams['output_format'] } })}>{['png', 'jpeg', 'webp'].map(value => <option key={value}>{value}</option>)}</select></label>{draft.params.output_format !== 'png' && <label>压缩（0–100）<input type="number" min={0} max={100} value={draft.params.output_compression ?? ''} onChange={event => updateDraft({ params: { ...draft.params, output_compression: event.target.value === '' ? null : Number(event.target.value) } })} /></label>}</div></details>
        <p className="agent-input-hint">{preferences.enterSubmit ? 'Enter 发送，Shift+Enter 换行' : 'Ctrl+Enter 发送，Enter 换行'} · 发送会调用所选文本模型，可能产生费用。配置保存与浏览不调用模型。</p>
      </div>
    </main>
    {picker && <AgentReferencePicker remaining={Math.max(0, inputLimit - draft.refs.length)} onClose={() => setPicker(false)} onSelect={choices => updateDraft({ refs: [...draft.refs, ...choices.filter(choice => !draft.refs.some(existing => referenceKey(existing.reference) === referenceKey(choice.reference)))] })} />}
  </section>;
}
