/* Adapted interaction structure from CookSleep/gpt_image_playground
 * src/components/AgentWorkspace.tsx, commit 1e9d5af60aadd9117a835cc2da43908b8e3370dd.
 * MIT, Copyright (c) 2026 CookSleep. Server snapshots replace the source store.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, ImagePlus, Info, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Search, SlidersHorizontal, Square, Trash2, X } from 'lucide-react';
import { useModalFocus } from '../../hooks/useModalFocus';
import { AgentMarkdown } from './AgentMarkdown';
import { useAgentConversations } from './useAgentConversations';
import { useAgentScroll } from './useAgentScroll';
import { api, mediaUrl } from '../../api/client';
import { AgentApiError, agentApi, getAgentConfig, watchAgentRequest, type AgentConfigResponse, type AgentConversationSummary, type AgentImage, type AgentImageRetryReceipt, type AgentRound, type AgentRoundCreate, type AgentSnapshot } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';
import { getActiveAgentRounds, getAgentBranchLeafId, getAgentSiblingRounds } from '../../utils/playground/agentConversationState';
import { agentPhaseLabels, getAgentAssistantBlocks, getAgentJobFailure, getAgentRoundStatus, getAgentRoundSummary, getAgentToolLabel, isAgentRequestActive } from '../../utils/playground/agentAssistantBlocks';
import { insertMention, referenceKey, resolveAgentPromptImageReferences, type ReferenceChoice } from '../../utils/playground/agentImageReferences';
import { AGENT_DRAFT_KEY, AGENT_IMAGE_MODE_PREFIX, acknowledgeAgentDraft, clearPendingAgentSubmission, draftFromPendingAgentSubmission, getAgentResumeId, readAgentDrafts, readAgentImageMode, readPendingAgentSubmissions, saveAgentImageMode, savePendingAgentSubmission, shouldSubmitAgentOnKey, type AgentDraft, type PendingAgentSubmission } from '../../utils/playground/agentSubmission';
import { resolveAuto4k } from '../../utils/compatibleRecipe';
import { agentJobSource, sharedImageCount, type AgentGalleryCommand, type GalleryImageSettings } from '../../utils/agentGalleryBridge';
import { readLocalPreferences } from '../../utils/localPreferences';
import { AGENT_INPUT_PREFERENCES_EVENT, readAgentInputPreferences } from '../../utils/agentInputPreferences';
import { copyTextToClipboard } from '../../utils/clipboard';
import { AgentReferencePicker } from './AgentReferencePicker';
import AgentImageOptions, { type AgentImageOptionsChange } from './AgentImageOptions';
import SizeDialog from '../gallery/SizeDialog';
import './AgentWorkspace.css';
import { AgentResponseDetails } from './AgentResponseDetails';
import AgentImageRetryButton from './AgentImageRetryButton';

export interface AgentWorkspaceProps {
  active: boolean;
  onOpenSettings: () => void;
  onProfileChange?: (profileId: string) => void;
  onOpenJob: (jobId: string) => void;
  onLibraryChanged: () => void;
  onJobsChanged?: () => void;
  focusConversationId?: string;
  focusToken?: number;
  galleryCommand?: AgentGalleryCommand;
  galleryImageSettings?: GalleryImageSettings;
  onGalleryImageSettingsChange?: (settings: GalleryImageSettings) => void;
}
type Draft = AgentDraft;
type AgentPanel = 'model' | 'add' | 'options' | 'mentions' | 'details';
const emptyDraft = (): Draft => ({ text: '', refs: [], params: { size: 'auto', quality: 'auto', background: 'auto', output_format: 'png' }, editId: null, origin: 'send' });
const statusText: Record<string, string> = { queued: '等待执行', running: '正在响应', waiting_for_jobs: '等待图片任务', stop_requested: '正在停止后续调用', completed: '已完成', stopped: '已停止后续调用', failed: '执行失败', interrupted: '执行已中断', unknown: '上游结果未知', succeeded: '已生成', accepted: '已收录', discarded: '已清理', cancelled: '已取消', pending: '等待执行' };
const ACTIVE_KEY = 'ipl.agent.active-conversation';
function safeStorageGet(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function safeStorageSet(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* UI preferences may be unavailable; submission journal is handled separately. */ } }
function errorText(reason: unknown) { return reason instanceof Error ? reason.message : '请求未完成'; }
function sameOriginImage(url?: string | null) { if (!url) return ''; try { const value = new URL(url, location.origin); return value.origin === location.origin ? value.href : ''; } catch { return ''; } }

function ResultCard({ job, preview, onOpen, onSaved, onError, onReference, referenceDisabled, retry }: { job: GenerationJobRecord; preview?: AgentImage; onOpen: () => void; onSaved: () => void; onError: (value: string) => void; onReference: () => void; referenceDisabled: boolean; retry?: ReactNode }) {
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
    {job.result_path ? <button className="agent-result-image" aria-label="查看生成结果" onClick={onOpen}><img src={mediaUrl(job.result_path)} alt="生成结果" loading="lazy" width={job.result_width || undefined} height={job.result_height || undefined} /></button> : preview?.status === 'available' && sameOriginImage(preview.url) ? <div className="agent-result-image"><img src={sameOriginImage(preview.url)} alt="生成中预览，非最终结果" width={preview.width || undefined} height={preview.height || undefined} /><p className="agent-help">生成中预览 · 非最终结果，尚不可收录</p></div> : <div className="agent-result-placeholder">{['queued', 'running'].includes(job.status) && <LoaderCircle size={22} className="spin" />}<span>{statusText[job.status] || job.status}</span></div>}
    {job.result_path && <div className="agent-result-meta"><span>{statusText[job.status] || job.status}</span><span>{job.result_width && job.result_height ? `${job.result_width} × ${job.result_height}` : '文件尺寸未返回'}</span></div>}
    {['failed', 'unknown'].includes(job.status) && <p className="agent-error"><strong>{getAgentJobFailure(job).label}</strong> · {getAgentJobFailure(job).action}</p>}
    <div className="agent-answer-actions"><button type="button" aria-label="复制生图提示词" title="复制生图提示词" onClick={() => void copyTextToClipboard(job.prompt_text).then(ok => { if (!ok) onError('复制失败'); })}><Copy size={15} /></button>{retry}</div>
    <footer><button aria-label="查看或编辑生成结果" onClick={onOpen}>查看 / 编辑</button>{job.result_path && ['succeeded','accepted'].includes(job.status) && <><button aria-label="加入本轮参考图" disabled={referenceDisabled} onClick={onReference}><ImagePlus size={16} />加入参考图</button><a href={mediaUrl(job.result_path)} download title="下载原文件"><Download size={16} /></a><button aria-label={saved ? '已收录到 Library' : '保存到 Library'} disabled={saving || saved} onClick={() => void save()}>{saved ? <Check size={16} /> : <Plus size={16} />}{saved ? '已收录' : saving ? '保存中' : '保存到 Library'}</button></>}</footer>
  </article>;
}

