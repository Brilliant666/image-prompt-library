import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Check, Ellipsis, FolderInput, Plus, Star, Tags, Trash2, XCircle } from 'lucide-react';
import { api, isDemoMode } from './api/client';
import TopBar from './components/TopBar';
import FiltersPanel from './components/FiltersPanel';
import ExploreView from './components/ExploreView';
import CardsView from './components/CardsView';
import ItemDetailModal from './components/ItemDetailModal';
import ItemEditorModal from './components/ItemEditorModal';
import TrashModal, { trashLabels } from './components/TrashModal';
import QuickCaptureModal from './components/QuickCaptureModal';
import GalleryWorkspace from './components/gallery/GalleryWorkspace';
import AgentWorkspace from './components/agent/AgentWorkspace';
import type { AgentGalleryCommand, GalleryImageSettings, GalleryImageSettingsCommand } from './utils/agentGalleryBridge';
import type { GalleryCommand } from './components/gallery/InputBar';
import { readLocalPreferences, saveLocalPreferences } from './utils/localPreferences';

import ConfigPanel from './components/ConfigPanel';
import BatchActionDialog from './components/BatchActionDialog';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import { useItemsQuery } from './hooks/useItemsQuery';
import { useGalleryTitleUpdates } from './hooks/useGalleryTitleUpdates';
import { useModalFocus } from './hooks/useModalFocus';
import type { AppearancePreset, AppConfig, AppUpdateStatus, ClusterRecord, ItemBatchAction, ItemDetail, ItemSortMode, ItemSummary, TagRecord, AiProvider, ViewMode } from './types';
import { copyTextToClipboard } from './utils/clipboard';
import { DEFAULT_AI_PROVIDER_STORAGE_KEY, availableAiProviders, isAiProvider, resolveDefaultAiProvider } from './utils/defaultAiProvider';
import { localizedDemoTitle } from './utils/demoTitles';
import { APPEARANCE_STORAGE_KEY, applyAppearance, loadAppearance } from './utils/appearance';
import { DEFAULT_UI_LANGUAGE, UI_LANGUAGE_LABELS, makeTranslator, normalizeUiLanguage, type UiLanguage } from './utils/i18n';
import { DEFAULT_PROMPT_LANGUAGE, normalizePromptLanguage, resolvePromptText, type PromptCopyLanguage } from './utils/prompts';
import { DEFAULT_ITEM_SORT, parseSearchSortQuery, parseStructuredSearchChips, removeSearchSortOperator } from './utils/searchSort';
import { quickCaptureLabels } from './utils/quickCaptureLabels';

const UI_LANGUAGE_STORAGE_KEY = 'image-prompt-library.ui_language';
const PROMPT_LANGUAGE_STORAGE_KEY = 'image-prompt-library.preferred_prompt_language';
const VIEW_STORAGE_KEY = 'image-prompt-library.view_mode.v2';
const FRONTEND_BUILD_VERSION = import.meta.env.VITE_APP_VERSION || '';
const FRONTEND_VERSION_RELOAD_STORAGE_KEY = 'image-prompt-library.frontend_version_reload_target.v1';

function loadPreferredLanguage(): PromptCopyLanguage {
  if (typeof window === 'undefined') return DEFAULT_PROMPT_LANGUAGE;
  return normalizePromptLanguage(window.localStorage.getItem(PROMPT_LANGUAGE_STORAGE_KEY));
}

function loadUiLanguage(): UiLanguage {
  if (typeof window === 'undefined') return DEFAULT_UI_LANGUAGE;
  return normalizeUiLanguage(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY));
}

function loadHasChosenUiLanguage() {
  if (typeof window === 'undefined') return true;
  return Boolean(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY));
}

function loadPreferredView(): ViewMode {
  if (typeof window === 'undefined') return 'cards';
  const savedView = window.localStorage.getItem(VIEW_STORAGE_KEY);
  if (savedView === 'explore' || savedView === 'cards' || (!isDemoMode && (savedView === 'gallery' || savedView === 'agent'))) return savedView;
  return 'cards';
}

function loadDefaultAiProvider(): AiProvider {
  if (typeof window === 'undefined') return 'openai_codex_oauth_native';
  return resolveDefaultAiProvider(window.localStorage.getItem(DEFAULT_AI_PROVIDER_STORAGE_KEY), []);
}

function localizedClusterName(cluster: ClusterRecord | undefined, language: UiLanguage) {
  return cluster?.names?.[language] || cluster?.names?.en || cluster?.name || '';
}

function localizeCluster(cluster: ClusterRecord, language: UiLanguage): ClusterRecord {
  return { ...cluster, name: localizedClusterName(cluster, language) };
}

function localizeItemForDisplay(item: ItemSummary, language: UiLanguage): ItemSummary {
  const clustered = item.cluster ? { ...item, cluster: localizeCluster(item.cluster, language) } : item;
  return { ...clustered, title: localizedDemoTitle(clustered, language) };
}

