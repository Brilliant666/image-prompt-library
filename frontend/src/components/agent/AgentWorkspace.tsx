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
import { useAgentRunState, type AgentSubmissionBoundary } from './useAgentRunState';
import { api, mediaUrl } from '../../api/client';
import { AgentApiError, agentApi, getAgentConfig, type AgentConfigResponse, type AgentImage, type AgentImageRetryReceipt, type AgentRound, type AgentRoundCreate, type AgentSnapshot, type AgentTaskContextOperation, type AgentPromptExecutionInput } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';
import { getActiveAgentRounds, getAgentBranchLeafId, getAgentSiblingRounds } from '../../utils/playground/agentConversationState';
import { agentPhaseLabels, getAgentAssistantBlocks, getAgentJobFailure, getAgentRoundStatus, getAgentRoundSummary, getAgentToolLabel, isAgentRequestActive } from '../../utils/playground/agentAssistantBlocks';
import { insertMention, referenceKey, resolveAgentPromptImageReferences, type ReferenceChoice } from '../../utils/playground/agentImageReferences';
import { AGENT_DRAFT_KEY, AGENT_IMAGE_MODE_PREFIX, AGENT_PROMPT_EXECUTIONS_KEY, acknowledgeAgentDraft, clearPendingPromptExecution, draftFromPendingAgentSubmission, readAgentDrafts, readAgentImageMode, readPendingAgentSubmissions, readPendingPromptExecutions, saveAgentImageMode, savePendingPromptExecution, shouldSubmitAgentOnKey, type AgentDraft, type PendingAgentSubmission, type PendingPromptExecution } from '../../utils/playground/agentSubmission';
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
const taskTypeText: Record<string, string> = { chat: '连续对话', image_edit: '图片编辑', image_generation: '图片生成', prompt: '提示词创作', analysis: '图片分析', reverse: '提示词反推', prompt_optimization: '提示词优化' };
const taskHistoryReasonText: Record<string, string> = { legacy_context_missing: '旧会话缺少已确认的完整任务资料', legacy_requirements_in_history: '旧任务的完整要求仍保存在历史消息中', target_changed_requires_prior_evidence: '新增目标与旧图片、旧约束的关系尚待确认', unreconciled_user_addition: '历史补充尚未完整整理到当前任务' };
const referenceRoleText: Record<string, string> = { target: '主要图片', lighting: '辅助 · 光线', style: '辅助 · 风格', subject: '辅助 · 主体', composition: '辅助 · 构图', other: '辅助 · 其他' };
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
  const [preferences, setPreferences] = useState(readLocalPreferences);
  const [inputPreferences, setInputPreferences] = useState(readAgentInputPreferences);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const restored = readAgentDrafts(localStorage, readLocalPreferences().persistInputOnRestart);
    for (const entry of readPendingAgentSubmissions(localStorage)) if (!entry.preserveDraft) restored[entry.conversationId] = draftFromPendingAgentSubmission(entry, restored[entry.conversationId]);
    return restored;
  });
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [referenceGeometry, setReferenceGeometry] = useState<{url:string;size?:{width:number;height:number};status:'loading'|'ready'|'error'}>();
  const [directGeometry, setDirectGeometry] = useState<{url:string;size?:{width:number;height:number};status:'loading'|'ready'|'error'}>();
  const [promptExecutions, setPromptExecutions] = useState(() => readPendingPromptExecutions(localStorage));
  const promptExecutionAlive = useRef(true);
  const directPostLock = useRef(false);
  const checkedPromptExecutions = useRef(new Set<string>());
  const [focusRoundId, setFocusRoundId] = useState<string>();
  const consumedHandoff = useRef<number | undefined>(undefined);
  const [search, setSearch] = useState('');
  const { rows: conversations, nextCursor, loading: searching, error: searchError, stale: searchStale, refresh: refreshList, upsert: upsertConversation, remove: removeConversation } = useAgentConversations(active, search);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 760);
  const [picker, setPicker] = useState(false);
  const [targetPicker, setTargetPicker] = useState(false);
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
  const draftRevisions = useRef<Record<string, number>>({});
  const authorizationRevision = useRef({ images: 0, search: 0 });
  const settingsHandoff = useRef(false);
  const { activeId, activeIdRef, setActiveId, current, pending, busy, error, setError, notice, setNotice,
    conversationLoading, conversationLoadError, reloadConversation, inFlight, terminalObservations,
    applySnapshot, runCommand, submitPrepared, reconcile, stop, resume, newConversation } = useAgentRunState({
      active, useStream: config?.capabilities.progressTransport === 'sse', onSummary: upsertConversation,
      onJobsChanged, onAccepted: acknowledgeSubmission, onSelection: () => setAllowWebSearch(false),
    });
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draftKey = activeId || 'new';
  const imageMode = activeId ? (Object.hasOwn(imageModes, activeId) ? imageModes[activeId] : readAgentImageMode(localStorage, activeId)) : newImageMode;
  const imagesAllowed = imageMode;
  const uncertain = pending.find(entry => entry.conversationId === activeId);
  const pendingPromptExecution = promptExecutions.find(entry => entry.conversationId === activeId);
  const workspaceSnapshot = useRef(current); workspaceSnapshot.current = current;
  const storedDraft = drafts[draftKey] || emptyDraft();
  const sharedImages = config?.config.apiConfigMode === 'hybrid';
  const sharedUnavailable = sharedImages && galleryImageSettings ? galleryImageSettings.unavailable || (galleryImageSettings.provider !== 'openai_compatible' ? '画廊当前供应商不支持 Agent 的 Images API 调用，请选择 API 供应商。' : '') : undefined;
  // Shared pending choices never replace a submitted request or composer text/images.
  const draft = sharedImages && galleryImageSettings && (!uncertain || uncertain.preserveDraft) ? { ...storedDraft, params: galleryImageSettings.params, sizeMode: galleryImageSettings.sizeMode, imageConfig: { profileId: galleryImageSettings.profileId, model: galleryImageSettings.model } } : storedDraft;
  const imageCount = sharedImages ? sharedImageCount(galleryImageSettings?.count) : nativeImageCount;
  const scrollToLatest = useAgentScroll({ containerRef: scroll, contentRef: scrollContent, active, conversationId: activeId, ready: Boolean(current) && !conversationLoading && !conversationLoadError, revision: current?.revision, focusRoundId, onFocusResolved: () => setFocusRoundId(undefined) });
  const conversationUnavailable = Boolean(activeId && !current);
  const rounds = useMemo(() => current ? getActiveAgentRounds(current.conversation) : [], [current]);
  const draftLocked = busy || Boolean(uncertain || pendingPromptExecution);
  const inputLimit = config?.capabilities.maxInputImages ?? 4;
  const imageProfile = config?.profiles.find(profile => profile.id === (config.config.apiConfigMode === 'hybrid' ? draft.imageConfig?.profileId || config.config.imageProfileId : config.config.apiConfigMode === 'off' ? activeProfileId : config.config.textProfileId));
  const imageModel = draft.imageConfig ? draft.imageConfig.model || (config?.config.apiConfigMode === 'hybrid' ? imageProfile?.model : '') || '' : config?.config.imageModel || (config?.config.apiConfigMode === 'hybrid' ? imageProfile?.model : '') || '';
  const incompatibleImageSelection = Boolean(config && config.config.apiConfigMode !== 'hybrid' && draft.imageConfig?.profileId);
  const imageReady = !sharedUnavailable && (config?.config.apiConfigMode !== 'hybrid' || (draft.imageConfig ? Boolean(imageProfile?.configured && imageModel.trim()) : Boolean(config.imageReady)));
  const currentProfile = config?.profiles.find(profile => profile.id === (config.config.apiConfigMode === 'off' ? activeProfileId : config.config.textProfileId));
  const detailRound = current?.conversation.rounds.find(round => round.id === detailRoundId);
  const detailRequest = current?.request?.id === detailRound?.requestId ? current?.request : null;
  const taskContext = current?.taskContext;
  const contextScope = draft.contextScope || 'task';
  const selectedHistory = draft.historyRoundIds || [];
  const selectedPrompt = taskContext?.promptVersions.find(version => version.id === taskContext.selectedPromptVersionId);
  const promptVersionIndex = selectedPrompt ? taskContext!.promptVersions.indexOf(selectedPrompt) + 1 : 0;
  const promptSourceRoundId = selectedPrompt?.source.roundId;
  const promptSourceRound = promptSourceRoundId ? current?.conversation.rounds.find(round => round.id === promptSourceRoundId) : undefined;
  const promptSourceActiveIndex = rounds.findIndex(round => round.id === promptSourceRoundId);
  const promptSourceLocation = !promptSourceRoundId ? '' : !promptSourceRound ? '历史来源不可定位'
    : promptSourceActiveIndex >= 0 ? `第 ${promptSourceActiveIndex + 1} 轮`
      : Number.isSafeInteger(promptSourceRound.index) && promptSourceRound.index > 0 ? `历史分支第 ${promptSourceRound.index} 轮` : '历史来源不可定位';
  const replacingTaskTarget = !taskContext?.targetExplicit && draft.refs.length === 1 && taskContext?.target && referenceKey(draft.refs[0].reference) !== referenceKey(taskContext.target.source);
  const taskImages = [taskContext?.target, ...(taskContext?.auxiliaries || [])].filter((value): value is NonNullable<typeof value> => Boolean(value));
  const previewRefs = resolveAgentPromptImageReferences(draft.text, rounds, new Set((current?.jobs || []).filter(job => job.result_path && ['succeeded', 'accepted'].includes(job.status)).map(job => job.id)), draft.refs.map(choice => choice.reference)).refs;
  const taskHistoryHasImages = taskContext?.taskType === 'chat' && rounds.some(round => round.taskContext?.taskId === taskContext.taskId && (round.inputImageIds.length || round.taskImageIds?.length || round.outputTaskIds.length || round.retryTaskIds?.length));
  const unassignedDraftImages = taskContext?.targetExplicit && draft.refs.some(choice => !taskImages.some(image => referenceKey(image.source) === referenceKey(choice.reference)));
  const promptHasStoredImages = taskContext && ['prompt', 'prompt_optimization'].includes(taskContext.taskType) && taskImages.length > 0;
  // This list is a local preview, not a second implementation of the server's
  // context planner. Incomplete/legacy evidence and numeric history references
  // can carry additional pixels; expose conservative branch candidates rather
  // than promising a count that only the actual provider projection can know.
  const previewNeedsHistory = Boolean(rounds.length && (!taskContext || taskContext.completeness !== 'complete' || replacingTaskTarget || unassignedDraftImages || taskHistoryHasImages || /第\s*\d+\s*轮/.test(draft.text)));
  const previewUncertain = contextScope === 'branch' || previewNeedsHistory || Boolean(promptHasStoredImages);
  const scopedRounds = contextScope === 'branch' || previewNeedsHistory ? rounds : contextScope === 'selected' ? rounds.filter(round => selectedHistory.includes(round.id)) : [];
  const imagePreview = new Map<string, { reference: ReferenceChoice['reference']; label: string; url: string; missing: boolean }>();
  for (const image of taskImages) {
    const asset = current?.images.find(value => value.id === image.assetId || referenceKey(value.source) === referenceKey(image.source));
    imagePreview.set(referenceKey(image.source), { reference: image.source, label: image === taskContext?.target ? replacingTaskTarget ? '旧目标图片 · 任务证据候选' : '当前任务主要图片' : replacingTaskTarget ? '旧辅助图片 · 任务证据候选' : '当前任务辅助图片', url: sameOriginImage(asset?.thumbnailUrl || asset?.url), missing: asset?.status !== 'available' });
  }
  for (const round of scopedRounds) for (const id of [...round.inputImageIds, ...(round.taskImageIds || [])]) {
    const asset = current?.images.find(image => image.id === id);
    if (asset && !imagePreview.has(referenceKey(asset.source))) imagePreview.set(referenceKey(asset.source), { reference: asset.source, label: `第 ${round.index} 轮参考图${previewUncertain ? ' · 历史候选' : ''}`, url: sameOriginImage(asset.thumbnailUrl || asset.url), missing: asset.status !== 'available' });
  }
  for (const round of scopedRounds) for (const id of [...round.outputTaskIds, ...(round.retryTaskIds || [])]) {
    const job = current?.jobs.find(value => value.id === id);
    if (job?.result_path && ['succeeded', 'accepted'].includes(job.status)) imagePreview.set(`job:${id}`, { reference: { kind: 'job', jobId: id }, label: `第 ${round.index} 轮结果图`, url: sameOriginImage(mediaUrl(job.result_path)), missing: false });
  }
  for (const reference of previewRefs) {
    const choice = draft.refs.find(value => referenceKey(value.reference) === referenceKey(reference));
    const asset = current?.images.find(value => referenceKey(value.source) === referenceKey(reference));
    const job = reference.kind === 'job' ? current?.jobs.find(value => value.id === reference.jobId) : undefined;
    imagePreview.set(referenceKey(reference), { reference, label: choice?.label || '已引用的结果图', url: sameOriginImage(choice?.url || asset?.thumbnailUrl || asset?.url || (job?.result_path ? mediaUrl(job.result_path) : '')), missing: Boolean(choice?.missing || asset && asset.status !== 'available') });
  }
  const mainImageReference = taskContext?.targetExplicit ? taskContext.target?.source : draft.refs.length === 1 ? draft.refs[0].reference : taskContext?.target?.source;
  const directImages = [taskContext?.target ? { ...taskContext.target, role: 'target' } : null, ...(taskContext?.auxiliaries || [])].filter((image): image is NonNullable<typeof image> => Boolean(image));
  const directTarget = directImages[0] ? current?.images.find(image => image.id === directImages[0].assetId) : undefined;
  const directTargetUrl = sameOriginImage(directTarget?.thumbnailUrl || directTarget?.url);
  const directReferenceSize = directTarget?.width && directTarget.height ? { width: directTarget.width, height: directTarget.height } : directGeometry?.url === directTargetUrl ? directGeometry.size : undefined;
  const directAutoSize = draft.sizeMode === 'auto4k' && selectedPrompt ? resolveAuto4k(selectedPrompt.text, directReferenceSize) : null;
  const directSizeUnavailable = Boolean(directAutoSize && !('error' in directAutoSize) && directAutoSize.source !== 'prompt' && directImages.length && !directReferenceSize);
  const directParams = directAutoSize && !('error' in directAutoSize) && !directSizeUnavailable ? { ...draft.params, size: directAutoSize.size } : draft.params;
  const directHybrid = config?.config.apiConfigMode === 'hybrid';
  const directProfileId = directHybrid ? draft.imageConfig?.profileId ?? config?.config.imageProfileId : null;
  const directModel = draft.imageConfig ? draft.imageConfig.model : config?.config.imageModel || (directHybrid ? config?.profiles.find(profile => profile.id === directProfileId)?.model : '') || '';
  const directModelLabel = directModel.trim() || (directHybrid ? config?.profiles.find(profile => profile.id === directProfileId)?.model : '') || '供应商默认图片模型';
  const directHardHistory = taskContext?.historyDependencies.filter(item => item.reason !== 'unreconciled_user_addition').map(item => taskHistoryReasonText[item.reason] || item.reason) || [];
  const directMask = current?.conversation.rounds.find(round => round.id === current.conversation.activeRoundId)?.maskImageId;
  const directUnavailable = !selectedPrompt ? '请先明确选择提示词。' : !config ? '正在读取图片调用设置。' : config.config.apiConfigMode === 'off' ? 'Current API 尚无已验证的直接执行路径；可保留普通会话生图，或在设置中主动选择 Native / Hybrid。' : taskContext?.unresolvedItems.length || taskContext?.taskType === 'image_edit' && !taskContext.target ? '当前任务仍有待确认项或图片角色未明确，请先完成确认。' : directHardHistory.length ? `任务仍需核对必要历史证据：${directHardHistory.join('；')}。` : directMask ? '直接执行暂不支持带蒙版配方，请使用原编辑流程。' : directImages.length > 4 || new Set(directImages.map(image => image.assetId)).size !== directImages.length ? '配方图片角色重复或数量过多，请先明确选择。' : directImages.some(image => current?.images.find(asset => asset.id === image.assetId)?.status !== 'available') ? '配方参考图不可用，请先恢复或重新选择。' : incompatibleImageSelection || !imageReady ? '请先完善本次生图模型与供应商设置。' : imageCount > config.config.maxImageJobs ? '本次数量超出 Agent 已配置的图片安全上限。' : directAutoSize && 'error' in directAutoSize ? '选定提示词包含冲突比例，请设置明确尺寸。' : directSizeUnavailable ? directGeometry?.status === 'error' ? '无法读取主要图片尺寸，请重选图片或设置明确尺寸。' : '正在确认主要图片尺寸，暂不能直接生成。' : '';
  const requestNeedsAttention = Boolean(current?.request && (['failed', 'unknown', 'interrupted'].includes(current.request.state) || current.request.error || current.request.recoveryReason || current.request.upstreamMayContinue || current.request.canResume));
  const closePanel = useCallback(() => setPanel(null), []);
  useEffect(() => { if (activeId) setNewImageMode(false); }, [activeId]);
  useEffect(() => { promptExecutionAlive.current = true; return () => { promptExecutionAlive.current = false; }; }, []);
  useEffect(() => {
    if (!active || draft.sizeMode !== 'auto4k' || !directTarget || directTarget.width && directTarget.height) return;
    let disposed = false;
    setDirectGeometry({ url: directTargetUrl, status: 'loading' });
    if (!directTargetUrl) { setDirectGeometry({ url: directTargetUrl, status: 'error' }); return; }
    const image = new Image(); image.src = directTargetUrl;
    void image.decode().then(() => { if (!disposed) setDirectGeometry({ url: directTargetUrl, size: { width: image.naturalWidth, height: image.naturalHeight }, status: 'ready' }); }).catch(() => { if (!disposed) setDirectGeometry({ url: directTargetUrl, status: 'error' }); });
    return () => { disposed = true; };
  }, [active, draft.sizeMode, directTarget?.id, directTarget?.sha256, directTargetUrl]);
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key !== null && event.key !== AGENT_PROMPT_EXECUTIONS_KEY) return;
      setPromptExecutions(readPendingPromptExecutions(localStorage));
      if (activeIdRef.current) reloadConversation();
    };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [reloadConversation]);
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
      if (target) { setActiveId(target.conversation.id); applySnapshot(target); setFocusRoundId(roundId); }
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
  function acknowledgeSubmission(entry: PendingAgentSubmission, boundary: AgentSubmissionBoundary) {
    acknowledgeDraft(entry.conversationId, boundary.draft);
    acknowledgeAuthorization(entry.conversationId, boundary.authorization);
  }
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

  function rememberImageMode(conversationId: string, enabled: boolean) {
    setImageModes(old => ({ ...old, [conversationId]: enabled }));
    try { saveAgentImageMode(localStorage, conversationId, enabled); }
    catch { setError(`当前生图模式已${enabled ? '开启' : '关闭'}，但浏览器无法保存此选择；刷新后请检查开关状态。`); }
  }
  async function selectBranch(id: string) {
    if (!current || busy) return;
    await runCommand(async command => {
      const value = await agentApi.updateConversation(current.conversation.id, { expectedRevision: current.revision, activeRoundId: getAgentBranchLeafId(current.conversation, id) });
      if (command.current()) { applySnapshot(value); updateDraft({ editId: null, origin: 'send' }); }
    });
  }
  async function changeTaskContext(operations: AgentTaskContextOperation[]) {
    if (activeIdRef.current !== activeId || draftLocked || inFlight || uploading || handoffBusy || conversationUnavailable) return;
    const expected = current;
    await runCommand(async command => {
      let value = expected;
      if (!value) {
        const originalRevision = draftRevisions.current[draftKey] || 0;
        value = await command.createConversation();
        if (!value) return;
        const destination = value.conversation.id;
        if (newImageMode) rememberImageMode(destination, true);
        setNewImageMode(false);
        draftRevisions.current[destination] = originalRevision;
        setDrafts(old => {
          const next = { ...old, [destination]: old[draftKey] || draft };
          if ((draftRevisions.current[draftKey] || 0) === originalRevision) delete next.new;
          return next;
        });
      }
      if (!command.current()) return;
      try {
        const updated = await agentApi.updateTaskContext(value.conversation.id, {
          expectedRevision: value.revision, branchRoundId: value.conversation.activeRoundId || null,
          taskRevision: value.taskContext?.revision ?? null, operations,
        });
        if (command.current()) { applySnapshot(updated); setNotice('当前任务已更新；输入框草稿和附件保留，尚未发送。'); }
      } catch (reason) {
        if (reason instanceof AgentApiError && reason.status === 409 && command.current()) {
          const latest = await agentApi.conversation(value.conversation.id);
          if (command.current()) applySnapshot(latest);
          throw new Error('任务已在其他页面或后续轮次中改变，已读取最新状态。草稿和附件保留，请确认后重新操作。');
        }
        throw reason;
      }
    });
  }
  async function prepareEdit(round: AgentRound, origin: 'edit' | 'regenerate') {
    if (!current || inFlight || uncertain) return;
    const key = draftKey, revision = draftRevisions.current[draftKey] || 0;
    await runCommand(async command => {
      const original = await agentApi.request(round.requestId);
      const choices = round.inputImageIds.map(id => {
        const image = original.images.find(image => image.id === id) || current.images.find(image => image.id === id);
        return image ? { reference: image.source, label: '原始参考图', url: sameOriginImage(image.thumbnailUrl || image.url), missing: image.status !== 'available' } : null;
      });
      if (choices.some(choice => !choice)) throw new Error('原始参考图记录缺失，不能悄悄改为无参考图生成。');
      if (!command.current() || activeIdRef.current !== key || (draftRevisions.current[key] || 0) !== revision) return;
      updateDraft({ text: round.prompt, refs: choices as ReferenceChoice[], editId: round.id, origin });
      textarea.current?.focus();
    });
  }
  async function retryText(round: AgentRound) {
    if (!current || !config || busy || inFlight || uncertain || uploading || handoffBusy) return;
    const conversation = current, key = current.conversation.id;
    const frozenConfig = structuredClone(config), frozenParams = emptyDraft().params;
    const value = await submitPrepared(async command => {
      const original = await agentApi.request(round.requestId);
      const images = round.inputImageIds.map(id => original.images.find(image => image.id === id));
      if (images.some(image => !image || image.status !== 'available')) throw new Error('原参考图片不可用，不能省略或换图重试。');
      if (!command.current() || activeIdRef.current !== key) return null;
      const payload: AgentRoundCreate = {
        requestId: crypto.randomUUID(), expectedRevision: conversation.revision,
        parentRoundId: round.parentRoundId, origin: 'regenerate', derivedFromRoundId: round.id,
        prompt: round.prompt, refs: images.map(image => image!.source), configRevision: frozenConfig.revision,
        activeProfileId: activeProfileId || null, params: frozenParams,
        authorization: { scope: 'this_request', allowImageGeneration: false, allowWebSearch: false,
          maxImageJobs: 0, maxToolRounds: frozenConfig.config.maxToolRounds },
      };
      return { entry: { conversationId: key, payload, preserveDraft: true } };
    });
    if (value && activeIdRef.current === key) scrollToLatest();
  }
  function refreshPromptExecutions() {
    if (promptExecutionAlive.current) setPromptExecutions(readPendingPromptExecutions(localStorage));
  }
  function acceptPromptExecution(entry: PendingPromptExecution, value: AgentSnapshot, publish: boolean) {
    if (value.conversation.id !== entry.conversationId || value.request?.id !== entry.payload.requestId) throw new Error('直接生成回执身份不匹配，原请求仍保留。');
    clearPendingPromptExecution(localStorage, entry.payload.requestId);
    refreshPromptExecutions();
    if (!promptExecutionAlive.current) return;
    onJobsChanged?.();
    const live = workspaceSnapshot.current;
    if (!publish || activeIdRef.current !== entry.conversationId || !live) return;
    const sameBranch = [entry.payload.branchRoundId, value.request.roundId].includes(live.conversation.activeRoundId);
    if (!sameBranch || live.taskContext?.taskId !== entry.payload.taskId || value.conversation.activeRoundId !== value.request.roundId) { reloadConversation(); return; }
    applySnapshot(value);
    setNotice('已提交确认的提示词配方；草稿、附件和持续生图开关保留。');
  }
  async function checkPromptExecution(entry: PendingPromptExecution) {
    if (directPostLock.current || activeIdRef.current !== entry.conversationId) return;
    directPostLock.current = true;
    try {
      await runCommand(async command => {
        try { acceptPromptExecution(entry, await agentApi.promptExecutionReceipt(entry.payload.requestId, entry.conversationId), command.current()); }
        catch (reason) { throw new Error(`${errorText(reason)}。原直接生成 ID 与配方保留；这里只检查回执，不会重新生成。`); }
      });
    } finally { directPostLock.current = false; }
  }
  async function executeConfirmedPrompt() {
    if (activeIdRef.current !== activeId || !current || !config || !taskContext || !selectedPrompt || draftLocked || inFlight || uploading || handoffBusy || directPostLock.current) return;
    const existing = readPendingPromptExecutions(localStorage).find(entry => entry.conversationId === current.conversation.id);
    if (existing) { await checkPromptExecution(existing); return; }
    if (directUnavailable) { setError(directUnavailable); return; }
    const payload: AgentPromptExecutionInput = {
      requestId: crypto.randomUUID(), expectedRevision: current.revision, branchRoundId: current.conversation.activeRoundId,
      taskId: taskContext.taskId, taskRevision: taskContext.revision, promptVersionId: selectedPrompt.id, configRevision: config.revision,
      imageConfig: { profileId: directProfileId, model: directModel }, params: structuredClone(directParams), imageCount, confirmed: true,
    };
    const entry: PendingPromptExecution = { conversationId: current.conversation.id, payload };
    directPostLock.current = true;
    try {
      await runCommand(async command => {
        let posted = false;
        try {
          savePendingPromptExecution(localStorage, entry);
          checkedPromptExecutions.current.add(payload.requestId); refreshPromptExecutions();
          posted = true;
          const receipt = await agentApi.executePrompt(entry.conversationId, structuredClone(payload));
          acceptPromptExecution(entry, receipt, command.current());
        } catch (reason) {
          if (!posted) throw new Error(`${errorText(reason)}。尚未发送，草稿和附件保留。`);
          if (reason instanceof AgentApiError && [400, 401, 403, 404, 409, 422].includes(reason.status)) {
            clearPendingPromptExecution(localStorage, payload.requestId); refreshPromptExecutions();
            if (reason.status === 409 && command.current()) reloadConversation();
            throw new Error(`${errorText(reason)}。请求已明确拒绝；草稿和附件保留，请核对后重新操作。`);
          }
          throw new Error('本次生成结果尚未确认。请检查原回执；原请求 ID 与冻结配方保留，不会自动重新生成。');
        }
      });
    } finally { directPostLock.current = false; }
  }
  async function continuePromptOptimization() {
    if (activeIdRef.current !== activeId || !current || !config || !taskContext || !selectedPrompt || draftLocked || inFlight || uploading || handoffBusy || directPostLock.current) return;
    if (readPendingPromptExecutions(localStorage).some(entry => entry.conversationId === current.conversation.id)) { setError('此会话还有尚未确认的直接生成，请先检查原回执。'); return; }
    const conversation = current, task = structuredClone(taskContext), prompt = selectedPrompt.text, frozenConfig = structuredClone(config);
    const result = await submitPrepared(async command => {
      if (!command.current() || activeIdRef.current !== conversation.conversation.id) return null;
      const payload: AgentRoundCreate = {
        requestId: crypto.randomUUID(), expectedRevision: conversation.revision, parentRoundId: conversation.conversation.activeRoundId,
        origin: 'send', prompt: `请继续优化以下明确选定的提示词，保留已确认的约束；提供候选版本，等待我明确选择。\n\n${prompt}`,
        refs: [], configRevision: frozenConfig.revision, activeProfileId: activeProfileId || null, params: emptyDraft().params,
        contextScope: 'task', historyRoundIds: [], taskRevision: task.revision,
        authorization: { scope: 'this_request', allowImageGeneration: false, allowWebSearch: false, maxToolRounds: frozenConfig.config.maxToolRounds, maxImageJobs: 0 },
      };
      return { entry: { conversationId: conversation.conversation.id, payload, preserveDraft: true } };
    });
    if (result && activeIdRef.current === conversation.conversation.id) scrollToLatest();
  }
  useEffect(() => {
    if (!active || !current || conversationLoading || busy || directPostLock.current || !pendingPromptExecution || checkedPromptExecutions.current.has(pendingPromptExecution.payload.requestId)) return;
    checkedPromptExecutions.current.add(pendingPromptExecution.payload.requestId);
    void checkPromptExecution(pendingPromptExecution);
  }, [active, current?.conversation.id, conversationLoading, busy, pendingPromptExecution?.payload.requestId]);
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
  async function submit() {
    if (activeIdRef.current !== activeId || busy || handoffBusy || uploading || inFlight || uncertain || pendingPromptExecution || conversationUnavailable || !draft.text.trim() || !config) return;
    if (imagesAllowed && incompatibleImageSelection) {setError('生图方式已改变，旧供应商选择不适用于当前方式。请在生图设置中重新选择生图模型；原草稿和附件保留。');return;}
    if (imagesAllowed && (!imageReady || imageCount > config.config.maxImageJobs)) { setError(sharedUnavailable || (!imageReady ? '请先完善生图设置，草稿与附件保留。' : `当前数量 ${imageCount} 超出 Agent 已配置的 ${config.config.maxImageJobs} 张安全上限，请调整数量或设置中的上限。`)); return; }
    if (draft.refs.some(ref => ref.missing)) { setError('存在缺失参考图，请明确替换或移除后再发送。'); return; }
    const derived = draft.editId ? current?.conversation.rounds.find(round => round.id === draft.editId) : null;
    if (draft.editId && !derived) { setError('原分支已不存在，请重新选择。'); return; }
    const branch = derived ? rounds.slice(0, rounds.findIndex(round => round.id === derived.id)) : rounds;
    if (contextScope === 'selected' && (!selectedHistory.length || selectedHistory.some(id => !branch.some(round => round.id === id)))) { setError('请选择当前分支中需要带入的历史轮次；草稿和附件保留。'); return; }
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
    setNotice('');
    let submittedRevision = draftRevisions.current[draftKey] || 0;
    const submittedAuthorizationRevision = { ...authorizationRevision.current };
    const result = await submitPrepared(async command => {
      let value = current;
      if (!value && !activeId) {
        value = await command.createConversation();
        if (!value) return null;
        if (newImageMode) rememberImageMode(value.conversation.id, true);
        setNewImageMode(false);
        const originalRevision = submittedRevision;
        submittedRevision = draftRevisions.current[value.conversation.id] || 0;
        setDrafts(old => {
          const next = { ...old, [value!.conversation.id]: draft };
          if ((draftRevisions.current[draftKey] || 0) === originalRevision) delete next.new;
          return next;
        });
      }
      if (!value) return null;
      const payload: AgentRoundCreate = {
        requestId: crypto.randomUUID(), expectedRevision: value.revision, parentRoundId: derived ? derived.parentRoundId : value.conversation.activeRoundId,
        origin: draft.origin, derivedFromRoundId: derived?.id, prompt: draft.text, refs: resolved.refs,
        configRevision: config.revision, activeProfileId: activeProfileId || null, params: resolvedParams, imageCount,
        contextScope, historyRoundIds: contextScope === 'selected' ? [...selectedHistory] : [],
        taskRevision: (derived ? branch.at(-1)?.taskContext : value.taskContext)?.revision ?? null,
        ...(imagesAllowed && draft.imageConfig ? {imageConfig:structuredClone(draft.imageConfig)} : {}),
        authorization: { scope: 'this_request', allowImageGeneration: imagesAllowed, allowWebSearch: Boolean(allowWebSearch && config.config.webSearch && config.capabilities.webSearch), maxImageJobs: imagesAllowed ? config.config.maxImageJobs : 0, maxToolRounds: config.config.maxToolRounds },
      };
      const entry = { conversationId: value.conversation.id, payload };
      return { entry, boundary: { conversationId: entry.conversationId, draft: submittedRevision, authorization: submittedAuthorizationRevision } };
    });
    if (result) requestAnimationFrame(() => {
      if (activeIdRef.current === result.conversation.id) scrollToLatest();
      if (restoreComposerFocus && activeIdRef.current === result.conversation.id && textarea.current?.isConnected && document.activeElement === document.body) textarea.current.focus();
    });
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
        {renaming === item.id ? <form onSubmit={async event => { event.preventDefault(); await runCommand(async command => { const existing = await agentApi.conversation(item.id); if (!command.current()) return; const value = await agentApi.updateConversation(item.id, { expectedRevision: existing.revision, title: titleDraft }); if (command.current()) { applySnapshot(value); setRenaming(null); } }); }}><input aria-label="会话名称" autoFocus value={titleDraft} onChange={event => setTitleDraft(event.target.value)} maxLength={200} /><button title="保存名称" aria-label="保存名称" type="submit"><Check size={15} /></button><button aria-label="取消重命名" type="button" onClick={() => setRenaming(null)}><X size={15} /></button></form> : <>
          <button className="agent-conversation-link" aria-label={`打开会话 ${item.title}`} onClick={() => { setActiveId(item.id); setDeleteTarget(null); }}><span>{item.runningRequestId ? <LoaderCircle size={15} className="spin" /> : <MessageSquare size={15} />}{item.title}</span><small>{item.roundCount} 轮 · {new Date(item.updatedAt).toLocaleDateString()}</small></button>
          <div className="agent-conversation-actions"><button title="重命名会话" aria-label={`重命名 ${item.title}`} onClick={() => { setRenaming(item.id); setTitleDraft(item.title); }}><Pencil size={14} /></button><button title="删除会话" aria-label={`删除 ${item.title}`} onClick={() => setDeleteTarget(item.id)}><Trash2 size={14} /></button></div>
        </>}
        {deleteTarget === item.id && <div className="agent-delete-confirm"><p>删除会话？画廊结果与 Library 资产会保留。</p><button aria-label="确认删除会话" onClick={() => void runCommand(async command => { await agentApi.deleteConversation(item.id); if (!command.current()) return; removeConversation(item.id); rememberImageMode(item.id, false); if (item.id === activeIdRef.current) { setNewImageMode(false); setActiveId(null); } setDeleteTarget(null); })}>确认删除</button><button aria-label="取消删除会话" onClick={() => setDeleteTarget(null)}>取消</button></div>}
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
        {conversationLoadError && <p className="agent-error" role="alert">会话读取失败：{conversationLoadError}。草稿和参考图已保留。<button aria-label="重试读取当前会话" disabled={conversationLoading} onClick={reloadConversation}>重试</button></p>}
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
              {round.kind === 'prompt_execution' && round.directRecipe && <section className="agent-confirmed-recipe-card" aria-label="已确认配方生成记录"><strong>按已确认配方生成，未经过额外文字规划</strong><p>{round.directRecipe.mode === 'native' ? '使用原生 Responses 图片协议，本次仍有图片请求。' : '通过已选 Images 图片接口生成。'}</p><p>{round.directRecipe.imageCount} 张 · {String(round.directRecipe.params.model || '供应商默认图片模型')} · {String(round.directRecipe.params.size || 'auto')} · {String(round.directRecipe.params.quality || 'auto')} · {String(round.directRecipe.params.output_format || 'png')}</p><p>Prompt 来源：{round.directRecipe.promptSource.kind === 'model' ? 'Agent 回答，由你明确选择' : '你明确选择的原文'} · 配方参考图 {round.directRecipe.references.length} 张</p>{round.directRecipe.references.length > 0 && <ol>{round.directRecipe.references.map(reference => <li key={reference.assetId}>{reference.order + 1}. {referenceRoleText[reference.role] || reference.role}</li>)}</ol>}</section>}
              {blocks.map(block => {
                if (block.type === 'text') return <AgentMarkdown key={block.key} text={block.content} promptSelectionDisabled={draftLocked || inFlight} onSelectPrompt={text => void changeTaskContext([{ op: 'set_prompt', text, kind: 'selected', source: { kind: 'model', roundId: round.id, ...(assistant?.id ? { messageId: assistant.id } : {}) } }])} />;
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
                {assistant?.content && <button className="agent-text-button" aria-label={`将第 ${roundIndex + 1} 轮回答原文设为 Prompt`} disabled={draftLocked || inFlight} onClick={() => void changeTaskContext([{ op: 'set_prompt', text: assistant.content, kind: 'selected', source: { kind: 'model', roundId: round.id, messageId: assistant.id } }])}>使用回答原文</button>}
                {!round.outputTaskIds.length && !round.retryTaskIds?.length && <button className="agent-text-button" aria-label="重试回答" title="重试回答，保留当前草稿" disabled={inFlight || busy || Boolean(uncertain) || uploading || handoffBusy} onClick={() => void retryText(round)}><RotateCcw size={15} /></button>}
                <button className="agent-text-button agent-answer-details" title="查看回答详情" aria-label={`查看第 ${roundIndex + 1} 轮详情`} aria-haspopup="dialog" aria-expanded={panel === 'details' && detailRoundId === round.id} onClick={event => openPanel('details', event.currentTarget, round.id)}><Info size={15} /></button>
              </div>
            </div>
          </article>;
        })}
        {current?.request && requestNeedsAttention && (current.request.upstreamMayContinue || current.request.canResume) && <div className="agent-request-attention" role="alert">{current.request.upstreamMayContinue && <p>已发送的上游请求可能仍在执行或计费；请先检查原请求，不会自动重复提交。</p>}{current.request.canResume && <button aria-label="继续已确认安全的步骤" disabled={busy} onClick={() => void resume()}>继续已确认安全的步骤</button>}</div>}
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
        {pendingPromptExecution && <div className="agent-uncertain" aria-label="直接生成回执待确认"><strong>直接生成回执待确认</strong><p>本次冻结：{pendingPromptExecution.payload.imageCount} 张 · {pendingPromptExecution.payload.imageConfig.model || '供应商默认图片模型'} · {pendingPromptExecution.payload.params.size} · {pendingPromptExecution.payload.params.quality}。原请求 ID 与配方已保存；刷新仅检查原回执。</p><button type="button" aria-label="检查本次直接生成状态" disabled={busy} onClick={() => void checkPromptExecution(pendingPromptExecution)}>检查本次生成状态</button></div>}
        {config && !config.ready && <p className="agent-help">{config.issues.map(issue => issue.message).join('；')} <button className="agent-text-button" aria-label="打开 Agent 设置" onClick={onOpenSettings}>打开设置</button></p>}
        {draft.editId && <div className="agent-edit-notice">{draft.origin === 'regenerate' ? '重新生成' : '编辑重发'}会建立新分支，原记录保留。<button aria-label="取消分支编辑" disabled={draftLocked} onClick={() => updateDraft({ editId: null, origin: 'send' })}>取消分支编辑</button></div>}
        <div className="agent-context-toolbar">
          <label>发送范围<select aria-label="发送上下文范围" value={contextScope} disabled={draftLocked || inFlight} onChange={event => updateDraft({ contextScope: event.target.value as Draft['contextScope'] })}><option value="task">当前任务</option><option value="selected">选择历史内容</option><option value="branch">完整分支</option></select></label>
          <span aria-label="发送图片范围">{imagePreview.size} {previewUncertain ? '个图片候选 · 实际发送数量待核对' : '个图片对象'} · {mainImageReference ? `主要图片：${imagePreview.get(referenceKey(mainImageReference))?.label || '当前任务图片'}` : imagePreview.size ? '待选择主要图片' : '无主要图片'}</span>
        </div>
        {contextScope === 'branch' && <p className="agent-context-warning" role="status">完整分支会带入更多历史内容和图片，响应可能更慢、费用更高。</p>}
        {contextScope === 'task' && !taskContext && rounds.length > 0 && <p className="agent-context-warning" role="status" aria-label="上下文范围提示">旧会话尚无结构化任务，本轮会按兼容规则读取当前分支历史。</p>}
        {contextScope === 'task' && taskContext?.completeness === 'history_required' && <p className="agent-context-warning" role="status" aria-label="上下文范围提示">当前任务仍依赖历史内容，请展开任务状态查看原因。</p>}
        {contextScope === 'selected' && <p className="agent-context-warning" role="status" aria-label="上下文范围提示">已选择 {selectedHistory.filter(id => rounds.some(round => round.id === id)).length} 轮历史；当前任务资料和本轮附件仍会保留。</p>}
        {previewUncertain && <p className="agent-context-warning" role="status" aria-label="图片候选范围说明">{replacingTaskTarget ? '新附件作为主要图片，旧目标与旧辅助图片仍可能作为任务证据。' : ''}图片清单包含当前分支 {scopedRounds.length} 轮历史中的已知候选；这不是实际发送数量，缺失图片和服务端证据选择仍需核对。</p>}
        <details className="agent-task-context" open={contextScope === 'selected' ? true : undefined}>
          <summary>任务状态 · {taskContext ? ({ complete: '完整', partial: '待补充', history_required: '需要历史' }[taskContext.completeness]) : current?.contextMode === 'legacy' || rounds.length ? '旧会话，尚无结构化任务' : '新任务'} · {selectedPrompt ? `Prompt v${promptVersionIndex}` : '尚未明确选择 Prompt'}</summary>
          <div className="agent-task-context-body">
            {!taskContext && <p className="agent-help">{rounds.length ? '旧记录仍保留；当前任务资料不足时会明确回退到历史。可从消息中选定 Prompt，或重置任务。' : '发送后建立当前任务；也可先明确选择输入框 Prompt 或主要图片。'}</p>}
            {taskContext && <>
              <p className="agent-help">任务版本 {taskContext.revision} · {taskTypeText[taskContext.taskType] || taskContext.taskType}</p>
              {taskContext.latestUserAddition?.text && <p className="agent-task-addition">最近补充：{taskContext.latestUserAddition.text}</p>}
              {taskContext.unresolvedItems.length > 0 && <p className="agent-context-warning">待确认：{taskContext.unresolvedItems.join('；')}</p>}
              {taskContext.historyDependencies.length > 0 && <p className="agent-context-warning">回退历史的原因：{taskContext.historyDependencies.map(item => taskHistoryReasonText[item.reason] || item.reason).join('；')}</p>}
              {selectedPrompt && <><p className="agent-help">当前 Prompt v{promptVersionIndex} · 来源：{selectedPrompt.source.kind === 'model' ? 'Agent 回答，由你明确选择' : selectedPrompt.source.kind === 'legacy' ? '旧记录' : '你的原文'}{promptSourceLocation ? ` · ${promptSourceLocation}` : ''}</p><pre className="agent-task-prompt">{selectedPrompt.text}</pre></>}
              {selectedPrompt && <section className="agent-prompt-execution" aria-label="选定提示词操作">
                <p>本次图片参数：{imageCount} 张 · {directModelLabel} · {directSizeUnavailable ? '尺寸待确认' : directParams.size} · {directParams.quality} · {directParams.output_format} · {directParams.background || 'auto'}{typeof directParams.output_compression === 'number' ? ` · 压缩 ${directParams.output_compression}` : ''}</p>
                <p>配方参考图 {directImages.length} 张，按以下角色与顺序使用：</p>
                {directImages.length ? <ol className="agent-direct-references">{directImages.map((reference, index) => {
                  const asset = current?.images.find(image => image.id === reference.assetId), url = sameOriginImage(asset?.thumbnailUrl || asset?.url);
                  return <li key={reference.assetId}>{url && <img src={url} alt={`配方参考 ${index + 1} · ${referenceRoleText[reference.role] || reference.role}`} />}<span>{index + 1}. {referenceRoleText[reference.role] || reference.role}{asset?.status !== 'available' ? ' · 不可用' : ''}</span></li>;
                })}</ol> : <p>无配方参考图。</p>}
                {draft.refs.length > 0 && <p className="agent-help">输入框中的 {draft.refs.length} 张附件会保留；直接生成只使用上面的任务配方参考图。</p>}
                <p className="agent-help">点击“用此提示词生成”，表示确认选定全文和上列参考图角色作为当前完整配方，仅授权本次图片调用。本次不会自动加入聊天历史或额外约束。</p>
                <div className="agent-task-actions">
                  <button type="button" aria-label="继续优化选定提示词" disabled={draftLocked || inFlight || uploading || handoffBusy || !config?.ready} onClick={() => void continuePromptOptimization()}>继续优化</button>
                  <button type="button" aria-label="用选定提示词生成" title={directUnavailable || '仅授权本次生成，保留持续生图开关与输入框草稿'} disabled={draftLocked || inFlight || uploading || handoffBusy || Boolean(directUnavailable)} onClick={() => void executeConfirmedPrompt()}>用此提示词生成</button>
                </div>
                {directUnavailable && <p className="agent-help" role="status">{directUnavailable}</p>}
                <p className="agent-help">直接使用选定原文和本次图片参数，不进行额外文字规划；{config?.config.apiConfigMode === 'native' ? 'Native 仍会发送原生 Responses 图片请求。' : '本次会发送图片请求。'}</p>
              </section>}
              {taskContext.promptVersions.length > 0 && <div className="agent-task-versions" aria-label="Prompt 版本">{taskContext.promptVersions.map((version, index) => <button key={version.id} type="button" aria-label={`恢复 Prompt v${index + 1}`} aria-pressed={version.id === taskContext.selectedPromptVersionId} disabled={draftLocked || inFlight || version.id === taskContext.selectedPromptVersionId} onClick={() => void changeTaskContext([{ op: 'restore_prompt', id: version.id }])}>v{index + 1} · {version.kind === 'candidate' ? '候选' : version.kind === 'executed' ? '已执行' : version.kind === 'original' ? '原文' : '已选择'}</button>)}</div>}
              {promptVersionIndex > 1 && <button type="button" aria-label="撤销当前 Prompt 选择" disabled={draftLocked || inFlight} onClick={() => void changeTaskContext([{ op: 'restore_prompt', id: taskContext.promptVersions[promptVersionIndex - 2].id }])}>撤销当前 Prompt 选择</button>}
              {taskContext.constraints.length > 0 && <div className="agent-task-constraints" aria-label="当前任务约束">{taskContext.constraints.map(constraint => <p key={constraint.id}><span>{constraint.status === 'revoked' ? <s>{constraint.text}</s> : constraint.text}{constraint.status === 'proposed' && <small> · 建议，待确认</small>}</span>{constraint.status === 'proposed' && <button type="button" disabled={draftLocked || inFlight} aria-label={`确认约束 ${constraint.text}`} onClick={() => void changeTaskContext([{ op: 'update_constraint', id: constraint.id, text: constraint.text }])}>确认</button>}<button type="button" disabled={draftLocked || inFlight} aria-label={`${constraint.status === 'revoked' ? '恢复' : '撤销'}约束 ${constraint.text}`} onClick={() => void changeTaskContext([constraint.status === 'revoked' ? { op: 'update_constraint', id: constraint.id, text: constraint.text } : { op: 'revoke_constraint', id: constraint.id }])}>{constraint.status === 'revoked' ? '恢复' : '撤销'}</button></p>)}</div>}
            </>}
            {imagePreview.size > 0 && <div className="agent-task-image-list" aria-label="本次图片对象">{[...imagePreview.entries()].map(([key, image]) => <div key={key}>{image.url && taskImages.some(taskImage => referenceKey(taskImage.source) === key) && !draft.refs.some(choice => referenceKey(choice.reference) === key) && <img src={image.url} alt={image.label} />}<span>{image.label}{mainImageReference && key === referenceKey(mainImageReference) ? ' · 主要图片' : ''}{image.missing ? ' · 不可用' : ''}</span><button type="button" aria-label={`设为主要图片 ${image.label}`} disabled={draftLocked || inFlight || image.missing} onClick={() => void changeTaskContext([{ op: 'set_target', ref: image.reference }])}>设为主要图片</button></div>)}</div>}
            {contextScope === 'selected' && <fieldset className="agent-history-selection"><legend>选择当前分支的历史内容</legend>{!rounds.length && <p>当前分支暂无历史。</p>}{rounds.map((round, index) => <label key={round.id}><input type="checkbox" aria-label={`带入第 ${index + 1} 轮历史`} checked={selectedHistory.includes(round.id)} disabled={draftLocked || inFlight} onChange={event => updateDraft({ historyRoundIds: event.target.checked ? [...selectedHistory, round.id] : selectedHistory.filter(id => id !== round.id) })} /><span>第 {index + 1} 轮 · {round.prompt}</span></label>)}<p className="agent-help">所选轮次包含提问和回答。图片也可在下方单独重新加入本轮附件。</p></fieldset>}
            {rounds.length > 0 && <details className="agent-history-images"><summary>重新加入历史消息或图片</summary>{rounds.map((round, index) => <div key={round.id} className="agent-history-round"><button type="button" aria-label={`将第 ${index + 1} 轮提问设为 Prompt`} disabled={draftLocked || inFlight} onClick={() => void changeTaskContext([{ op: 'set_prompt', text: round.prompt, kind: 'selected', source: { kind: 'user', roundId: round.id, messageId: round.userMessageId } }])}>第 {index + 1} 轮提问设为 Prompt</button>{[...new Set([...round.inputImageIds, ...(round.taskImageIds || [])])].map(id => { const image = current?.images.find(value => value.id === id); if (!image) return <span key={id}>历史图片记录缺失</span>; const selected = draft.refs.some(choice => referenceKey(choice.reference) === referenceKey(image.source)); return <button key={id} type="button" aria-label={`重新加入第 ${index + 1} 轮图片 ${id}`} disabled={draftLocked || inFlight || uploading || image.status !== 'available' || selected || draft.refs.length >= inputLimit} onClick={() => updateDraft({ refs: [...draft.refs, { reference: image.source, url: sameOriginImage(image.thumbnailUrl || image.url), label: `第 ${index + 1} 轮历史参考图` }] })}>{selected ? '已加入' : image.status !== 'available' ? '图片不可用' : '加入历史参考图'}</button>; })}{round.outputTaskIds.map(id => { const job = current?.jobs.find(value => value.id === id); return job ? <button key={id} type="button" disabled={draftLocked || inFlight || uploading || !job.result_path || !['succeeded', 'accepted'].includes(job.status)} onClick={() => addResultReference(job)}>加入第 {index + 1} 轮结果图</button> : null; })}</div>)}</details>}
            <div className="agent-task-actions"><button type="button" aria-label="将输入框原文设为 Prompt" disabled={draftLocked || inFlight || !draft.text.trim()} onClick={() => void changeTaskContext([{ op: 'set_prompt', text: draft.text, kind: 'selected' }])}>输入框原文设为 Prompt</button><button type="button" aria-label="更换任务主要图片" disabled={draftLocked || inFlight} onClick={() => { setTargetPicker(true); setPicker(true); }}>更换目标图片</button><button type="button" aria-label="重置当前任务" disabled={draftLocked || inFlight} onClick={() => void changeTaskContext([{ op: 'new_task' }])}>重置任务</button></div>
          </div>
        </details>
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
    {picker && <AgentReferencePicker remaining={targetPicker ? 1 : Math.max(0, inputLimit - draft.refs.length)} onClose={() => { setPicker(false); setTargetPicker(false); }} onSelect={choices => { if (targetPicker && choices[0]) void changeTaskContext([{ op: 'set_target', ref: choices[0].reference }]); else updateDraft({ refs: [...draft.refs, ...choices.filter(choice => !draft.refs.some(existing => referenceKey(existing.reference) === referenceKey(choice.reference)))] }); }} />}
  </section>;
}