export default function AgentWorkspace({ active, onOpenSettings, onProfileChange, onOpenJob, onLibraryChanged, onJobsChanged, focusConversationId, focusToken, galleryCommand, galleryImageSettings, onGalleryImageSettingsChange }: AgentWorkspaceProps) {
  const [config, setConfig] = useState<AgentConfigResponse | null>(null);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [preferences, setPreferences] = useState(readLocalPreferences);
  const [inputPreferences, setInputPreferences] = useState(readAgentInputPreferences);
  const [activeId, setActiveId] = useState<string | null>(() => safeStorageGet(ACTIVE_KEY));
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const restored = readAgentDrafts(localStorage, readLocalPreferences().persistInputOnRestart);
    for (const entry of readPendingAgentSubmissions(localStorage)) if (!entry.preserveDraft) restored[entry.conversationId] = draftFromPendingAgentSubmission(entry, restored[entry.conversationId]);
    return restored;
  });
  const [pending, setPending] = useState<PendingAgentSubmission[]>(() => readPendingAgentSubmissions(localStorage));
  const [loading, setLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationLoadError, setConversationLoadError] = useState('');
  const [conversationRetry, setConversationRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [referenceGeometry, setReferenceGeometry] = useState<{url:string;size?:{width:number;height:number};status:'loading'|'ready'|'error'}>();
  const [focusRoundId, setFocusRoundId] = useState<string>();
  const consumedHandoff = useRef<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const { rows: conversations, nextCursor, loading: searching, error: searchError, stale: searchStale, refresh: refreshList, upsert: upsertConversation, remove: removeConversation } = useAgentConversations(active, search);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 760);
  const [picker, setPicker] = useState(false);
  const [panel, setPanel] = useState<AgentPanel | null>(null);
  const [inlineMentions, setInlineMentions] = useState(false);
  const [detailRoundId, setDetailRoundId] = useState<string | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({ left: 12, top: 64, maxHeight: 440 });
  // Restore only explicit per-conversation choices, never a past request's
  // authorization. A new unsent conversation remains off until opted in.
  const [imageModes, setImageModes] = useState<Record<string, boolean>>({});
  const [newImageMode, setNewImageMode] = useState(false);
  const [allowWebSearch, setAllowWebSearch] = useState(false);
  const [nativeImageCount, setNativeImageCount] = useState<1 | 3 | 5 | 10>(1);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);
  const [scrollbarActive, setScrollbarActive] = useState(false);
  const scrollbarTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSequence = useRef(0);
  const activeIdRef = useRef(activeId);
  const sending = useRef(false);
  const draftRevisions = useRef<Record<string, number>>({});
  const authorizationRevision = useRef({ images: 0, search: 0 });
  // A restored pending entry initialized its frozen draft above; revisions
  // start at zero. New requests bind their original send boundary below.
  const submissionBoundaries = useRef<Record<string, { conversationId: string; draft: number; authorization: { images: number; search: number } }>>(Object.fromEntries(pending.map(entry => [entry.payload.requestId, { conversationId: entry.conversationId, draft: 0, authorization: { images: 0, search: 0 } }])));
  const lastCompleted = useRef(new Set<string>());
  // Browser-only observation. A refresh intentionally loses the start boundary;
  // neither wall-clock timestamps nor old requests can manufacture this duration.
  const submissionStarts = useRef(new Map<string, number>());
  const [terminalObservations, setTerminalObservations] = useState<Record<string, number>>({});
  const settingsHandoff = useRef(false);
  activeIdRef.current = activeId;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draftKey = activeId || 'new';
  const imageMode = activeId ? (Object.hasOwn(imageModes, activeId) ? imageModes[activeId] : readAgentImageMode(localStorage, activeId)) : newImageMode;
  const imagesAllowed = imageMode;
  const uncertain = pending.find(entry => entry.conversationId === activeId);
  const storedDraft = drafts[draftKey] || emptyDraft();
  const sharedImages = config?.config.apiConfigMode === 'hybrid';
  const sharedUnavailable = sharedImages && galleryImageSettings ? galleryImageSettings.unavailable || (galleryImageSettings.provider !== 'openai_compatible' ? '画廊当前供应商不支持 Agent 的 Images API 调用，请选择 API 供应商。' : '') : undefined;
  // Shared pending choices never replace a submitted request or composer text/images.
  const draft = sharedImages && galleryImageSettings && (!uncertain || uncertain.preserveDraft) ? { ...storedDraft, params: galleryImageSettings.params, sizeMode: galleryImageSettings.sizeMode, imageConfig: { profileId: galleryImageSettings.profileId, model: galleryImageSettings.model } } : storedDraft;
  const imageCount = sharedImages ? sharedImageCount(galleryImageSettings?.count) : nativeImageCount;
  const current = snapshot?.conversation.id === activeId ? snapshot : null;
  const scrollToLatest = useAgentScroll({ containerRef: scroll, contentRef: scrollContent, active, conversationId: activeId, ready: Boolean(current) && !conversationLoading && !conversationLoadError, revision: current?.revision, focusRoundId, onFocusResolved: () => setFocusRoundId(undefined) });
  const conversationUnavailable = Boolean(activeId && !current);
  const rounds = useMemo(() => current ? getActiveAgentRounds(current.conversation) : [], [current]);
  const inFlight = Boolean(current && isAgentRequestActive(current.request?.state));
  const draftLocked = busy || Boolean(uncertain);
  const inputLimit = config?.capabilities.maxInputImages ?? 4;
  const imageProfile = config?.profiles.find(profile => profile.id === (config.config.apiConfigMode === 'hybrid' ? draft.imageConfig?.profileId || config.config.imageProfileId : config.config.apiConfigMode === 'off' ? activeProfileId : config.config.textProfileId));
  const imageModel = draft.imageConfig ? draft.imageConfig.model || (config?.config.apiConfigMode === 'hybrid' ? imageProfile?.model : '') || '' : config?.config.imageModel || (config?.config.apiConfigMode === 'hybrid' ? imageProfile?.model : '') || '';
  const incompatibleImageSelection = Boolean(config && config.config.apiConfigMode !== 'hybrid' && draft.imageConfig?.profileId);
  const imageReady = !sharedUnavailable && (config?.config.apiConfigMode !== 'hybrid' || (draft.imageConfig ? Boolean(imageProfile?.configured && imageModel.trim()) : Boolean(config.imageReady)));
  const currentProfile = config?.profiles.find(profile => profile.id === (config.config.apiConfigMode === 'off' ? activeProfileId : config.config.textProfileId));
  const detailRound = current?.conversation.rounds.find(round => round.id === detailRoundId);
  const detailRequest = current?.request?.id === detailRound?.requestId ? current?.request : null;
  const requestNeedsAttention = Boolean(current?.request && (['failed', 'unknown', 'interrupted'].includes(current.request.state) || current.request.error || current.request.recoveryReason || current.request.upstreamMayContinue || current.request.canResume));
  const closePanel = useCallback(() => setPanel(null), []);
  useEffect(() => { if (activeId) setNewImageMode(false); }, [activeId]);
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key === null) setImageModes({});
      else if (event.key?.startsWith(AGENT_IMAGE_MODE_PREFIX)) {
        const id = event.key.slice(AGENT_IMAGE_MODE_PREFIX.length);
        setImageModes(old => ({ ...old, [id]: readAgentImageMode(localStorage, id) }));
      }
    };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  function openSettings() {
    if (!panel) { onOpenSettings(); return; }
    settingsHandoff.current = true;
    closePanel();
  }
  const { containerRef: panelRef, handleModalKeyDown } = useModalFocus<HTMLDivElement>(closePanel, { active: Boolean(panel) && active, fallbackFocusSelector: '.agent-workspace:not([hidden]) .agent-options-trigger' });
  function openPanel(kind: AgentPanel, anchor?: HTMLElement | null, roundId?: string) {
    setInlineMentions(false);
    const rect = anchor?.getBoundingClientRect();
    const width = window.innerWidth || 1024, height = window.innerHeight || 768;
    const below = rect ? height - rect.bottom - 20 : height - 84;
    const above = rect ? rect.top - 20 : 0;
    const bottom = kind !== 'model' && above > below;
    if (kind === 'details') {
      setPanelPosition({ left: Math.max(12, Math.min(rect?.left || 12, width - 412)), top: 24, maxHeight: Math.max(100, height - 48) });
      setDetailRoundId(roundId || null); setPanel(kind); return;
    }
    setPanelPosition({ left: Math.max(12, Math.min(rect?.left || 12, width - (kind === 'add' ? 260 : 400) - 12)), ...(bottom ? { bottom: height - rect!.top + 8 } : { top: Math.max(12, rect ? rect.bottom + 8 : 64) }), maxHeight: Math.max(100, Math.min(height - 24, bottom ? above : below)) });
    setDetailRoundId(roundId || null);
    setPanel(kind);
  }
  useEffect(() => {
    setPanel(null); setInlineMentions(false); setSizeOpen(false);
  }, [active, activeId]);
  useEffect(() => {
    if (!active || !panel) return;
    const root = document.getElementById('root'), wasInert = root?.inert;
    if (root) root.inert = true;
    window.addEventListener('resize', closePanel);
    return () => { if (root) root.inert = Boolean(wasInert); window.removeEventListener('resize', closePanel); };
  }, [active, panel, closePanel]);
  useEffect(() => {
    // The settings drawer lives inside #root. Open it only after this portal's
    // modal cleanup has released that root, so its initial focus can succeed.
    if (panel || !settingsHandoff.current) return;
    settingsHandoff.current = false;
    if (active) onOpenSettings();
  }, [panel, active, onOpenSettings]);
  useEffect(() => {
    const element = textarea.current;
    if (!active || !element) return;
    const resize = () => { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, Math.max(72, Math.min(180, window.innerHeight * .24)))}px`; };
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [active, draft.text, activeId]);

  useEffect(() => { onProfileChange?.(activeProfileId); }, [activeProfileId, onProfileChange]);
  useEffect(() => {
    if (config && (!config.config.webSearch || !config.capabilities.webSearch)) setAllowWebSearch(false);
  }, [config]);

  useEffect(() => {
    if (focusConversationId) { setActiveId(focusConversationId); setDeleteTarget(null); }
  }, [focusConversationId, focusToken]);

  // Handoffs only prepare a draft or select a recorded branch. They never
  // authorize image generation, replay a request or replace prompt/settings.
  useEffect(() => {
    if (!active) {setHandoffBusy(false);return;}
    if (!galleryCommand || consumedHandoff.current === galleryCommand.id) return;
    if (busy || uploading || inFlight || uncertain) {setNotice('当前请求或附件读取结束后，将准备画廊图片；不会自动发送。');return;}
    let disposed = false;
    const command = galleryCommand;
    const expectedActive = activeIdRef.current;
    setHandoffBusy(true); setError('');
    void (async () => {
      const job = await api.generationJob(command.job.id);
      if (disposed) return;
      if (command.intent === 'reference' && (!job.result_path || !['succeeded','accepted'].includes(job.status))) throw new Error('这张结果图片已不可用，当前草稿仍保留。');
      const source = agentJobSource(job);
      let target: AgentSnapshot | null = null;
      let roundId: string | undefined;
      if (source) {
        try { target = await agentApi.conversation(source.conversationId); }
        catch (reason) {
          if (command.intent === 'conversation' || !(reason instanceof AgentApiError) || reason.status !== 404) throw reason;
          // The image may outlive its conversation. It can still be explicitly
          // added to the current draft, without recreating the old conversation.
        }
        if (disposed) return;
        if (target) {
          const owner = target.conversation.rounds.find(round => [...round.outputTaskIds, ...(round.retryTaskIds || [])].includes(job.id) && (!source.roundId || round.id === source.roundId));
          if (!owner) throw new Error('图片与来源轮次不匹配，未改变当前草稿。');
          roundId = owner.id;
          if (isAgentRequestActive(target.request?.state)) throw new Error('来源会话正在执行，请完成或停止后再带入图片。');
          if (activeIdRef.current !== expectedActive) throw new Error('你已切换会话，本次图片交接已取消。');
        }
      } else if (command.intent === 'conversation') throw new Error('此图片没有记录 Agent 来源会话。');
      if (disposed) return;
      if (activeIdRef.current !== expectedActive) throw new Error('你已切换会话，本次图片交接已取消。');
      const key = target?.conversation.id || expectedActive || 'new';
      // A different conversation may have an uncertain submission even when
      // the currently visible draft is editable. Keep its frozen draft intact.
      if (readPendingAgentSubmissions(localStorage).some(entry => entry.conversationId === key)) throw new Error('目标会话有尚未确认的请求，请先确认原请求状态；草稿和分支保持不变。');
      const currentDraft = draftsRef.current[key] || emptyDraft();
      if (command.intent === 'reference' && currentDraft.refs.length >= inputLimit && !currentDraft.refs.some(choice => choice.reference.kind === 'job' && choice.reference.jobId === job.id)) throw new Error(`最多使用 ${inputLimit} 张参考图。原草稿保留，请先移除一张再带入。`);
      // Validate the destination before mutating its saved branch.
      if (target && target.conversation.activeRoundId !== roundId) target = await agentApi.updateConversation(target.conversation.id, {expectedRevision:target.revision, activeRoundId:roundId});
      if (disposed) return;
      if (activeIdRef.current !== expectedActive) throw new Error('你已切换会话，本次图片交接已取消。');
      // The user can keep editing while the branch selection is in flight.
      // Recheck the live draft instead of reporting an addition that was skipped.
      if (readPendingAgentSubmissions(localStorage).some(entry => entry.conversationId === key)) throw new Error('目标会话有尚未确认的请求，未添加图片，请先确认原请求状态。');
      const latestDraft = draftsRef.current[key] || emptyDraft();
      if (command.intent === 'reference' && latestDraft.refs.length >= inputLimit && !latestDraft.refs.some(choice => choice.reference.kind === 'job' && choice.reference.jobId === job.id)) throw new Error(`最多使用 ${inputLimit} 张参考图，未添加画廊图片；原草稿和附件保留。`);
      if (target) { activeIdRef.current = target.conversation.id; setActiveId(target.conversation.id); applySnapshot(target); setFocusRoundId(roundId); }
      if (command.intent === 'reference') {
        const choice: ReferenceChoice = {reference:{kind:'job',jobId:job.id},label:'画廊结果',url:mediaUrl(job.result_path!)};
        draftRevisions.current[key] = (draftRevisions.current[key] || 0) + 1;
        setDrafts(old => {
          const previous = old[key] || emptyDraft();
          if (previous.refs.some(ref => referenceKey(ref.reference) === referenceKey(choice.reference))) return old;
          // Do not truncate existing references if another selection completed.
          if (previous.refs.length >= inputLimit) return old;
          return {...old,[key]:{...previous,refs:[...previous.refs,choice]}};
        });
        setNotice('已带入画廊图片；原提示词、附件和参数保留，尚未发送。');
      } else setNotice('已定位图片所属轮次；当前草稿保持不变。');
      setAllowWebSearch(false);
      consumedHandoff.current = command.id;
    })().catch(reason => {if (!disposed) {setError(errorText(reason)); consumedHandoff.current = command.id;}}).finally(() => {if (!disposed) setHandoffBusy(false);});
    return () => {disposed = true;};
  }, [active, galleryCommand?.id, busy, uploading, inFlight, uncertain?.payload.requestId]);

  const firstSizeRef = resolveAgentPromptImageReferences(draft.text, rounds, new Set((current?.jobs || []).filter(job => job.result_path && ['succeeded','accepted'].includes(job.status)).map(job => job.id)), draft.refs.map(choice => choice.reference)).refs[0];
  const firstSizeChoice = firstSizeRef ? draft.refs.find(choice => referenceKey(choice.reference) === referenceKey(firstSizeRef)) : undefined;
  const firstSizeAsset = firstSizeRef ? current?.images.find(image => referenceKey(image.source) === referenceKey(firstSizeRef)) : undefined;
  const firstSizeJob = firstSizeRef?.kind === 'job' ? current?.jobs.find(job => job.id === firstSizeRef.jobId) : undefined;
  const sizeReferenceUrl = sameOriginImage(firstSizeChoice?.url || firstSizeAsset?.url || (firstSizeJob?.result_path ? mediaUrl(firstSizeJob.result_path) : ''));
  const measuredReferenceSize = referenceGeometry?.url === sizeReferenceUrl ? referenceGeometry.size : undefined;
  const sizeReferenceStatus = !firstSizeRef ? 'ready' : referenceGeometry?.url === sizeReferenceUrl ? referenceGeometry.status : 'loading';
  useEffect(() => {
    if (!active || (!sizeOpen && draft.sizeMode !== 'auto4k') || !firstSizeRef) return;
    let disposed = false;
    setReferenceGeometry({url:sizeReferenceUrl,status:'loading'});
    if (!sizeReferenceUrl) {setReferenceGeometry({url:'',status:'error'});return;}
    const image = new Image(); image.src = sizeReferenceUrl;
    void image.decode().then(() => {if (!disposed) setReferenceGeometry({url:sizeReferenceUrl,size:{width:image.naturalWidth,height:image.naturalHeight},status:'ready'});}).catch(() => {if (!disposed) setReferenceGeometry({url:sizeReferenceUrl,status:'error'});});
    return () => {disposed = true;};
  }, [active, sizeOpen, draft.sizeMode, sizeReferenceUrl, Boolean(firstSizeRef)]);

  function updateImageSettings(change: AgentImageOptionsChange) {
    if (draftLocked) return;
    if (sharedImages && onGalleryImageSettingsChange) {
      const base: GalleryImageSettings = galleryImageSettings || { provider: 'openai_compatible', profileId: config?.config.imageProfileId || '', model: imageModel, params: draft.params, count: 1 };
      onGalleryImageSettingsChange({ ...base, provider: 'openai_compatible',
        ...(change.imageConfig ? { profileId: change.imageConfig.profileId || '', model: change.imageConfig.model, unavailable: undefined } : {}),
        ...(change.params ? { params: structuredClone(change.params) } : {}),
        ...('sizeMode' in change ? { sizeMode: change.sizeMode } : {}),
        ...(change.count ? { count: change.count } : {}),
      });
    } else {
      const { count, ...draftChange } = change;
      if (count) setNativeImageCount(count);
      updateDraft(draftChange);
    }
  }

  function addResultReference(job: GenerationJobRecord) {
    if (draftLocked || uploading || handoffBusy || !job.result_path || !['succeeded','accepted'].includes(job.status)) return;
    if (draft.refs.some(choice => choice.reference.kind === 'job' && choice.reference.jobId === job.id)) {setNotice('这张图片已在本轮参考图中。');return;}
    if (draft.refs.length >= inputLimit) {setError(`最多使用 ${inputLimit} 张参考图，请先移除一张。`);return;}
    updateDraft({refs:[...draft.refs,{reference:{kind:'job',jobId:job.id},url:mediaUrl(job.result_path),label:'生成结果'}]});
    setNotice('已加入本轮参考图；填写修改要求后发送。'); textarea.current?.focus();
  }

  function updateDraft(change: Partial<Draft>) {
    if (busy || uncertain) return;
    draftRevisions.current[draftKey] = (draftRevisions.current[draftKey] || 0) + 1;
    setDrafts(old => ({ ...old, [draftKey]: { ...(old[draftKey] || emptyDraft()), ...change } }));
  }
  function acknowledgeDraft(key: string, revision: number) {
    const clearInput = readAgentInputPreferences().clearInputAfterSubmit;
    setDrafts(old => (draftRevisions.current[key] || 0) !== revision || !old[key] ? old : {
      ...old, [key]: acknowledgeAgentDraft(old[key], clearInput),
    });
  }
  function setRequestAuthorization(kind: 'images' | 'search', allowed: boolean) {
    if (activeIdRef.current !== activeId) return;
    authorizationRevision.current[kind] += 1;
    if (kind === 'search') setAllowWebSearch(allowed);
  }
  function acknowledgeAuthorization(key: string, revision: { images: number; search: number }) {
    // A receipt belongs to one conversation and one explicit choice. It must
    // not revoke permission the user subsequently chose for another draft.
    if (activeIdRef.current !== key) return;
    if (authorizationRevision.current.search === revision.search) setAllowWebSearch(false);
  }
  function acknowledgeSubmission(entry: PendingAgentSubmission) {
    if (entry.preserveDraft) { delete submissionBoundaries.current[entry.payload.requestId]; return; }
    const boundary = submissionBoundaries.current[entry.payload.requestId];
    // A foreign/missing boundary cannot establish that the visible draft or
    // its permissions still belong to this request. Keep them conservatively.
    if (!boundary || boundary.conversationId !== entry.conversationId) return;
    if (!entry.preserveDraft) acknowledgeDraft(entry.conversationId, boundary.draft);
    acknowledgeAuthorization(entry.conversationId, boundary.authorization);
    delete submissionBoundaries.current[entry.payload.requestId];
  }
  const applySnapshot = useCallback((value: AgentSnapshot) => {
    const request = value.request;
    const started = request ? submissionStarts.current.get(request.id) : undefined;
    if (request && started !== undefined && !isAgentRequestActive(request.state)) {
      submissionStarts.current.delete(request.id);
      const elapsed = Math.max(0, performance.now() - started);
      setTerminalObservations(old => ({ ...old, [request.id]: elapsed }));
    }
    if (activeIdRef.current === value.conversation.id) setSnapshot(old => !old || old.conversation.id !== value.conversation.id || value.revision >= old.revision ? value : old);
    const row: AgentConversationSummary = { id: value.conversation.id, title: value.conversation.title, activeRoundId: value.conversation.activeRoundId, createdAt: value.conversation.createdAt, updatedAt: value.conversation.updatedAt, roundCount: value.conversation.rounds.length, runningRequestId: isAgentRequestActive(value.request?.state) ? value.request!.id : null, revision: value.revision };
    upsertConversation(row);
  }, [upsertConversation]);
  async function retryAccepted(_receipt: AgentImageRetryReceipt, conversationId: string) {
    onJobsChanged?.();
    try { const value = await agentApi.conversation(conversationId); if (activeIdRef.current === conversationId) applySnapshot(value); }
    catch { if (activeIdRef.current === conversationId) setNotice('重试任务已创建，可以在画廊查看。'); }
  }
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setError('');
    void getAgentConfig().then(value => {
      if (disposed) return;
      setConfig(value);
    }).catch(reason => { if (!disposed) setError(errorText(reason)); }).finally(() => { if (!disposed) setLoading(false); });
    const refreshConfig = () => { void getAgentConfig().then(value => {
      if (disposed) return;
      setConfig(value);
      if (!value.config.webSearch || !value.capabilities.webSearch) setAllowWebSearch(false);

    }).catch(reason => { if (!disposed) setError(errorText(reason)); }); };
    window.addEventListener('ipl:agent-config-changed', refreshConfig);
    return () => { disposed = true; window.removeEventListener('ipl:agent-config-changed', refreshConfig); };
  }, [active]);
  useEffect(() => {
    // An explicit Gallery handoff owns initial destination selection. A late
    // conversation list must not hide the new draft it just prepared.
    if (active && !galleryCommand && !search.trim() && !activeIdRef.current && conversations.length) setActiveId(conversations[0].id);
  }, [active, galleryCommand, search, conversations]);
  useEffect(() => {
    const sequence = ++requestSequence.current;
    let disposed = false;
    setConversationLoadError('');
    if (!activeId) { setSnapshot(null); setConversationLoading(false); try { localStorage.removeItem(ACTIVE_KEY); } catch { /* optional UI preference */ } return; }
    setConversationLoading(true); setError(''); setAllowWebSearch(false);
    safeStorageSet(ACTIVE_KEY, activeId);
    const relevant = () => !disposed && sequence === requestSequence.current;
    void agentApi.conversation(activeId).then(value => { if (relevant()) applySnapshot(value); }).catch(reason => { if (relevant()) setConversationLoadError(errorText(reason)); }).finally(() => { if (relevant()) setConversationLoading(false); });
    return () => { disposed = true; };
  }, [activeId, applySnapshot, conversationRetry]);
  useEffect(() => {
    const refreshPreferences = () => setPreferences(readLocalPreferences());
    window.addEventListener('ipl:local-preferences-changed', refreshPreferences);
    window.addEventListener('storage', refreshPreferences);
    return () => { window.removeEventListener('ipl:local-preferences-changed', refreshPreferences); window.removeEventListener('storage', refreshPreferences); };
  }, []);
  useEffect(() => {
    const refresh = () => setInputPreferences(readAgentInputPreferences());
    window.addEventListener(AGENT_INPUT_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(AGENT_INPUT_PREFERENCES_EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  useEffect(() => {
    if (!preferences.persistInputOnRestart) { try { localStorage.removeItem(AGENT_DRAFT_KEY); } catch { /* optional */ } return; }
    safeStorageSet(AGENT_DRAFT_KEY, JSON.stringify(drafts));
  }, [drafts, preferences.persistInputOnRestart]);
  useEffect(() => {
    if (!active || !current?.request || !isAgentRequestActive(current.request.state)) return;
    const requestId = current.request.id;
    const jobVersion = (value: AgentSnapshot) => JSON.stringify(value.jobs.map(job => [job.id, job.status, job.result_path, job.accepted_image_id, job.error]));
    let lastJobs = jobVersion(current);
    return watchAgentRequest(requestId, value => {
      applySnapshot(value);
      // Text deltas do not change Gallery jobs. Avoid refreshing the other
      // workspaces for each token while keeping image progress synchronized.
      const nextJobs = jobVersion(value);
      if (nextJobs !== lastJobs) { lastJobs = nextJobs; onJobsChanged?.(); }
      if (!isAgentRequestActive(value.request?.state) && !lastCompleted.current.has(requestId)) {
        lastCompleted.current.add(requestId);
        if (readLocalPreferences().notifyOnCompletion) setNotice(value.request?.state === 'completed' ? 'Agent 本轮已完成' : 'Agent 本轮已结束，请查看状态');
      }
    }, reason => setError(`状态读取失败：${errorText(reason)}。不会重新提交模型请求。`), config?.capabilities.progressTransport === 'sse');
  }, [active, current?.request?.id, inFlight, config?.capabilities.progressTransport, applySnapshot, onJobsChanged]);
  const retryProgress = current?.jobs.filter(job => (job.metadata?.agentRetry || current.conversation.rounds.some(round => round.retryTaskIds?.includes(job.id))) && ['queued', 'running'].includes(job.status)).map(job => job.id).join(',') || '';
  useEffect(() => {
    if (!active || !current || !retryProgress || inFlight) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const conversationId = current.conversation.id;
    const poll = async () => {
      try { const value = await agentApi.conversation(conversationId); if (!disposed) { applySnapshot(value); onJobsChanged?.(); } }
      catch { /* A missed read never retries the image POST. */ }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, current?.conversation.id, retryProgress, inFlight, applySnapshot, onJobsChanged]);
  useEffect(() => {
    setScrollbarActive(false);
    return () => {
      if (scrollbarTimer.current !== null) clearTimeout(scrollbarTimer.current);
      scrollbarTimer.current = null;
    };
  }, [active, activeId]);
  function revealScrollbar() {
    if (!active) return;
    setScrollbarActive(true);
    if (scrollbarTimer.current !== null) clearTimeout(scrollbarTimer.current);
    scrollbarTimer.current = setTimeout(() => { scrollbarTimer.current = null; setScrollbarActive(false); }, 1000);
  }

  async function newConversation() {
    setBusy(true); setError('');
    try { const value = await agentApi.createConversation(crypto.randomUUID()); activeIdRef.current = value.conversation.id; setActiveId(value.conversation.id); applySnapshot(value); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  function rememberImageMode(conversationId: string, enabled: boolean) {
    setImageModes(old => ({ ...old, [conversationId]: enabled }));
    try { saveAgentImageMode(localStorage, conversationId, enabled); }
    catch { setError(`当前生图模式已${enabled ? '开启' : '关闭'}，但浏览器无法保存此选择；刷新后请检查开关状态。`); }
  }
  async function selectBranch(id: string) {
    if (!current || busy) return;
    setBusy(true);
    try { applySnapshot(await agentApi.updateConversation(current.conversation.id, { expectedRevision: current.revision, activeRoundId: getAgentBranchLeafId(current.conversation, id) })); updateDraft({ editId: null, origin: 'send' }); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function prepareEdit(round: AgentRound, origin: 'edit' | 'regenerate') {
    if (!current || inFlight || uncertain) return;
    const key = draftKey, revision = draftRevisions.current[draftKey] || 0;
    setBusy(true); setError('');
    try {
      const original = await agentApi.request(round.requestId);
      const choices = round.inputImageIds.map(id => {
        const image = original.images.find(image => image.id === id) || current.images.find(image => image.id === id);
        return image ? { reference: image.source, label: '原始参考图', url: sameOriginImage(image.thumbnailUrl || image.url), missing: image.status !== 'available' } : null;
      });
      if (choices.some(choice => !choice)) throw new Error('原始参考图记录缺失，不能悄悄改为无参考图生成。');
      if (activeIdRef.current !== key || (draftRevisions.current[key] || 0) !== revision) return;
      updateDraft({ text: round.prompt, refs: choices as ReferenceChoice[], editId: round.id, origin });
      textarea.current?.focus();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function retryText(round: AgentRound) {
    if (!current || !config || sending.current || busy || inFlight || uncertain || uploading || handoffBusy) return;
    const conversation = current, key = current.conversation.id;
    const frozenConfig = structuredClone(config), frozenParams = emptyDraft().params;
    sending.current = true; setBusy(true); setError('');
    let entry: PendingAgentSubmission | undefined;
    try {
      const original = await agentApi.request(round.requestId);
      const images = round.inputImageIds.map(id => original.images.find(image => image.id === id));
      if (images.some(image => !image || image.status !== 'available')) throw new Error('原参考图片不可用，不能省略或换图重试。');
      if (activeIdRef.current !== key) return;
      const payload: AgentRoundCreate = {
        requestId: crypto.randomUUID(), expectedRevision: conversation.revision,
        parentRoundId: round.parentRoundId, origin: 'regenerate', derivedFromRoundId: round.id,
        prompt: round.prompt, refs: images.map(image => image!.source), configRevision: frozenConfig.revision,
        activeProfileId: activeProfileId || null, params: frozenParams,
        authorization: { scope: 'this_request', allowImageGeneration: false, allowWebSearch: false,
          maxImageJobs: 0, maxToolRounds: frozenConfig.config.maxToolRounds },
      };
      // A reply retry is independent of the user's unsent draft, including after reload.
      entry = { conversationId: key, payload, preserveDraft: true };
      savePendingAgentSubmission(localStorage, entry); setPending(readPendingAgentSubmissions(localStorage));
      submissionStarts.current.set(payload.requestId, performance.now());
      const value = await agentApi.submit(key, payload);
      clearPendingAgentSubmission(localStorage, payload.requestId); setPending(readPendingAgentSubmissions(localStorage));
      applySnapshot(value); onJobsChanged?.();
      if (activeIdRef.current === key) scrollToLatest();
    } catch (reason) {
      if (entry && reason instanceof AgentApiError && [400, 401, 403, 404, 409, 422].includes(reason.status)) {
        clearPendingAgentSubmission(localStorage, entry.payload.requestId); setPending(readPendingAgentSubmissions(localStorage));
        submissionStarts.current.delete(entry.payload.requestId);
      }
      setError(errorText(reason));
    } finally { sending.current = false; setBusy(false); }
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
      draftRevisions.current[targetKey] = (draftRevisions.current[targetKey] || 0) + 1;
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
      acknowledgeSubmission(entry);
      setNotice('已确认原请求状态；没有创建第二个请求。');
    } catch (reason) {
      if (replayedMissingRequest && reason instanceof AgentApiError && [400, 404, 409, 422].includes(reason.status)) {
        // A missing request followed by an explicit local validation rejection
        // has not entered the paid execution queue. Unlock the preserved draft.
        clearPendingAgentSubmission(localStorage, entry.payload.requestId); setPending(readPendingAgentSubmissions(localStorage));
        delete submissionBoundaries.current[entry.payload.requestId];
        setError(`${errorText(reason)}。图库已明确拒绝该请求；图文仍保留，可修改后发送。`);
      } else setError(`${errorText(reason)}。原请求 ID 与内容已保留。`);
    } finally { setBusy(false); }
  }
  async function submit() {
    if (activeIdRef.current !== activeId || sending.current || busy || handoffBusy || uploading || inFlight || uncertain || conversationUnavailable || !draft.text.trim() || !config) return;
    if (imagesAllowed && incompatibleImageSelection) {setError('生图方式已改变，旧供应商选择不适用于当前方式。请在生图设置中重新选择生图模型；原草稿和附件保留。');return;}
    if (imagesAllowed && (!imageReady || imageCount > config.config.maxImageJobs)) { setError(sharedUnavailable || (!imageReady ? '请先完善生图设置，草稿与附件保留。' : `当前数量 ${imageCount} 超出 Agent 已配置的 ${config.config.maxImageJobs} 张安全上限，请调整数量或设置中的上限。`)); return; }
    if (draft.refs.some(ref => ref.missing)) { setError('存在缺失参考图，请明确替换或移除后再发送。'); return; }
    const derived = draft.editId ? current?.conversation.rounds.find(round => round.id === draft.editId) : null;
    if (draft.editId && !derived) { setError('原分支已不存在，请重新选择。'); return; }
    const branch = derived ? rounds.slice(0, rounds.findIndex(round => round.id === derived.id)) : rounds;
    const resolved = resolveAgentPromptImageReferences(draft.text, branch, new Set((current?.jobs || []).filter(job => job.result_path && ['succeeded', 'accepted'].includes(job.status)).map(job => job.id)), draft.refs.map(choice => choice.reference));
    if (resolved.missing.length) { setError(`引用不存在或图片尚未完成：${resolved.missing.join('、')}`); return; }
    if (resolved.refs.length > inputLimit) { setError(`包括 @ 引用在内最多 ${inputLimit} 张图片。`); return; }
    let resolvedParams = structuredClone(imagesAllowed ? draft.params : emptyDraft().params);
    if (imagesAllowed && draft.sizeMode === 'auto4k') {
      const auto = resolveAuto4k(draft.text, measuredReferenceSize);
      if ('error' in auto) {setError('提示词中的比例无效或冲突，请先明确本轮比例。');return;}
      if (auto.source !== 'prompt' && resolved.refs.length && sizeReferenceStatus !== 'ready') {setError(sizeReferenceStatus === 'error' ? '无法读取首张参考图尺寸，请重新选择图片或设置明确尺寸。' : '正在读取首张参考图尺寸，请稍后发送。');return;}
      resolvedParams = {...resolvedParams,size:auto.size};
    }
    const restoreComposerFocus = textarea.current !== null && document.activeElement === textarea.current;
    sending.current = true; setBusy(true); setError(''); setNotice('');
    let submittedRevision = draftRevisions.current[draftKey] || 0;
    const submittedAuthorizationRevision = { ...authorizationRevision.current };
    let entry: PendingAgentSubmission | null = null;
    try {
      let value = current;
      if (!value && !activeId) {
        value = await agentApi.createConversation(crypto.randomUUID());
        if (newImageMode) rememberImageMode(value.conversation.id, true);
        setNewImageMode(false);
        activeIdRef.current = value.conversation.id; setActiveId(value.conversation.id); applySnapshot(value);
        const originalRevision = submittedRevision;
        submittedRevision = draftRevisions.current[value.conversation.id] || 0;
        setDrafts(old => {
          const next = { ...old, [value!.conversation.id]: draft };
          if ((draftRevisions.current[draftKey] || 0) === originalRevision) delete next.new;
          return next;
        });
      }
      if (!value) return;
      const payload: AgentRoundCreate = {
        requestId: crypto.randomUUID(), expectedRevision: value.revision, parentRoundId: derived ? derived.parentRoundId : value.conversation.activeRoundId,
        origin: draft.origin, derivedFromRoundId: derived?.id, prompt: draft.text, refs: resolved.refs,
        configRevision: config.revision, activeProfileId: activeProfileId || null, params: resolvedParams, imageCount,
        ...(imagesAllowed && draft.imageConfig ? {imageConfig:structuredClone(draft.imageConfig)} : {}),
        authorization: { scope: 'this_request', allowImageGeneration: imagesAllowed, allowWebSearch: Boolean(allowWebSearch && config.config.webSearch && config.capabilities.webSearch), maxImageJobs: imagesAllowed ? config.config.maxImageJobs : 0, maxToolRounds: config.config.maxToolRounds },
      };
      entry = { conversationId: value.conversation.id, payload };
      savePendingAgentSubmission(localStorage, entry);
      submissionBoundaries.current[payload.requestId] = { conversationId: entry.conversationId, draft: submittedRevision, authorization: submittedAuthorizationRevision };
      setPending(readPendingAgentSubmissions(localStorage));
      submissionStarts.current.set(payload.requestId, performance.now());
      const result = await agentApi.submit(entry.conversationId, payload);
      clearPendingAgentSubmission(localStorage, payload.requestId); setPending(readPendingAgentSubmissions(localStorage)); applySnapshot(result); onJobsChanged?.();
      acknowledgeSubmission(entry);
      requestAnimationFrame(() => {
        if (activeIdRef.current === entry!.conversationId) scrollToLatest();
        if (restoreComposerFocus && activeIdRef.current === entry!.conversationId && textarea.current?.isConnected && document.activeElement === document.body) textarea.current.focus();
      });
    } catch (reason) {
      // An explicit schema/config rejection is safe to edit. Network errors and
      // server errors retain the frozen request for read-only reconciliation.
      if (entry && reason instanceof AgentApiError && [400, 404, 409, 422].includes(reason.status)) { clearPendingAgentSubmission(localStorage, entry.payload.requestId); setPending(readPendingAgentSubmissions(localStorage)); delete submissionBoundaries.current[entry.payload.requestId]; submissionStarts.current.delete(entry.payload.requestId); }
      setError(`${errorText(reason)}${entry && !(reason instanceof AgentApiError) ? '。提交结果不确定；请检查原请求，不要重新发起。' : ''}`);
    } finally { sending.current = false; setBusy(false); }
  }
  function mention(value: string, choice?: ReferenceChoice) {
    if (busy || uncertain) return;
    if (draft.origin === 'regenerate' || choice?.missing) return;
    const refs = choice && !draft.refs.some(ref => referenceKey(ref.reference) === referenceKey(choice.reference)) ? [...draft.refs, choice] : draft.refs;
    if (refs.length > inputLimit) { setError(`最多使用 ${inputLimit} 张参考图，请先移除一张再引用。`); return; }
    const element = textarea.current;
    const result = insertMention(draft.text, element?.selectionStart ?? draft.text.length, element?.selectionEnd ?? draft.text.length, value);
    updateDraft({ text: result.text, refs }); setPanel(null); setInlineMentions(false);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(result.caret, result.caret); });
  }
  function mentionChoices() {
    const disabled = draftLocked || uploading || draft.origin === 'regenerate';
    const priorRounds = draft.editId ? rounds.slice(0, rounds.findIndex(round => round.id === draft.editId)) : rounds;
    return <>
      {draft.refs.map((choice, i) => <button className="agent-mention-choice" key={referenceKey(choice.reference)} aria-label={`引用当前图 ${i + 1}`} disabled={disabled || choice.missing} onClick={() => mention(`@图${i + 1}`)}>
        {sameOriginImage(choice.url) ? <img src={sameOriginImage(choice.url)} alt={choice.label} loading="lazy" /> : <span className="agent-mention-placeholder">无图片</span>}
        <span><strong>当前图 {i + 1}</strong><small>{choice.missing ? '图片已不可用' : choice.label}</small></span>
      </button>)}
      {priorRounds.flatMap((round, r) => round.outputTaskIds.map((jobId, i) => {
        const job = current?.jobs.find(value => value.id === jobId);
        const url = job?.result_path ? sameOriginImage(mediaUrl(job.result_path)) : '';
        const available = Boolean(url && job && ['succeeded', 'accepted'].includes(job.status));
        const selected = draft.refs.some(choice => choice.reference.kind === 'job' && choice.reference.jobId === jobId);
        const label = `第 ${r + 1} 轮 · 图 ${i + 1}`;
        return <button className="agent-mention-choice" key={jobId} aria-label={`引用第 ${r + 1} 轮图 ${i + 1}`} disabled={disabled || !available || (!selected && draft.refs.length >= inputLimit)} onClick={() => mention(`@第${r + 1}轮图${i + 1}`, {reference:{kind:'job',jobId},url,label})}>
          {available ? <img src={url} alt={label} loading="lazy" /> : <span className="agent-mention-placeholder">无图片</span>}
          <span><strong>{label}</strong><small>{available ? round.prompt : statusText[job?.status || ''] || '图片已不可用'}</small></span>
        </button>;
      }))}
      {priorRounds.flatMap((round, r) => (round.taskImageIds || []).map((imageId, i) => {
        const image = current?.images.find(value => value.id === imageId);
        const url = sameOriginImage(image?.thumbnailUrl || image?.url);
        const available = image?.status === 'available' && Boolean(url);
        const label = `第 ${r + 1} 轮 · 编辑任务参考 ${i + 1}`;
        // Task images are appended after original attachments in the server's
        // frozen alias table; never turn them into retroactive user uploads.
        const alias = `round-${round.index}-reference-${round.inputImageIds.length + i + 1}`;
        return <button className="agent-mention-choice" key={`${round.id}:task:${imageId}`} aria-label={`引用第 ${r + 1} 轮编辑任务参考 ${i + 1}`} disabled={disabled || !available} onClick={() => mention(`<ref id="${alias}" />`)}>
          {available ? <img src={url} alt={label} loading="lazy" /> : <span className="agent-mention-placeholder">无图片</span>}
          <span><strong>{label}</strong><small>{available ? '沿用已保存的任务图片' : '图片已不可用'}</small></span>
        </button>;
      }))}
      {!draft.refs.length && !priorRounds.some(round => round.outputTaskIds.length || round.taskImageIds?.length) && <span>先添加图片，或等待生成结果。</span>}
    </>;
  }
  async function stop() {
    if (!current?.request || busy) return;
    setBusy(true);
    try { applySnapshot(await agentApi.stop(current.request.id)); onJobsChanged?.(); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }

  const renderResult = (job: GenerationJobRecord) => <ResultCard key={job.id} job={job} onReference={() => addResultReference(job)} referenceDisabled={draftLocked || uploading || handoffBusy || inFlight} preview={current?.images.find(image => image.id === (job.metadata?.agent as Record<string, unknown> | undefined)?.partialImageId)} onOpen={() => onOpenJob(job.id)} onSaved={() => { onLibraryChanged(); onJobsChanged?.(); if (current) void agentApi.conversation(current.conversation.id).then(applySnapshot).catch(() => {}); }} onError={setError} retry={config && current && ['succeeded', 'accepted', 'failed'].includes(job.status) ? <AgentImageRetryButton key={job.id} job={job} conversationId={current.conversation.id} config={config} selection={draft.imageConfig} params={draft.params} sizeMode={draft.sizeMode} disabled={draftLocked || uploading || handoffBusy || inFlight || !imageReady || incompatibleImageSelection} onReceipt={value => void retryAccepted(value, current.conversation.id)} /> : undefined} />;
  return <section className={`agent-workspace ${collapsed ? 'sidebar-collapsed' : ''}`} aria-label="Agent 创作工作区" hidden={!active}>
    <aside className="agent-conversations">
      <div className="agent-sidebar-head"><strong>创作会话</strong><button onClick={() => setCollapsed(true)} title="收起会话列表" aria-label="收起会话列表"><PanelLeftClose size={18} /></button></div>
      <button className="agent-new-conversation" aria-label="新建会话" disabled={busy} onClick={() => void newConversation()}><Plus size={17} />新建会话</button>
      <label className="agent-conversation-search"><Search size={16} /><input aria-label="搜索会话" placeholder="搜索标题、提问和回答" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} /></label>
      {searching && <p className="agent-help" role="status">读取会话列表…</p>}
      {searchError && <p className="agent-error" role="alert">{searchError}<button aria-label="重试读取会话" onClick={() => void refreshList()}>重试</button></p>}
      {search.trim() && searchStale && !searching && <button aria-label="刷新会话搜索结果" onClick={() => void refreshList()}>会话已更新，刷新搜索结果</button>}
      {!searching && !searchError && search.trim() && !conversations.length && <p className="agent-help">没有匹配的会话</p>}
      <nav aria-busy={searching}>{conversations.map(item => <div key={item.id} className={`agent-conversation-row ${item.id === activeId ? 'selected' : ''}`}>
        {renaming === item.id ? <form onSubmit={async event => { event.preventDefault(); try { const existing = await agentApi.conversation(item.id); const value = await agentApi.updateConversation(item.id, { expectedRevision: existing.revision, title: titleDraft }); applySnapshot(value); setRenaming(null); } catch (reason) { setError(errorText(reason)); } }}><input aria-label="会话名称" autoFocus value={titleDraft} onChange={event => setTitleDraft(event.target.value)} maxLength={200} /><button title="保存名称" aria-label="保存名称" type="submit"><Check size={15} /></button><button aria-label="取消重命名" type="button" onClick={() => setRenaming(null)}><X size={15} /></button></form> : <>
          <button className="agent-conversation-link" aria-label={`打开会话 ${item.title}`} onClick={() => { setActiveId(item.id); setDeleteTarget(null); }}><span>{item.runningRequestId ? <LoaderCircle size={15} className="spin" /> : <MessageSquare size={15} />}{item.title}</span><small>{item.roundCount} 轮 · {new Date(item.updatedAt).toLocaleDateString()}</small></button>
          <div className="agent-conversation-actions"><button title="重命名会话" aria-label={`重命名 ${item.title}`} onClick={() => { setRenaming(item.id); setTitleDraft(item.title); }}><Pencil size={14} /></button><button title="删除会话" aria-label={`删除 ${item.title}`} onClick={() => setDeleteTarget(item.id)}><Trash2 size={14} /></button></div>
        </>}
        {deleteTarget === item.id && <div className="agent-delete-confirm"><p>删除会话？画廊结果与 Library 资产会保留。</p><button aria-label="确认删除会话" onClick={async () => { try { await agentApi.deleteConversation(item.id); removeConversation(item.id); rememberImageMode(item.id, false); if (item.id === activeId) { setNewImageMode(false); setActiveId(null); setSnapshot(null); } setDeleteTarget(null); } catch (reason) { setError(errorText(reason)); } }}>确认删除</button><button aria-label="取消删除会话" onClick={() => setDeleteTarget(null)}>取消</button></div>}
      </div>)}</nav>
      {nextCursor && <button aria-label="加载更多会话" disabled={searching} onClick={() => void refreshList(nextCursor)}>加载更多会话</button>}
    </aside>
    <main className="agent-main">
      <header className="agent-workspace-head">
        <div>{collapsed && <button onClick={() => setCollapsed(false)} aria-label="展开会话列表"><PanelLeftOpen size={18} /></button>}
          <button className="agent-model-trigger" aria-label="当前模型与供应商" aria-haspopup="dialog" aria-expanded={panel === 'model'} onClick={event => openPanel('model', event.currentTarget)}><span>{config?.config.textModel || '选择模型'}</span><ChevronDown size={15} /></button>
        </div>
        <span className="agent-conversation-title" title={current?.conversation.title}>{current?.conversation.title || (activeId ? '读取会话' : '新对话')}</span>
      </header>
      <div className={`agent-messages${scrollbarActive ? ' is-scrolling' : ''}`} ref={scroll} role="region" aria-label="对话消息" tabIndex={0} onScroll={revealScrollbar}>
        <div className="agent-content-column" ref={scrollContent}>
        {(loading || conversationLoading) && !current && <p className="agent-center"><LoaderCircle className="spin" />读取会话…</p>}
        {conversationLoadError && <p className="agent-error" role="alert">会话读取失败：{conversationLoadError}。草稿和参考图已保留。<button aria-label="重试读取当前会话" disabled={conversationLoading} onClick={() => setConversationRetry(value => value + 1)}>重试</button></p>}
        {!loading && !conversationLoading && !conversationUnavailable && !rounds.length && <div className="agent-welcome"><MessageSquare size={34} /><h2>从一个想法开始</h2><p>讨论提示词，选入参考图，再按需要授权本轮生成。<br />文字讨论不会调用图片工具。</p><button aria-label="配置 Agent 调用路径" onClick={onOpenSettings}>配置 Agent 调用路径</button></div>}
        {rounds.map((round, roundIndex) => {
          const assistant = current!.conversation.messages.find(message => message.id === round.assistantMessageId || message.roundId === round.id && message.role === 'assistant');
          const siblings = getAgentSiblingRounds(current!.conversation, round);
          const branchIndex = siblings.findIndex(item => item.id === round.id);
          const blocks = getAgentAssistantBlocks(round, current!.jobs, assistant?.content || '');
          const summary = getAgentRoundSummary(round, current!.jobs, current!.request);
          const outcome = getAgentRoundStatus(round, summary);
          const showOutcome = summary.imageJobsCreated > 0 || summary.outcomeUnknown || Boolean(round.error) || round.status === 'running' || ['stopped', 'stop_requested', 'failed', 'interrupted'].includes(summary.requestState);
          const imageTools = blocks.filter(block => block.type === 'tool' && ['generate_image', 'generate_image_batch', 'image_generation'].includes(block.name));
          return <article className="agent-round" data-agent-round={round.id} key={round.id}>
            <div className="agent-user-message" aria-label={`你，第 ${roundIndex + 1} 轮`}>{round.inputImageIds.length > 0 && <div className="agent-reference-strip">{round.inputImageIds.map((id, i) => { const image = current!.images.find(image => image.id === id); const url = sameOriginImage(image?.thumbnailUrl || image?.url); return <div key={id} title={`参考图 ${i + 1}`}>{image?.status === 'available' && url ? <a href={sameOriginImage(image.url)} target="_blank" rel="noreferrer"><img src={url} alt={`参考图 ${i + 1}`} /></a> : <span>图片缺失</span>}<small>{i + 1}</small></div>; })}</div>}<p className="agent-original-text">{round.prompt}</p>
              <div className="agent-message-actions"><button title="复制原文" aria-label="复制原文" onClick={() => void copyTextToClipboard(round.prompt).then(ok => setNotice(ok ? '已复制原文' : '复制失败'))}><Copy size={15} /></button><button title="编辑重发" aria-label="编辑重发" disabled={inFlight || busy || Boolean(uncertain)} onClick={() => void prepareEdit(round, 'edit')}><Pencil size={15} /></button>{siblings.length > 1 && <span className="agent-branch-controls"><button aria-label="上一分支" disabled={branchIndex === 0 || busy} onClick={() => void selectBranch(siblings[branchIndex - 1].id)}><ChevronLeft size={15} /></button>{branchIndex + 1} / {siblings.length}<button aria-label="下一分支" disabled={branchIndex === siblings.length - 1 || busy} onClick={() => void selectBranch(siblings[branchIndex + 1].id)}><ChevronRight size={15} /></button></span>}</div>
            </div>
            <div className="agent-assistant-message" aria-label={`Agent，第 ${roundIndex + 1} 轮`}>
              {blocks.map(block => {
                if (block.type === 'text') return <AgentMarkdown key={block.key} text={block.content} />;
                if (block.type === 'image-task') return renderResult(block.task);
                if (block.type === 'deleted-image-task') return <p key={block.key} className="agent-missing-image">原图片任务已不可用，保留引用位置。</p>;
                const label = agentPhaseLabels[block.state || ''] || statusText[block.state || ''] || (block.state === 'in_progress' ? '进行中' : '工具调用');
                // One aggregate already expresses this tool's complete outcome.
                // Multiple tools keep their own states, which can legitimately differ.
                const repeated = showOutcome && imageTools.length === 1 && imageTools[0] === block && (outcome === label || outcome.startsWith(`${label}，`));
                return <div key={block.key} className="agent-tool-status"><span>{getAgentToolLabel(block.name)}</span>{!repeated && <small>{label}</small>}</div>;
              })}
              {showOutcome && <p className="agent-round-outcome" role="status">{outcome}</p>}
              {Boolean(round.retryTaskIds?.length) && <section className="agent-retry-results" aria-label="本轮图片的重试结果"><h4>重试结果</h4>{round.retryTaskIds!.map(id => { const job = current!.jobs.find(row => row.id === id); return job ? renderResult(job) : <p key={id} className="agent-missing-image">重试任务记录不可用。</p>; })}</section>}
              <div className="agent-answer-actions">
                {assistant?.content && <button className="agent-text-button" aria-label="复制回答" title="复制回答" onClick={() => void copyTextToClipboard(assistant.content).then(ok => setNotice(ok ? '已复制回答' : '复制失败'))}><Copy size={15} /></button>}
                {!round.outputTaskIds.length && !round.retryTaskIds?.length && <button className="agent-text-button" aria-label="重试回答" title="重试回答，保留当前草稿" disabled={inFlight || busy || Boolean(uncertain) || uploading || handoffBusy} onClick={() => void retryText(round)}><RotateCcw size={15} /></button>}
                <button className="agent-text-button agent-answer-details" title="查看回答详情" aria-label={`查看第 ${roundIndex + 1} 轮详情`} aria-haspopup="dialog" aria-expanded={panel === 'details' && detailRoundId === round.id} onClick={event => openPanel('details', event.currentTarget, round.id)}><Info size={15} /></button>
              </div>
            </div>
          </article>;
        })}
        {current?.request && requestNeedsAttention && (current.request.upstreamMayContinue || current.request.canResume) && <div className="agent-request-attention" role="alert">{current.request.upstreamMayContinue && <p>已发送的上游请求可能仍在执行或计费；请先检查原请求，不会自动重复提交。</p>}{current.request.canResume && <button aria-label="继续已确认安全的步骤" disabled={busy} onClick={async () => { setBusy(true); try { applySnapshot(await agentApi.resume(current.request!.id, getAgentResumeId(localStorage, [current.request!.id, current.request!.usage.responseStepsStarted, current.request!.usage.imageJobsCreated].join(':'), () => crypto.randomUUID()))); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); } }}>继续已确认安全的步骤</button>}</div>}
      </div>
      </div>
      <div className="agent-scroll-anchor">
        <button className="agent-scroll-bottom" aria-label="滚动到最新消息" onClick={() => scrollToLatest()}><ArrowDown size={16} /></button>
      </div>
      <div className="agent-input-area">
        <div className="agent-content-column">
        {notice && <p role="status" className="agent-notice">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={13} /></button></p>}
        {error && <p role="alert" className="agent-error">{error}<button aria-label="关闭错误" onClick={() => setError('')}><X size={13} /></button></p>}
        {uncertain && <div className="agent-uncertain"><strong>上次提交结果尚未确认</strong><p>冻结的内容与请求 ID 已保留，重载不会自动重新收费提交。</p><button aria-label="检查原请求状态" disabled={busy} onClick={() => void reconcile(uncertain)}>检查原请求状态</button><button aria-label="用同一请求恢复" disabled={busy} onClick={() => void reconcile(uncertain, true)}>用同一请求恢复</button></div>}
        {config && !config.ready && <p className="agent-help">{config.issues.map(issue => issue.message).join('；')} <button className="agent-text-button" aria-label="打开 Agent 设置" onClick={onOpenSettings}>打开设置</button></p>}
        {draft.editId && <div className="agent-edit-notice">{draft.origin === 'regenerate' ? '重新生成' : '编辑重发'}会建立新分支，原记录保留。<button aria-label="取消分支编辑" disabled={draftLocked} onClick={() => updateDraft({ editId: null, origin: 'send' })}>取消分支编辑</button></div>}
        <div className="agent-composer" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)); }}>
          {draft.refs.length > 0 && <div className="agent-reference-strip">{draft.refs.map((choice, index) => <div key={referenceKey(choice.reference)} className={choice.missing ? 'missing' : ''}>{choice.url ? <img src={sameOriginImage(choice.url)} alt={choice.label} /> : <span>{choice.missing ? '图片缺失' : '已选择图片'}</span>}<button title="插入图片引用" aria-label={`插入图片 ${index + 1} 引用`} disabled={draftLocked} onClick={() => mention(`@图${index + 1}`)}>{index + 1}</button><button className="agent-remove-ref" title="移除参考图" aria-label={`移除参考图 ${index + 1}`} disabled={draftLocked} onClick={() => updateDraft({ refs: draft.refs.filter((_, i) => i !== index) })}><X size={12} /></button></div>)}</div>}
          <textarea ref={textarea} aria-label="Agent 消息" placeholder="输入想法、提示词或修改要求；输入 @ 引用图片" value={draft.text} disabled={draftLocked} aria-busy={busy} readOnly={draft.origin === 'regenerate'} rows={1} onChange={event => { updateDraft({ text: event.target.value }); setInlineMentions(event.target.value.slice(0, event.target.selectionStart).endsWith('@')); }} onKeyDown={event => { if (event.key === 'Escape' && inlineMentions && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); setInlineMentions(false); return; } if (shouldSubmitAgentOnKey({ ...event, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, readAgentInputPreferences().enterSubmit)) { event.preventDefault(); void submit(); } }} onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void addFiles(files); } }} />
          {inlineMentions && <div className="agent-inline-mentions" aria-label="图片引用建议" onMouseDown={event => event.preventDefault()}>{mentionChoices()}</div>}
          <div className="agent-composer-toolbar">
            <div><button className="agent-add-trigger" aria-label="添加图片或引用" title="添加图片或引用" disabled={draftLocked} aria-haspopup="dialog" aria-expanded={panel === 'add'} onClick={event => openPanel('add', event.currentTarget)}><Plus size={20} /></button><button className="agent-options-trigger" aria-label="生图设置" aria-haspopup="dialog" aria-expanded={panel === 'options'} onClick={event => openPanel('options', event.currentTarget)}><SlidersHorizontal size={17} /><span>生图设置</span></button>{uploading && <LoaderCircle size={17} className="spin" aria-label="正在上传图片" />}</div>
            <button type="button" className="agent-image-mode" aria-label="持续生图模式" aria-pressed={imageMode} disabled={draftLocked || (!imageMode && !imageReady)} title={imageMode ? '已为本会话开启，刷新后保留；关闭后只进行对话和提示词创作' : '已关闭：只进行对话和提示词创作；开启后为本会话记住选择'} onClick={() => { if (activeId) rememberImageMode(activeId, !imageMode); else setNewImageMode(!imageMode); setRequestAuthorization('images', false); }}><ImagePlus size={16} />{imageMode ? '生图模式 · 开' : '生图模式 · 关'}</button>
            <span className="agent-reference-count">{draft.refs.length > 0 ? `${draft.refs.length} / ${inputLimit} 张参考` : ''}</span>
            <button className="agent-send" title={inFlight ? '停止后续调用' : '发送本轮'} aria-label={inFlight ? '停止后续调用' : '发送 Agent 消息'} disabled={inFlight ? busy : busy || handoffBusy || uploading || conversationUnavailable || !draft.text.trim() || Boolean(uncertain) || !config || (!config.ready && config.config.apiConfigMode !== 'off')} onClick={() => void (inFlight ? stop() : submit())}>{busy ? <LoaderCircle className="spin" size={18} /> : inFlight ? <Square size={17} /> : <ArrowUp size={19} />}</button>
          </div>
          {allowWebSearch && <div className="agent-authorization-chips"><button aria-label="取消本轮搜索授权" disabled={inFlight || draftLocked} onClick={() => setRequestAuthorization('search', false)}><Search size={13} />网络搜索<X size={12} /></button></div>}
        </div>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden disabled={draftLocked} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void addFiles(files); }} />
        <p className="agent-input-hint">{inputPreferences.enterSubmit ? 'Enter 发送，Shift+Enter 换行' : 'Ctrl+Enter 发送，Enter 换行'}</p>
        </div>
      </div>
    </main>
    {active && panel && createPortal(<div className="agent-popover-layer" onMouseDown={event => { if (event.target === event.currentTarget) closePanel(); }}>
      <div id="agent-chat-panel" className={`agent-chat-panel agent-panel-${panel}`} style={panelPosition} role="dialog" aria-modal="true" aria-label={panel === 'model' ? '模型与供应商' : panel === 'add' ? '添加图片或引用' : panel === 'options' ? '生图设置' : panel === 'mentions' ? '引用图片' : '回答详情'} ref={panelRef} tabIndex={-1} onKeyDown={handleModalKeyDown}>
        <header><strong>{panel === 'model' ? '模型与供应商' : panel === 'add' ? '添加' : panel === 'options' ? '生图设置' : panel === 'mentions' ? '引用图片' : '回答详情'}</strong><button data-agent-panel-close aria-label="关闭 Agent 面板" onClick={closePanel}><X size={17} /></button></header>
        {panel === 'model' && <div className="agent-model-panel-content"><dl><dt>当前模型</dt><dd>{config?.config.textModel || '未设置模型'}</dd><dt>供应商</dt><dd>{currentProfile?.display_name || '未选择供应商'}</dd><dt>调用方式</dt><dd>{config?.config.apiConfigMode === 'hybrid' ? '混合工具模式' : config?.config.apiConfigMode === 'native' ? 'Responses 原生模式' : '跟随当前 API 配置'}</dd></dl>{config?.config.apiConfigMode === 'off' && <label className="agent-profile-select">本轮 API 配置<select aria-label="本轮 API 配置" disabled={draftLocked} value={activeProfileId} onChange={event => setActiveProfileId(event.target.value)}><option value="">选择配置</option>{config.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}</select></label>}<button className="agent-panel-action" aria-label="修改 Agent 模型配置" onClick={openSettings}>修改模型配置</button></div>}
        {panel === 'add' && <div className="agent-add-actions"><button aria-label="上传图片文件" title="上传图片文件" disabled={draftLocked || uploading || draft.refs.length >= inputLimit} onClick={() => { closePanel(); fileInput.current?.click(); }}><Plus size={18} />上传图片</button><button aria-label="从 Library 或画廊选择图片" title="从 Library 或画廊选择图片" disabled={draftLocked || uploading || draft.refs.length >= inputLimit} onClick={() => { closePanel(); setPicker(true); }}><ImagePlus size={18} />从 Library / 画廊选择</button><button aria-label="引用已有图片" disabled={draftLocked} onClick={() => { panelRef.current?.querySelector<HTMLButtonElement>('[data-agent-panel-close]')?.focus({ preventScroll: true }); setPanel('mentions'); }}>＠ 引用已有图片</button><p className="agent-help">也可直接拖入或粘贴图片。</p></div>}
        {panel === 'mentions' && <div className="agent-mention-menu">{mentionChoices()}</div>}
        {panel === 'options' && <div className="agent-options-content">
        {config?.config.webSearch && config.capabilities.webSearch && <label className="agent-authorization"><input type="checkbox" aria-label="本轮允许网络搜索" checked={allowWebSearch} disabled={inFlight || draftLocked} onChange={event => setRequestAuthorization('search', event.target.checked)} />本轮允许网络搜索</label>}
        {config?.config.apiConfigMode === 'hybrid' && !imageReady && <p className="agent-help">图片调用暂不可用：{config.imageIssues.map(issue => issue.message).join('；')}。文字讨论仍可使用。<button className="agent-text-button" aria-label="检查图片配置" onClick={openSettings}>检查图片配置</button></p>}
        {config?.config.apiConfigMode === 'off' && <label className="agent-profile-select">本轮 API 配置<select aria-label="本轮 API 配置" disabled={draftLocked} value={activeProfileId} onChange={event => setActiveProfileId(event.target.value)}><option value="">选择配置</option>{config.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}</select></label>}
        {incompatibleImageSelection && <p className="agent-error" role="alert">生图方式已改变，请恢复 Agent 默认模型或重新选择生图模型后发送。草稿和附件保持不变。</p>}
        {config && <AgentImageOptions config={config} activeProfileId={activeProfileId} selection={draft.imageConfig} params={draft.params} sizeMode={draft.sizeMode} count={imageCount} shared={sharedImages} sharedUnavailable={sharedUnavailable} disabled={draftLocked} onChange={updateImageSettings} onChooseSize={() => {closePanel();setSizeOpen(true);}} />}

          <p className="agent-help">{imageMode ? '生图模式已开启，本会话后续发送持续允许生图；可在输入框关闭。网络搜索仍仅授权本轮。' : '生图模式关闭时只进行对话与提示词创作；在输入框开启后可通过对话指挥生图。'}只有发送后才调用接口，可能产生费用。</p>
        </div>}
        {panel === 'details' && detailRound && <AgentResponseDetails details={detailRound.responseDetails} modelInfo={detailRound.modelInfo} request={detailRequest} round={detailRound} jobs={current?.jobs || []} terminalObservationMs={terminalObservations[detailRound.requestId]} />}
      </div>
    </div>, document.body)}
    {active && sizeOpen && <SizeDialog recipe={{...draft.params,model:imageModel,background:draft.params.background || 'auto',output_compression:draft.params.output_compression ?? undefined,moderation:draft.params.moderation === 'low' || draft.params.moderation === 'auto' ? draft.params.moderation : undefined,size_mode:draft.sizeMode}} prompt={draft.text} referenceSize={measuredReferenceSize} referenceStatus={sizeReferenceStatus} onClose={() => setSizeOpen(false)} onApply={selection => updateImageSettings({params:{...draft.params,size:selection.size},sizeMode:selection.size_mode})} />}
    {picker && <AgentReferencePicker remaining={Math.max(0, inputLimit - draft.refs.length)} onClose={() => setPicker(false)} onSelect={choices => updateDraft({ refs: [...draft.refs, ...choices.filter(choice => !draft.refs.some(existing => referenceKey(existing.reference) === referenceKey(choice.reference)))] })} />}
  </section>;
}