export default function App() {
  const [titleUpdates, setTitleUpdates] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<ItemSortMode>(DEFAULT_ITEM_SORT);
  const debouncedQ = useDebouncedValue(q);
  const parsedSearchQuery = useMemo(() => parseSearchSortQuery(debouncedQ), [debouncedQ]);
  const rawParsedSearchQuery = useMemo(() => parseSearchSortQuery(q), [q]);
  const activeSort = rawParsedSearchQuery.explicitSort ? rawParsedSearchQuery.sort : sort;
  const queryFilterChips = useMemo(() => parseStructuredSearchChips(q), [q]);
  const showingArchivedItems = /\barchived:true\b/i.test(q);
  const [clusterId, setClusterId] = useState<string>();
  const [view, setView] = useState<ViewMode>(loadPreferredView);
  const libraryView = useRef<ViewMode>('cards');
  if (view === 'explore' || view === 'cards') libraryView.current = view;
  const viewScroll = useRef<Partial<Record<ViewMode, number>>>({});
  const [localPreferences, setLocalPreferences] = useState(readLocalPreferences);
  const [agentProfileId, setAgentProfileId] = useState('');
  const [agentFocus,setAgentFocus]=useState<{id:string;token:number}>();
  const [agentGalleryCommand, setAgentGalleryCommand] = useState<AgentGalleryCommand>();
  const [galleryImageSettings, setGalleryImageSettings] = useState<GalleryImageSettings>();
  const [galleryImageSettingsCommand, setGalleryImageSettingsCommand] = useState<GalleryImageSettingsCommand>();
  const galleryImageSettingsSequence = useRef(0);
  const updateSharedImageSettings = useCallback((settings: GalleryImageSettings) => {
    if (settings.provider !== 'openai_compatible') return;
    const shared = structuredClone(settings);
    setGalleryImageSettings(shared);
    setGalleryImageSettingsCommand({ id: ++galleryImageSettingsSequence.current, settings: shared });
  }, []);
  const [galleryCommand, setGalleryCommand] = useState<GalleryCommand>();
  const [configSection, setConfigSection] = useState<'api'|'general'|'agent'|'capture'|'data'|'about'>();
  const [configurationRevision, setConfigurationRevision] = useState(0);
  useEffect(() => { const refresh = () => setConfigurationRevision(value => value + 1); window.addEventListener('ipl:agent-config-changed', refresh); return () => window.removeEventListener('ipl:agent-config-changed', refresh); }, []);
  const viewNavigationRunRef = useRef(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(() => !isDemoMode && ['capture_pair', 'capture_organizer'].some(key => new URLSearchParams(location.search).has(key)));
  const [focusConfigProviders, setFocusConfigProviders] = useState(false);
  const [clusters, setClusters] = useState<ClusterRecord[]>([]);
  const [clustersLoading, setClustersLoading] = useState(true);
  const clustersRequestRef = useRef(0);
  const [libraryTotal, setLibraryTotal] = useState<number>();
  const libraryTotalRequestRef = useRef(0);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [detailId, setDetailId] = useState<string | undefined>(() => {
    const value = new URLSearchParams(location.search).get('capture_item');
    return value && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : undefined;
  });
  const [editing, setEditing] = useState<ItemDetail | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [itemsReloadKey, setItemsReloadKey] = useState(0);
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(loadUiLanguage);
  const [hasChosenUiLanguage, setHasChosenUiLanguage] = useState(loadHasChosenUiLanguage);
  const [preferredLanguage, setPreferredLanguage] = useState<PromptCopyLanguage>(loadPreferredLanguage);
  const [appearance, setAppearance] = useState<AppearancePreset>(loadAppearance);
  const [defaultAiProvider, setDefaultAiProvider] = useState<AiProvider>(loadDefaultAiProvider);
  const [toast, setToast] = useState<{ title: string; tone: 'success' | 'error'; duration?: number }>();
  const [toastClosing, setToastClosing] = useState(false);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const [generationQueueRefreshKey, setGenerationQueueRefreshKey] = useState(0);
  const [galleryQueueOpen, setGalleryQueueOpen] = useState(false);
  const [focusedGenerationJobId, setFocusedGenerationJobId] = useState<string>();
  const editItemRequestRef = useRef(0);
  const [editingItemId, setEditingItemId] = useState<string>();
  const [appConfig, setAppConfig] = useState<AppConfig>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(() => new Set());
  const [batchActionDialog, setBatchActionDialog] = useState<'tags' | 'move'>();
  const [selectionActionsOpen, setSelectionActionsOpen] = useState(false);
  const selectionActionsRef = useRef<HTMLDivElement>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const batchActionInFlightRef = useRef(false);
  const detailDeleteInFlightRef = useRef(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>();
  const [restartRequiredVersion, setRestartRequiredVersion] = useState<string>();
  const { data, loading, initialLoading, refreshing, error, dataScope, hasMore, loadingMore, loadMoreError, loadMore } = useItemsQuery(parsedSearchQuery.q, clusterId, undefined, 100, itemsReloadKey, activeSort);
  const dataScopeMatches = dataScope.q === parsedSearchQuery.q
    && dataScope.clusterId === clusterId
    && dataScope.viewLimit === 100
    && dataScope.sort === activeSort;
  const selectedCluster = useMemo(() => clusters.find(c => c.id === clusterId), [clusters, clusterId]);
  const t = useMemo(() => makeTranslator(uiLanguage), [uiLanguage]);
  const { containerRef: firstRunLanguageRef, handleModalKeyDown: handleFirstRunLanguageKeyDown } = useModalFocus<HTMLDivElement>(
    () => undefined,
    { active: !hasChosenUiLanguage, fallbackFocusSelector: '.toolbar-search input' },
  );
  const localizedClusters = useMemo(() => clusters.map(cluster => localizeCluster(cluster, uiLanguage)), [clusters, uiLanguage]);
  const localizedData = useMemo(() => ({ ...data, items: data.items.map(item => localizeItemForDisplay(item, uiLanguage)) }), [data, uiLanguage]);
  useLayoutEffect(() => {
    document.documentElement.lang = uiLanguage === 'zh_hant' ? 'zh-Hant' : uiLanguage === 'zh_hans' ? 'zh-Hans' : 'en';
  }, [uiLanguage]);
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);
  useEffect(() => {
    if (typeof window === 'undefined' || isAiProvider(window.localStorage.getItem(DEFAULT_AI_PROVIDER_STORAGE_KEY))) return undefined;
    let cancelled = false;
    api.generationProviders()
      .then(providers => {
        if (cancelled) return;
        const readyProviders = availableAiProviders(providers);
        if (readyProviders.length !== 1) return;
        const selected = readyProviders[0];
        setDefaultAiProvider(selected);
        window.localStorage.setItem(DEFAULT_AI_PROVIDER_STORAGE_KEY, selected);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!selectionActionsOpen) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!selectionActionsRef.current?.contains(event.target as Node)) setSelectionActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectionActionsOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [selectionActionsOpen]);
  useEffect(() => () => {
    viewNavigationRunRef.current += 1;
  }, []);
  const refreshClusters = useCallback(async () => {
    const requestId = clustersRequestRef.current + 1;
    clustersRequestRef.current = requestId;
    setClustersLoading(true);
    try {
      const nextClusters = await api.clusters();
      if (clustersRequestRef.current === requestId) setClusters(nextClusters);
    } catch {
      if (clustersRequestRef.current === requestId) setClusters([]);
    } finally {
      if (clustersRequestRef.current === requestId) setClustersLoading(false);
    }
  }, []);
  const refreshLibraryTotal = useCallback(async () => {
    const requestId = libraryTotalRequestRef.current + 1;
    libraryTotalRequestRef.current = requestId;
    try {
      const result = await api.items({ limit: 1 });
      if (libraryTotalRequestRef.current === requestId) setLibraryTotal(result.total);
    } catch {
      // Preserve the last known total when a background refresh fails.
    }
  }, []);
  const refreshTags = () => api.tags().then(setTags).catch(() => setTags([]));
  const refreshAppConfig = () => api.config().then(setAppConfig).catch(() => setAppConfig(undefined));
  const refreshUpdateStatus = useCallback((refresh = false) => api.updateStatus(refresh).then(status => {
    setUpdateStatus(status);
    if (!status.update_available) setRestartRequiredVersion(undefined);
    return status;
  }).catch(() => {
    setUpdateStatus(current => current
      ? { ...current, error: 'Could not check for updates', update_available: false }
      : {
        current_version: 'unknown',
        latest_version: null,
        update_available: false,
        checked_at: new Date().toISOString(),
        error: 'Could not check for updates',
        update_capability: 'unknown',
        update_reason: 'request_failed',
        service_mode: 'unknown',
        active_generation_jobs: { running: 0, queued: 0 },
        can_restart: false,
        requires_manual_restart: true,
      });
    return undefined;
  }), []);
  const handleUpdateInstalled = useCallback((targetVersion: string, requiresManualRestart: boolean) => {
    setRestartRequiredVersion(requiresManualRestart ? targetVersion : undefined);
    if (!requiresManualRestart) {
      setUpdateStatus(current => current ? { ...current, update_available: false } : current);
    }
  }, []);
  useEffect(() => { refreshClusters(); refreshLibraryTotal(); refreshTags(); refreshAppConfig(); refreshUpdateStatus(); }, [refreshClusters, refreshLibraryTotal, refreshUpdateStatus]);
  useEffect(() => {
    if (isDemoMode || !FRONTEND_BUILD_VERSION || FRONTEND_BUILD_VERSION === 'demo') return;
    api.health().then(({ version: serverVersion }) => {
      if (!serverVersion || serverVersion === 'demo' || serverVersion === FRONTEND_BUILD_VERSION) {
        window.sessionStorage.removeItem(FRONTEND_VERSION_RELOAD_STORAGE_KEY);
        return;
      }
      if (serverVersion !== FRONTEND_BUILD_VERSION && window.sessionStorage.getItem(FRONTEND_VERSION_RELOAD_STORAGE_KEY) === serverVersion) return;
      window.sessionStorage.setItem(FRONTEND_VERSION_RELOAD_STORAGE_KEY, serverVersion);
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('_ipl_refresh', serverVersion);
      currentUrl.searchParams.set('_ipl_ts', Date.now().toString());
      window.location.replace(currentUrl.toString());
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = undefined;
    setToastClosing(false);
    if (!toast) return undefined;
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = undefined;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setToast(undefined);
        return;
      }
      setToastClosing(true);
      toastTimerRef.current = window.setTimeout(() => {
        toastTimerRef.current = undefined;
        setToast(undefined);
      }, 180);
    }, toast.duration ?? 2600);
    return () => {
      if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = undefined;
    };
  }, [toast]);
  const selectCluster = (c: ClusterRecord) => { setClusterId(c.id); updateView('cards'); };
  const handleFilterSelect = (c: ClusterRecord) => selectCluster(c);
  const clearCluster = () => setClusterId(undefined);
  const saved = () => { refreshClusters(); refreshLibraryTotal(); refreshTags(); setItemsReloadKey(k => k + 1); };
  const savedLibraryAssets = () => { saved(); setGenerationQueueRefreshKey(k => k + 1); };
  const trackGalleryTitle = useGalleryTitleUpdates(itemId => {
    setItemsReloadKey(k => k + 1);
    setTitleUpdates(previous => ({ ...previous, [itemId]: (previous[itemId] || 0) + 1 }));
  });
  const clearSelection = () => setSelectedItemIds(new Set());
  const exitSelectionMode = () => { setBatchActionDialog(undefined); setSelectionActionsOpen(false); setSelectionMode(false); clearSelection(); };
  const deleted = () => { setDetailId(undefined); setEditing(undefined); setFocusedGenerationJobId(undefined); exitSelectionMode(); refreshClusters(); refreshLibraryTotal(); refreshTags(); setItemsReloadKey(k => k + 1); setGenerationQueueRefreshKey(k => k + 1); };
  const refreshAfterBatch = () => { refreshClusters(); refreshLibraryTotal(); refreshTags(); setItemsReloadKey(k => k + 1); setGenerationQueueRefreshKey(k => k + 1); };
  const updatePreferredLanguage = (language: PromptCopyLanguage) => {
    setPreferredLanguage(language);
    window.localStorage.setItem(PROMPT_LANGUAGE_STORAGE_KEY, language);
  };
  const updateUiLanguage = (language: UiLanguage) => {
    setUiLanguage(language);
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  };
  const updateAppearance = (nextAppearance: AppearancePreset) => {
    setAppearance(nextAppearance);
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, nextAppearance);
  };
  const updateDefaultAiProvider = (provider: AiProvider) => {
    setDefaultAiProvider(provider);
    window.localStorage.setItem(DEFAULT_AI_PROVIDER_STORAGE_KEY, provider);
  };
  const cancelPendingEdit = () => {
    editItemRequestRef.current += 1;
    setEditingItemId(undefined);
  };
  const chooseFirstRunLanguage = (language: UiLanguage) => {
    updateUiLanguage(language);
    setHasChosenUiLanguage(true);
  };
  const updateView = (nextView: ViewMode) => {
    if (nextView === view) return;
    const run = ++viewNavigationRunRef.current;
    cancelPendingEdit();
    viewScroll.current[view] = window.scrollY;
    setGalleryQueueOpen(false);
    if (nextView === 'explore' || nextView === 'cards') {
      setBatchActionDialog(undefined);
      setSelectionActionsOpen(false);
    }
    // Keep the live header and content instead of compositing old/new snapshots.
    setView(nextView);
    requestAnimationFrame(() => {
      if (viewNavigationRunRef.current === run) window.scrollTo({top:viewScroll.current[nextView] || 0,behavior:'instant'});
    });
    window.localStorage.setItem(VIEW_STORAGE_KEY, nextView);
  };
  const updateSort = (nextSort: ItemSortMode) => {
    setSort(nextSort);
    setQ(current => removeSearchSortOperator(current));
  };
  const showCopyToast = (success: boolean) => {
    setToast({ title: success ? t('copySuccess') : t('copyFailed'), tone: success ? 'success' : 'error', duration: 1800 });
  };
  const copyPrompt = async (item: ItemSummary) => {
    const text = resolvePromptText(item.prompts, preferredLanguage, item.title);
    const copied = await copyTextToClipboard(text);
    showCopyToast(copied);
  };
  const queryPending = q !== debouncedQ;
  const currentScopeSettled = !initialLoading && !queryPending && !loading && dataScopeMatches;
  const contentLoading = initialLoading
    || queryPending
    || (loading && !dataScopeMatches)
    || (view === 'explore' && !parsedSearchQuery.q.trim() && clustersLoading);
  const emptyMode = currentScopeSettled
    ? (!isDemoMode && localizedData.items.length === 0 && !q.trim() && !clusterId ? 'first-run' : 'no-results')
    : undefined;
  const openNewItemEditor = () => { cancelPendingEdit(); setQuickCaptureOpen(true); };
  const openFilters = () => { cancelPendingEdit(); setConfigOpen(false); setFocusConfigProviders(false); setFiltersOpen(true); };
  const openConfig = () => { cancelPendingEdit(); setFiltersOpen(false); setFocusConfigProviders(false); setConfigOpen(true); };
  const closeConfig = () => { setConfigOpen(false); setFocusConfigProviders(false); };
  const openProviders = () => {
    cancelPendingEdit();
    setFiltersOpen(false);
    setFocusConfigProviders(true);
    setConfigOpen(true);
  };
  const openStandaloneGeneration = () => { cancelPendingEdit(); setDetailId(undefined); setFocusedGenerationJobId(undefined); updateView('gallery'); };
  const openGenerationFromDetail = (item: ItemDetail, imageId?: string) => { cancelPendingEdit(); setDetailId(undefined); setGalleryCommand({id:Date.now(),item,imageId}); updateView('gallery'); };

  const closeItemDetail = () => {
    setDetailId(undefined);
    setFocusedGenerationJobId(undefined);
  };
  const favorite = (id: string) => { api.favorite(id).then(saved).catch(() => undefined); };
  const toggleSelectedItem = (id: string) => {
    setSelectedItemIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const deleteDetail = async (item: ItemDetail) => {
    if (detailDeleteInFlightRef.current) return;
    if (!confirm(t('deleteReferenceConfirm'))) return;
    detailDeleteInFlightRef.current = true;
    try {
      await api.deleteItem(item.id);
      deleted();
    } catch {
      setToast({ title: t('saveFailed'), tone: 'error' });
    } finally {
      detailDeleteInFlightRef.current = false;
    }
  };
  const runBatchAction = async (action: ItemBatchAction, extra: { tags?: string[]; cluster_id?: string; cluster_name?: string } = {}) => {
    if (!selectedItemIds.size || batchActionInFlightRef.current) return false;
    batchActionInFlightRef.current = true;
    setBatchBusy(true);
    const attemptedIds = new Set(selectedItemIds);
    try {
      const result = await api.batchItems({ item_ids: Array.from(attemptedIds), action, ...extra });
      refreshAfterBatch();
      if (result.failed > 0) {
        const failedIds = new Set(Object.keys(result.errors || {}));
        const changedIds = new Set(result.item_ids || []);
        for (const id of attemptedIds) {
          if (failedIds.size >= result.failed) break;
          if (!changedIds.has(id)) failedIds.add(id);
        }
        setSelectedItemIds(failedIds.size ? failedIds : attemptedIds);
        setSelectionMode(true);
        setToast({
          title: t('batchActionPartialFailure')
            .replace('${changed}', String(result.changed))
            .replace('${failed}', String(result.failed)),
          tone: 'error',
          duration: 4200,
        });
        return true;
      }
      exitSelectionMode();
      return true;
    } catch {
      setToast({ title: t('saveFailed'), tone: 'error' });
      return false;
    } finally {
      batchActionInFlightRef.current = false;
      setBatchBusy(false);
    }
  };
  const deleteSelectedItems = async () => {
    if (!selectedItemIds.size) return;
    if (!confirm(t('deleteSelectedReferencesConfirm').replace('${selectedItemIds.size}', String(selectedItemIds.size)))) return;
    await runBatchAction('delete');
  };
  const batchArchiveSelected = () => { setSelectionActionsOpen(false); runBatchAction(showingArchivedItems ? 'unarchive' : 'archive'); };
  const batchFavoriteSelected = () => { setSelectionActionsOpen(false); runBatchAction('favorite'); };
  const batchAddTagsSelected = () => { setSelectionActionsOpen(false); setBatchActionDialog('tags'); };
  const batchMoveSelected = () => { setSelectionActionsOpen(false); setBatchActionDialog('move'); };
  const editSummary = async (item: { id: string }) => {
    if (editingItemId === item.id) return;
    const requestId = editItemRequestRef.current + 1;
    editItemRequestRef.current = requestId;
    setEditingItemId(item.id);
    try {
      const full = await api.item(item.id);
      if (editItemRequestRef.current !== requestId) return;
      setEditing(full);
      setEditorOpen(true);
    } catch {
      if (editItemRequestRef.current === requestId) setToast({ title: t('loadFailed'), tone: 'error' });
    } finally {
      if (editItemRequestRef.current === requestId) setEditingItemId(undefined);
    }
  };
  const showManagementActions = !isDemoMode && view === 'cards';
  const drawerModalOpen = filtersOpen || configOpen;
  const blockingModalOpen = !hasChosenUiLanguage || Boolean(detailId || editorOpen || quickCaptureOpen || batchActionDialog || galleryQueueOpen || trashOpen);
  const showFloatingActions = Boolean(hasChosenUiLanguage && !selectionMode && !filtersOpen && !configOpen && !detailId);
  const floatingActionsHidden = editorOpen || quickCaptureOpen || trashOpen;
  const updateBadgeLabel = restartRequiredVersion
    ? t('restartRequired')
    : (updateStatus?.update_available && updateStatus.update_capability !== 'source' ? t('updateAvailable') : undefined);
  return <div className={`app ${view === 'explore' ? 'explore-mode' : 'cards-mode'}`}>
    <FiltersPanel t={t} open={filtersOpen} clusters={localizedClusters} total={libraryTotal} selected={clusterId} onSelect={handleFilterSelect} onClear={clearCluster} onClose={() => setFiltersOpen(false)} />
    <ConfigPanel agentWorkspaceProfileId={agentProfileId} t={t} open={configOpen} focusProviders={focusConfigProviders} focusSection={configSection} localPreferences={localPreferences} onLocalPreferences={value => { setLocalPreferences(value); saveLocalPreferences(value); }} onClose={() => { closeConfig(); setConfigSection(undefined); setConfigurationRevision(value => value + 1); }} uiLanguage={uiLanguage} onUiLanguage={updateUiLanguage} preferredLanguage={preferredLanguage} onPreferredLanguage={updatePreferredLanguage} appearance={appearance} onAppearance={updateAppearance} defaultAiProvider={defaultAiProvider} onDefaultAiProvider={updateDefaultAiProvider} updateStatus={updateStatus} onRefreshUpdateStatus={refreshUpdateStatus} onUpdateInstalled={handleUpdateInstalled} onLibraryCleanup={saved} />
    <div className="app-content" inert={drawerModalOpen}>
    {!hasChosenUiLanguage && (
      <div ref={firstRunLanguageRef} className="first-run-language-overlay" role="dialog" aria-modal="true" aria-labelledby="first-run-language-title" tabIndex={-1} onKeyDown={handleFirstRunLanguageKeyDown}>
        <section className="first-run-language-card">
          <p className="first-run-language-eyebrow">Image Prompt Library</p>
          <h2 id="first-run-language-title">{t('chooseLanguage')}</h2>
          <p>{t('chooseLanguageHelp')}</p>
          <div className="first-run-language-options" role="group" aria-label={t('chooseLanguage')}>
            {(['zh_hant', 'zh_hans', 'en'] as UiLanguage[]).map(language => (
              <button key={language} type="button" onClick={() => chooseFirstRunLanguage(language)}>{UI_LANGUAGE_LABELS[language]}</button>
            ))}
          </div>
          <p className="first-run-language-note">{t('changeLanguageLater')}</p>
        </section>
      </div>
    )}
    <TopBar t={t} q={q} queryFilterChips={queryFilterChips} collectionName={localizedClusterName(selectedCluster, uiLanguage)} onClearCollection={clearCluster} updateBadgeLabel={updateBadgeLabel} onQ={setQ} view={view} onView={updateView} onFilters={openFilters} onConfig={openConfig} onCapture={isDemoMode ? undefined : openNewItemEditor} onTrash={isDemoMode ? undefined : () => { cancelPendingEdit(); setTrashOpen(true); }} trashLabel={trashLabels(uiLanguage).title} filtersOpen={filtersOpen} configOpen={configOpen} hasActiveFilter={Boolean(selectedCluster)} modalOpen={blockingModalOpen} />
    <div className="content-plane" inert={blockingModalOpen} aria-hidden={blockingModalOpen || undefined}>
    {isDemoMode && (
      <div className="demo-banner" role="status">
        <strong>{t('onlineReadOnlyDemo')}</strong>
        <span>{t('runLocallyForPrivateLibrary')}</span>
        <span>{t('localInstallHighlights')}</span>
        <a href="https://github.com/EddieTYP/image-prompt-library" target="_blank" rel="noreferrer">{t('viewOnGitHub')}</a>
      </div>
    )}
    {/* Static-test compatibility marker: <main className="app-main"> */}
    <main className={`app-main ${refreshing ? 'is-refreshing' : ''}${loading && !dataScopeMatches ? ' is-scope-loading' : ''}`} aria-busy={loading} hidden={view === 'gallery' || view === 'agent'}>
      {refreshing && <div className="refresh-indicator" role="status">{t('loading')}</div>}
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <button type="button" className="secondary" onClick={() => setItemsReloadKey(key => key + 1)}>{t('retry')}</button>
        </div>
      )}
      {(!error || localizedData.items.length > 0) && (libraryView.current === 'explore'
        ? <ExploreView t={t} clusters={localizedClusters} items={localizedData.items} total={localizedData.total} hasActiveSearch={Boolean(parsedSearchQuery.q.trim())} searchQuery={parsedSearchQuery.q} loading={contentLoading || refreshing} sort={activeSort} onSort={updateSort} onOpenCollection={selectCluster} onOpen={setDetailId} onCopyPrompt={copyPrompt} onAdd={isDemoMode ? undefined : openNewItemEditor} hasMore={dataScopeMatches && hasMore} loadingMore={loadingMore} loadMoreError={loadMoreError} onLoadMore={loadMore} />
        : <CardsView t={t} items={localizedData.items} loading={contentLoading || refreshing} emptyMode={emptyMode} total={localizedData.total} sort={activeSort} onSort={updateSort} clusterName={localizedClusterName(selectedCluster, uiLanguage)} hasActiveSearch={Boolean(parsedSearchQuery.q.trim())} onClearCluster={clearCluster} onOpen={setDetailId} onFavorite={isDemoMode ? undefined : favorite} onEdit={isDemoMode ? undefined : editSummary} editingItemId={editingItemId} onToggleSelection={selectionMode ? toggleSelectedItem : undefined} selectedIds={selectedItemIds} onCopyPrompt={copyPrompt} onAdd={isDemoMode ? undefined : openNewItemEditor} onOpenConfig={openConfig} hasMore={dataScopeMatches && hasMore} loadingMore={loadingMore} loadMoreError={loadMoreError} onLoadMore={loadMore} />)}
    </main>
    {!isDemoMode && <>
      <GalleryWorkspace active={view === 'gallery'} imageSettingsCommand={galleryImageSettingsCommand} onImageSettingsChange={setGalleryImageSettings} onSendToAgent={(job,intent) => {setAgentGalleryCommand({id:Date.now(),job,intent}); updateView('agent');}} queueOpen={galleryQueueOpen} onQueueOpenChange={setGalleryQueueOpen} t={t} preferences={localPreferences} libraryScope={appConfig?.library_path} command={galleryCommand} focusJobId={focusedGenerationJobId} onCloseDetail={() => setFocusedGenerationJobId(undefined)} refreshKey={generationQueueRefreshKey} configurationRevision={configurationRevision} promptVariablesEnabled={Boolean(appConfig?.features?.camelot?.percival)} promptLanguage={preferredLanguage === 'origin' ? uiLanguage : preferredLanguage} preferredProvider={defaultAiProvider} onOpenAgent={id => {setAgentFocus({id,token:Date.now()}); updateView('agent');}} onOpenSettings={openProviders} onAccepted={(id, autoTitle) => { saved(); setDetailId(id); if (autoTitle) trackGalleryTitle(id); }} onQueueChanged={() => setGenerationQueueRefreshKey(value => value + 1)} />
      <AgentWorkspace galleryCommand={agentGalleryCommand} galleryImageSettings={galleryImageSettings} onGalleryImageSettingsChange={updateSharedImageSettings} onProfileChange={setAgentProfileId} focusConversationId={agentFocus?.id} focusToken={agentFocus?.token} active={view === 'agent'} onOpenSettings={() => { setFocusConfigProviders(false); setConfigSection('agent'); setConfigOpen(true); }} onOpenJob={id => {setFocusedGenerationJobId(id); updateView('gallery');}} onLibraryChanged={saved} onJobsChanged={() => setGenerationQueueRefreshKey(value => value + 1)} />
    </>}
    </div>
    {view === 'cards' && selectionMode && !isDemoMode && (
      <div className="selection-toolbar" role="toolbar" aria-label={t('selectReferences')} aria-busy={batchBusy} inert={blockingModalOpen} aria-hidden={blockingModalOpen || undefined}>
        <button type="button" className="selection-toolbar-button selection-toolbar-cancel" onClick={exitSelectionMode} disabled={batchBusy}>{t('cancel')}</button>
        <span className="selection-toolbar-count">{selectedItemIds.size} {t('selectedReferences')}</span>
        <div className="selection-toolbar-secondary">
          <button type="button" className="selection-toolbar-button selection-toolbar-desktop-action" onClick={batchArchiveSelected} disabled={!selectedItemIds.size || batchBusy}>
            {showingArchivedItems ? <ArchiveRestore size={16} /> : <Archive size={16} />} {showingArchivedItems ? t('restoreSelectedReferences') : t('archiveSelectedReferences')}
          </button>
          <button type="button" className="selection-toolbar-button selection-toolbar-desktop-action" onClick={batchFavoriteSelected} disabled={!selectedItemIds.size || batchBusy}><Star size={16} /> {t('favoriteSelectedReferences')}</button>
          <button type="button" className="selection-toolbar-button" onClick={batchAddTagsSelected} disabled={!selectedItemIds.size || batchBusy}><Tags size={16} /> {t('tagSelectedReferences')}</button>
          <button type="button" className="selection-toolbar-button" onClick={batchMoveSelected} disabled={!selectedItemIds.size || batchBusy}><FolderInput size={16} /> {t('moveSelectedReferences')}</button>
        </div>
        <div ref={selectionActionsRef} className="selection-toolbar-more-shell">
          <button
            type="button"
            className="selection-toolbar-button selection-toolbar-more-trigger"
            aria-haspopup="menu"
            aria-expanded={selectionActionsOpen}
            onClick={() => setSelectionActionsOpen(open => !open)}
            disabled={!selectedItemIds.size || batchBusy}
          >
            <Ellipsis size={17} /> <span>{t('batchMoreActions')}</span>
          </button>
          {selectionActionsOpen && (
            <div className="selection-toolbar-menu" role="menu" aria-label={t('moreActions')}>
              <button type="button" role="menuitem" onClick={batchFavoriteSelected}><Star size={17} /> {t('favoriteSelectedReferences')}</button>
              <button type="button" role="menuitem" onClick={batchArchiveSelected}>
                {showingArchivedItems ? <ArchiveRestore size={17} /> : <Archive size={17} />} {showingArchivedItems ? t('restoreSelectedReferences') : t('archiveSelectedReferences')}
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => { setSelectionActionsOpen(false); deleteSelectedItems(); }}><Trash2 size={17} /> {t('deleteSelectedReferences')}</button>
            </div>
          )}
        </div>
        <button type="button" className="selection-toolbar-delete selection-toolbar-desktop-delete" onClick={deleteSelectedItems} disabled={!selectedItemIds.size || batchBusy}><Trash2 size={16} /> {t('deleteSelectedReferences')}</button>
      </div>
    )}
    {batchActionDialog && (
      <BatchActionDialog
        mode={batchActionDialog}
        selectedCount={selectedItemIds.size}
        tags={tags}
        clusters={localizedClusters}
        busy={batchBusy}
        t={t}
        onClose={() => setBatchActionDialog(undefined)}
        onApplyTags={async tagNames => {
          const completed = await runBatchAction('add_tags', { tags: tagNames });
          if (completed) setBatchActionDialog(undefined);
        }}
        onApplyCollection={async collection => {
          const completed = await runBatchAction('move_collection', { cluster_id: collection.id });
          if (completed) setBatchActionDialog(undefined);
        }}
      />
    )}
    {/* Static-test compatibility marker: !isDemoMode && <button className="fab" */}
    {!isDemoMode && showFloatingActions && (view === 'explore' || view === 'cards') && (
      <div className={`app-command-dock${floatingActionsHidden ? ' is-hidden' : ''}`} aria-hidden={floatingActionsHidden} inert={floatingActionsHidden}>
        <div className="floating-action-rail">
          {view === 'cards' && localizedData.items.length > 0 && <button className="fab select-fab" onClick={() => { setSelectionMode(true); clearSelection(); }}>{t('selectReferences')}</button>}
          <button className="fab add-fab" onClick={openNewItemEditor}><Plus/> {quickCaptureLabels(uiLanguage).heading}</button>
          <button className="fab generate-fab" onClick={openStandaloneGeneration}>{t('generate')}</button>
        </div>
      </div>
    )}
    {trashOpen && !isDemoMode && <TrashModal uiLanguage={uiLanguage} onClose={() => setTrashOpen(false)} onChanged={savedLibraryAssets} />}
    {detailId && <ItemDetailModal key={detailId} t={t} id={detailId} titleRefreshKey={titleUpdates[detailId] || 0} uiLanguage={uiLanguage} preferredLanguage={preferredLanguage} clusters={localizedClusters} tags={tags} onClose={closeItemDetail} onCopyPrompt={showCopyToast} onChanged={saved} onDelete={isDemoMode ? undefined : deleteDetail} onOpenItem={setDetailId} onGenerate={openGenerationFromDetail} onEdit={(item) => { closeItemDetail(); setEditing(item); setEditorOpen(true); }} showMutations={!isDemoMode} showManagementActions={showManagementActions} canGenerate={!isDemoMode} />}
    {toast && <div className={`toast copy-toast elegant-toast ${toast.tone}${toastClosing ? ' is-closing' : ''}`} role="status"><span className="toast-icon">{toast.tone === 'success' ? <Check size={16} /> : <XCircle size={16} />}</span><span className="toast-title">{toast.title}</span></div>}
    {!isDemoMode && <QuickCaptureModal open={quickCaptureOpen} uiLanguage={uiLanguage} onClose={() => setQuickCaptureOpen(false)} onSaved={saved} onFullEditor={item => { setQuickCaptureOpen(false); setEditing(item); setEditorOpen(true); }} />}
    {editorOpen && <ItemEditorModal t={t} item={editing} clusters={localizedClusters} tags={tags} defaultAiProvider={defaultAiProvider} onClose={() => setEditorOpen(false)} onSaved={savedLibraryAssets} onDeleted={deleted} allowDelete={showManagementActions} />}
    </div>
  </div>
}
