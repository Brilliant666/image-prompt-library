import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import OpenAICompatibleSettings from './OpenAICompatibleSettings';
import BrowserCaptureSettings from './BrowserCaptureSettings';
import CaptureOrganizerSettings from './CaptureOrganizerSettings';
import { X, Settings2, KeyRound, SlidersHorizontal, Bot, ImagePlus, Database, Info } from 'lucide-react';
import { api, isDemoMode } from '../api/client';
import { restoreFocusAfterMotion } from '../hooks/useModalFocus';
import type { AppearancePreset, AppConfig, AppUpdateStatus, CleanupPreview, GenerationProviderStatus, ProviderDeviceAuthStart, AiProvider } from '../types';
import { UI_LANGUAGE_LABELS, type Translator, type UiLanguage } from '../utils/i18n';
import { getPromptCopyLanguageLabel, type PromptCopyLanguage } from '../utils/prompts';
import GeneralSettings from './settings/GeneralSettings';
import AgentSettings from './settings/AgentSettings';
import { readLocalPreferences, saveLocalPreferences, type LocalPreferences } from '../utils/localPreferences';
import './ConfigPanel.css';

export type SettingsSection = 'api' | 'general' | 'agent' | 'capture' | 'data' | 'about';

const LANGUAGE_OPTIONS: PromptCopyLanguage[] = ['origin', 'en', 'zh_hant', 'zh_hans'];
const UI_LANGUAGE_OPTIONS: UiLanguage[] = ['zh_hant', 'zh_hans', 'en'];

function providerStateLabel(provider: GenerationProviderStatus, t: Translator) {
  if (provider.provider === 'openai_compatible' && provider.configured) return t('imageConfigured');
  if (provider.state === 'not_configured') return t('providerStateNotConfigured');
  if (provider.state === 'not_connected') return t('providerStateNotConnected');
  if (provider.state === 'connected') return t('providerStateConnected');
  if (provider.state === 'demo_unavailable') return t('providerStateLocalOnly');
  if (provider.state === 'available') return t('providerStateAvailable');
  if (provider.state === 'expired') return t('providerStateExpired');
  return provider.state || t('providerStateUnavailable');
}

function featureSummary(provider: GenerationProviderStatus, t: Translator) {
  const features = [
    provider.features.text_to_image ? t('providerFeatureTextToImage') : undefined,
    provider.features.text_reference_to_image ? t('providerFeatureTextReferenceToImage') : undefined,
    provider.features.image_edit ? t('providerFeatureImageEdit') : undefined,
    provider.features.manual_result_upload ? t('providerFeatureManualUpload') : undefined,
    provider.features.title_suggestion ? t('providerFeatureTitleSuggestion') : undefined,
  ].filter(Boolean);
  return features.length ? features.join(' · ') : t('providerFeaturesNone');
}

const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function scrollIntoViewRespectingMotion(element: HTMLElement | null) {
  if (!element) return;
  const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  element.scrollIntoView({ behavior, block: 'start' });
}

const providerFallback: GenerationProviderStatus[] = [
  {
    provider: 'openai_codex_oauth_native',
    display_name: 'ChatGPT / Codex OAuth',
    auth_mode: 'codex_oauth_native',
    optional: true,
    configured: false,
    authenticated: false,
    available: false,
    state: 'not_configured',
    reason: 'provider_status_unavailable',
    features: { text_to_image: false, text_reference_to_image: false, image_edit: false, title_suggestion: false },
    max_input_images: 4,
    token_present: false,
    account_id: null,
  },
  {
    provider: 'xai_grok_oauth',
    display_name: 'Grok OAuth · Experimental',
    auth_mode: 'grok_oauth_device',
    optional: true,
    configured: true,
    authenticated: false,
    available: false,
    state: 'not_connected',
    reason: 'provider_status_unavailable',
    features: { text_to_image: false, text_reference_to_image: false, image_edit: false, title_suggestion: false },
    max_input_images: 3,
    token_present: false,
  },
];

export default function ConfigPanel({
  open,
  focusProviders = false,
  focusSection,
  agentWorkspaceProfileId,
  localPreferences,
  onLocalPreferences,
  t,
  onClose,
  uiLanguage,
  onUiLanguage,
  preferredLanguage,
  onPreferredLanguage,
  appearance,
  onAppearance,
  defaultAiProvider,
  onDefaultAiProvider,
  updateStatus,
  onRefreshUpdateStatus,
  onUpdateInstalled,
  onLibraryCleanup = () => undefined,
}: {
  open: boolean;
  focusProviders?: boolean;
  focusSection?: SettingsSection;
  agentWorkspaceProfileId?: string;
  localPreferences?: LocalPreferences;
  onLocalPreferences?: (preferences: LocalPreferences) => void;
  t: Translator;
  onClose: () => void;
  uiLanguage: UiLanguage;
  onUiLanguage: (language: UiLanguage) => void;
  preferredLanguage: PromptCopyLanguage;
  onPreferredLanguage: (language: PromptCopyLanguage) => void;
  appearance: AppearancePreset;
  onAppearance: (appearance: AppearancePreset) => void;
  defaultAiProvider: AiProvider;
  onDefaultAiProvider: (provider: AiProvider) => void;
  updateStatus?: AppUpdateStatus;
  onRefreshUpdateStatus: (refresh?: boolean) => Promise<AppUpdateStatus | undefined>;
  onUpdateInstalled: (targetVersion: string, requiresManualRestart: boolean) => void;
  onLibraryCleanup?: () => void;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('api');
  const [connectionType, setConnectionType] = useState<'api' | 'account'>('api');
  const [browserPreferences, setBrowserPreferences] = useState(readLocalPreferences);
  const [preferencesMessage, setPreferencesMessage] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Partial<Record<SettingsSection, number>>>({});
  const en = uiLanguage === 'en';
  const sections = [
    { id: 'api', label: en ? 'API settings' : 'API 配置', icon: KeyRound },
    { id: 'general', label: en ? 'Preferences' : '习惯配置', icon: SlidersHorizontal },
    { id: 'agent', label: 'Agent', icon: Bot },
    { id: 'capture', label: en ? 'Capture' : '采集与整理', icon: ImagePlus },
    { id: 'data', label: en ? 'Data' : '数据管理', icon: Database },
    { id: 'about', label: en ? 'About' : '关于', icon: Info },
  ] as const;
  const changePreferences = (value: LocalPreferences) => {
    setBrowserPreferences(value);
    const persisted = saveLocalPreferences(value);
    onLocalPreferences?.(value);
    setPreferencesMessage(persisted ? '' : en ? 'Browser storage is unavailable. These changes apply to this session only.' : '浏览器存储暂不可用，本次更改仅在当前会话生效。');
  };
  useLayoutEffect(() => {
    if (!open) return;
    const query = new URLSearchParams(location.search);
    setActiveSection(focusSection || (focusProviders ? 'api' : query.has('capture_pair') || query.has('capture_organizer') ? 'capture' : 'api'));
  }, [open, focusProviders, focusSection]);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollPositions.current[activeSection] || 0;
  }, [activeSection, open]);
  useEffect(() => {
    if (!open || activeSection !== 'capture') return;
    const query = new URLSearchParams(location.search);
    const selector = query.has('capture_organizer') ? '.capture-organizer-settings' : query.has('capture_pair') ? '.browser-capture-settings' : '';
    if (!selector) return;
    const frame = window.requestAnimationFrame(() => drawerRef.current?.querySelector(selector)?.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [open, activeSection]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);
  const [cfg, setCfg] = useState<AppConfig>();
  const [providers, setProviders] = useState<GenerationProviderStatus[]>([]);
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview>();
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string>();
  const [authStarts, setAuthStarts] = useState<Record<string, ProviderDeviceAuthStart | undefined>>({});
  const [providerMessage, setProviderMessage] = useState<string>();
  const [providerActionMessages, setProviderActionMessages] = useState<Record<string, string | undefined>>({});
  const [providerBusy, setProviderBusy] = useState<string>();
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string>();
  const [updateInstalled, setUpdateInstalled] = useState<{ targetVersion: string; requiresManualRestart: boolean; message: string }>();
  const [showActiveUpdateConfirm, setShowActiveUpdateConfirm] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const providersSectionRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeMotionCleanupRef = useRef<(() => void) | undefined>(undefined);
  const cleanupInFlightRef = useRef(false);
  const cleanupRequestRef = useRef(0);
  const providersRequestRef = useRef(0);
  const providerActionRequestRef = useRef(0);

  const loadProviders = useCallback(async () => {
    const requestId = providersRequestRef.current + 1;
    providersRequestRef.current = requestId;
    try {
      const nextProviders = await api.generationProviders();
      if (providersRequestRef.current !== requestId) return;
      setProviders(nextProviders.filter(provider => provider.provider !== 'manual_upload'));
    } catch {
      if (providersRequestRef.current !== requestId) return;
      setProviders(providerFallback);
      setProviderMessage(t('providerStatusLoadFailed'));
    }
  }, [t]);

  const loadCleanupPreview = useCallback(async () => {
    if (isDemoMode || cleanupInFlightRef.current) return;
    cleanupInFlightRef.current = true;
    const requestId = cleanupRequestRef.current + 1;
    cleanupRequestRef.current = requestId;
    setCleanupBusy(true);
    setCleanupPreview(undefined);
    setCleanupMessage(undefined);
    try {
      const preview = await api.cleanupPreview();
      if (cleanupRequestRef.current === requestId) setCleanupPreview(preview);
    } catch (err) {
      if (cleanupRequestRef.current === requestId) setCleanupMessage(err instanceof Error ? err.message : t('cleanupPreviewFailed'));
    } finally {
      if (cleanupRequestRef.current === requestId) {
        cleanupInFlightRef.current = false;
        setCleanupBusy(false);
      }
    }
  }, [t]);

  useEffect(() => {
    if (!open) {
      providersRequestRef.current += 1;
      providerActionRequestRef.current += 1;
      setProviderBusy(undefined);
      return;
    }
    api.config().then(setCfg).catch(() => undefined);
    loadProviders();
  }, [open, loadProviders, loadCleanupPreview]);

  useEffect(() => {
    if (!open) return;
    closeMotionCleanupRef.current?.();
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && !drawerRef.current?.contains(activeElement)) {
      openerRef.current = activeElement;
    }
    const drawer = drawerRef.current;
    const focusDrawer = () => {
      if (!drawer?.isConnected || drawer.contains(document.activeElement)) return;
      const focusedModal = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest('[role="dialog"][aria-modal="true"]') : null;
      if (focusedModal && focusedModal !== drawer && focusedModal.getAttribute('aria-hidden') !== 'true') return;
      if (focusProviders && !focusSection) {
        scrollIntoViewRespectingMotion(providersSectionRef.current);
        providersSectionRef.current?.focus({ preventScroll: true });
      } else {
        closeButtonRef.current?.focus({ preventScroll: true });
      }
    };
    // A first-frame focus can be rejected while the opening visibility
    // transition is still hidden. Retry when this drawer becomes visible,
    // without a timer or moving a focus the user has already placed inside it.
    const onMotionEnd = (event: Event) => { if (event.target === drawer) focusDrawer(); };
    drawer?.addEventListener('transitionend', onMotionEnd);
    drawer?.addEventListener('animationend', onMotionEnd);
    const frame = window.requestAnimationFrame(focusDrawer);
    return () => {
      window.cancelAnimationFrame(frame);
      drawer?.removeEventListener('transitionend', onMotionEnd);
      drawer?.removeEventListener('animationend', onMotionEnd);
    };
  }, [open, focusProviders, focusSection]);

  useEffect(() => () => {
    providersRequestRef.current += 1;
    providerActionRequestRef.current += 1;
    closeMotionCleanupRef.current?.();
  }, []);

  const closePanel = () => {
    providersRequestRef.current += 1;
    providerActionRequestRef.current += 1;
    setProviderBusy(undefined);
    closeMotionCleanupRef.current?.();
    const fallbacks = Array.from(document.querySelectorAll<HTMLElement>('.config-button, .toolbar-search input'));
    // Static compatibility marker: focusFirstAvailable([opener, ...fallbacks]) runs after drawer exit.
    closeMotionCleanupRef.current = restoreFocusAfterMotion(drawerRef.current, [openerRef.current, ...fallbacks]);
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel();
      return;
    }
    if (event.key !== 'Tab' || !drawerRef.current) return;
    const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(element => element.getClientRects().length > 0 || element === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const startProviderAuth = async (providerId: string) => {
    const requestId = providerActionRequestRef.current + 1;
    providerActionRequestRef.current = requestId;
    setProviderBusy(providerId);
    setProviderActionMessages(current => ({ ...current, [providerId]: undefined }));
    try {
      const started = providerId === 'xai_grok_oauth' ? await api.grokOAuthAuthStart() : await api.codexNativeAuthStart();
      if (providerActionRequestRef.current !== requestId) return;
      setAuthStarts(current => ({ ...current, [providerId]: started }));
    } catch (err) {
      if (providerActionRequestRef.current !== requestId) return;
      setProviderActionMessages(current => ({ ...current, [providerId]: err instanceof Error ? err.message : t('oauthStartFailed') }));
    } finally {
      if (providerActionRequestRef.current === requestId) setProviderBusy(undefined);
    }
  };

  const pollProviderAuth = async (providerId: string) => {
    const authStart = authStarts[providerId];
    if (!authStart) return;
    const requestId = providerActionRequestRef.current + 1;
    providerActionRequestRef.current = requestId;
    setProviderBusy(providerId);
    setProviderActionMessages(current => ({ ...current, [providerId]: undefined }));
    try {
      const pollResult = providerId === 'xai_grok_oauth'
        ? await api.grokOAuthAuthPoll({ device_code: authStart.device_code || '' })
        : await api.codexNativeAuthPoll({ device_auth_id: authStart.device_auth_id || '', user_code: authStart.user_code });
      if (providerActionRequestRef.current !== requestId) return;
      if ('status' in pollResult && pollResult.status === 'pending') {
        setProviderActionMessages(current => ({ ...current, [providerId]: t('oauthPending') }));
        return;
      }
      setAuthStarts(current => ({ ...current, [providerId]: undefined }));
      await loadProviders();
    } catch (err) {
      if (providerActionRequestRef.current !== requestId) return;
      setProviderActionMessages(current => ({ ...current, [providerId]: err instanceof Error ? err.message : t('oauthIncomplete') }));
    } finally {
      if (providerActionRequestRef.current === requestId) setProviderBusy(undefined);
    }
  };

  const disconnectProviderAuth = async (providerId: string) => {
    const requestId = providerActionRequestRef.current + 1;
    providerActionRequestRef.current = requestId;
    setProviderBusy(providerId);
    setProviderActionMessages(current => ({ ...current, [providerId]: undefined }));
    try {
      if (providerId === 'xai_grok_oauth') await api.grokOAuthAuthDisconnect();
      else await api.codexNativeAuthDisconnect();
      if (providerActionRequestRef.current !== requestId) return;
      setAuthStarts(current => ({ ...current, [providerId]: undefined }));
      await loadProviders();
    } catch (err) {
      if (providerActionRequestRef.current !== requestId) return;
      setProviderActionMessages(current => ({ ...current, [providerId]: err instanceof Error ? err.message : t('oauthDisconnectFailed') }));
    } finally {
      if (providerActionRequestRef.current === requestId) setProviderBusy(undefined);
    }
  };

  const activeUpdateJobs = (updateStatus?.active_generation_jobs.running || 0) + (updateStatus?.active_generation_jobs.queued || 0);
  const providerActionPending = providerBusy !== undefined;
  const readyProviderCount = providers.filter(provider => provider.can_generate ?? Boolean(provider.available && provider.authenticated && provider.configured)).length;
  const generationSetupLabel = readyProviderCount > 0 ? t('readyProviderCount').replace('${count}', String(readyProviderCount)) : t('optionalNotConnected');
  const updateSetupLabel = updateStatus
      ? (updateStatus.error
       ? t('updateStatusFailed')
      : updateStatus.update_capability === 'source'
        ? t('updateSourceManaged')
        : (updateStatus.update_available ? `${t('updateAvailableVersion')}: ${updateStatus.latest_version}` : `${t('upToDate')} ${t('updateCurrentVersion')}: ${updateStatus.current_version}`))
    : t('providerStateUnavailable');
  const refreshUpdateStatus = () => onRefreshUpdateStatus(false).catch(() => {
    setUpdateMessage(t('updateStatusFailed'));
    return undefined;
  });
  const checkForUpdates = async () => {
    setUpdateCheckBusy(true);
    setUpdateMessage(undefined);
    try {
      await onRefreshUpdateStatus(true);
    } finally {
      setUpdateCheckBusy(false);
    }
  };
  const beginUpdate = async (cancelActiveGenerationJobs: boolean) => {
    if (!updateStatus?.latest_version) return;
    setUpdateBusy(true);
    setUpdateMessage(undefined);
    try {
      const result = await api.startAppUpdate({ target_version: updateStatus.latest_version, cancel_active_generation_jobs: cancelActiveGenerationJobs });
      setShowActiveUpdateConfirm(false);
      setUpdateInstalled({ targetVersion: result.target_version, requiresManualRestart: result.requires_manual_restart, message: result.message });
      setUpdateMessage(undefined);
      await refreshUpdateStatus();
      onUpdateInstalled(result.target_version, result.requires_manual_restart);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('updateInstallFailed');
      if (message.includes('active_generation_jobs')) setShowActiveUpdateConfirm(true);
      setUpdateMessage(message);
    } finally {
      setUpdateBusy(false);
    }
  };
  const requestUpdate = () => {
    if (activeUpdateJobs > 0) {
      setShowActiveUpdateConfirm(true);
      return;
    }
    void beginUpdate(false);
  };
  const restartInstruction = updateInstalled?.requiresManualRestart
    ? t('updateTerminalHelp')
    : t('updateServiceHelp');
  const brokenImageCount = cleanupPreview?.broken_image_records.length || 0;
  const unreferencedFileCount = cleanupPreview?.unreferenced_files.length || 0;
  const cleanupHasWork = brokenImageCount > 0 || unreferencedFileCount > 0;
  const applyCleanup = async () => {
    if (!cleanupHasWork || !cleanupPreview || cleanupInFlightRef.current) return;
    if (!confirm(t('cleanupConfirmation').replace('${broken}', String(brokenImageCount)).replace('${files}', String(unreferencedFileCount)))) return;
    cleanupInFlightRef.current = true;
    const requestId = cleanupRequestRef.current + 1;
    cleanupRequestRef.current = requestId;
    setCleanupBusy(true);
    setCleanupMessage(undefined);
    try {
      const result = await api.applyCleanup({
        preview_token: cleanupPreview.preview_token,
        remove_broken_image_records: brokenImageCount > 0,
        remove_unreferenced_files: unreferencedFileCount > 0,
      });
      if (cleanupRequestRef.current === requestId) {
        setCleanupPreview(result);
        setCleanupMessage(t('cleanupDone').replace('${broken}', String(result.removed_broken_image_records)).replace('${files}', String(result.removed_unreferenced_files)));
        onLibraryCleanup();
      }
    } catch (err) {
      if (cleanupRequestRef.current === requestId) setCleanupMessage(err instanceof Error ? err.message : t('cleanupApplyFailed'));
    } finally {
      if (cleanupRequestRef.current === requestId) {
        cleanupInFlightRef.current = false;
        setCleanupBusy(false);
      }
    }
  };

  return (
    <>
      {open && <div className="drawer-scrim" aria-hidden="true" onClick={closePanel} />}
      <aside ref={drawerRef} id="config-drawer" className={`config-dialog ${open ? 'open' : ''}`}
        role="dialog" aria-modal="true" aria-label={t('config')} aria-hidden={!open} inert={!open} onKeyDown={handleKeyDown}>
        <header className="config-dialog-header">
          <h2><Settings2 size={20} aria-hidden="true" />{t('config')}</h2>
          <div><span className="config-version">{cfg?.version || updateStatus?.current_version || ''}</span>
            <button ref={closeButtonRef} className="panel-close" onClick={closePanel} aria-label={t('closeConfig')} tabIndex={open ? 0 : -1}><X size={20} strokeWidth={2.25} /></button>
          </div>
        </header>
        <div className="config-dialog-body">
          <nav className="config-sidebar" role="tablist" aria-label={en ? 'Settings sections' : '设置分组'} onKeyDown={event => {
            const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const current = sections.findIndex(section => section.id === activeSection);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (current + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + sections.length) % sections.length;
            const next = sections[index].id;
            setActiveSection(next);
            document.getElementById(`settings-tab-${next}`)?.focus();
          }}>
            {sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} role="tab" id={`settings-tab-${id}`}
              aria-controls={`settings-panel-${id}`} aria-selected={activeSection === id} tabIndex={activeSection === id ? 0 : -1}
              className={activeSection === id ? 'active' : ''} onClick={() => setActiveSection(id)}><Icon size={17} aria-hidden="true" /><span>{label}</span></button>)}
          </nav>
          <div className="config-content" ref={scrollRef} onScroll={event => { scrollPositions.current[activeSection] = event.currentTarget.scrollTop; }}>
            <div role="tabpanel" id="settings-panel-api" aria-labelledby="settings-tab-api" hidden={activeSection !== 'api'}>
      <section ref={providersSectionRef} className="setting-group provider-section" tabIndex={-1} aria-labelledby="config-providers-title">
        <h3 id="config-providers-title">{en ? 'Connections and profiles' : '连接与配置'}</h3>
        <p className="muted">{en ? 'Choose a connection type, then manage its named profiles. API keys and account authorization are separate connection methods.' : '先区分连接方式，再管理各自的配置。API Key 接口与账号授权是不同的连接方式。'}</p>
        <div className="settings-connection-tabs" role="group" aria-label={en ? 'Connection settings' : '管理连接配置'}>
          <button type="button" aria-pressed={connectionType === 'api'} className={connectionType === 'api' ? 'active' : ''} onClick={() => setConnectionType('api')}>{en ? 'API key profiles' : 'API Key 配置'}<small>OpenAI Compatible{defaultAiProvider === 'openai_compatible' && <b className="settings-default-badge">{en ? 'Default' : '当前默认'}</b>}</small></button>
          <button type="button" aria-pressed={connectionType === 'account'} className={connectionType === 'account' ? 'active' : ''} onClick={() => setConnectionType('account')}>{en ? 'Account connections' : '账号连接'}<small>ChatGPT / Grok · OAuth{defaultAiProvider !== 'openai_compatible' && <b className="settings-default-badge">{en ? 'Default' : '当前默认'}</b>}</small></button>
        </div>
        <div hidden={connectionType !== 'api'}>
        {open && !isDemoMode && <OpenAICompatibleSettings onSaved={loadProviders} uiLanguage={uiLanguage} isDefaultConnection={defaultAiProvider === 'openai_compatible'} onSetDefaultConnection={() => onDefaultAiProvider('openai_compatible')} />}
        </div>
        <div hidden={connectionType !== 'account'}>
        <p className="muted">{en ? 'The built-in ChatGPT / Codex and Grok connections use account authorization. These are not OpenAI API keys. Manage official or compatible API keys under API key profiles.' : '内置 ChatGPT / Codex 与 Grok 使用账号授权，保留各自的登录流程；它们不是官方 API Key。官方或第三方兼容接口的 Key 请在「API Key 配置」中添加。'}</p>
        <div className="provider-list">
          {providers.filter(provider => ['openai_codex_oauth_native', 'xai_grok_oauth'].includes(provider.provider)).map(provider => {
            const authStart = authStarts[provider.provider];
            const enabled = Boolean(provider.configured && provider.authenticated && provider.available && (provider.features.text_to_image || provider.features.title_suggestion));
            return (
            <article className={`provider-card state-${provider.state}`} key={provider.provider}>
              <div className="provider-card-head">
                <div>
                  <strong>{provider.provider === 'openai_codex_oauth_native' ? 'ChatGPT / Codex OAuth' : provider.display_name}</strong>
                  <span>{provider.optional ? t('providerOptional') : t('providerBuiltIn')}</span>
                </div>
                <b>{providerStateLabel(provider, t)}</b>
              </div>
              <p className="muted">{featureSummary(provider, t)}</p>
              {['openai_codex_oauth_native', 'xai_grok_oauth'].includes(provider.provider) && (
                <div className="provider-actions">
                  {provider.state === 'not_configured' && (
                    <p className="provider-help">{t('providerClientHelp')}</p>
                  )}
                  {provider.account_id && <p className="provider-help">{t('providerAccount')}: <code>{provider.account_id}</code></p>}
                  {authStart && (
                    <div className="provider-auth-box">
                      <p><a href={authStart.verification_url || authStart.verification_uri_complete || authStart.verification_uri} target="_blank" rel="noreferrer">{t('providerVerification')}</a> <code>{authStart.user_code}</code></p>
                      <button className="secondary" onClick={() => pollProviderAuth(provider.provider)} disabled={providerActionPending}>{t('checkAuthorization')}</button>
                    </div>
                  )}
                  {!provider.authenticated && !authStart && (
                    <button className="secondary" onClick={() => startProviderAuth(provider.provider)} disabled={isDemoMode || provider.state === 'not_configured' || providerActionPending}>{t('connect')}</button>
                  )}
                  {provider.authenticated && <button className="secondary" onClick={() => disconnectProviderAuth(provider.provider)} disabled={providerActionPending}>{t('disconnect')}</button>}
                  {defaultAiProvider === provider.provider ? <span className="settings-default-badge">{en ? 'Current default connection' : '当前默认连接'}</span> : <button type="button" className="secondary" disabled={!enabled || providerActionPending} onClick={() => onDefaultAiProvider(provider.provider as AiProvider)}>{en ? 'Use as default connection' : '设为默认连接'}</button>}
                  {providerActionMessages[provider.provider] && <p className="provider-message" role="status">{providerActionMessages[provider.provider]}</p>}
                </div>
              )}
            </article>
          );})}
        </div>
        </div>
        {providerMessage && <p className="provider-message">{providerMessage}</p>}
      </section>

            </div>
            <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={activeSection !== 'general'}>
              <GeneralSettings value={localPreferences || browserPreferences} onChange={changePreferences} uiLanguage={uiLanguage} />
              {preferencesMessage && <p className="provider-message" role="status">{preferencesMessage}</p>}
      <section className="setting-group">
        <h3>{t('uiLanguage')}</h3>
        <div className="segmented-control" aria-label={t('uiLanguage')}>
          {UI_LANGUAGE_OPTIONS.map(language => (
            <button
              key={language}
              className={uiLanguage === language ? 'active' : ''}
              onClick={() => onUiLanguage(language)}
            >
              {UI_LANGUAGE_LABELS[language]}
            </button>
          ))}
        </div>
      </section>

      <section className="setting-group">
        <h3>{t('promptCopyLanguage')}</h3>
        <p className="muted">{t('promptCopyLanguageHelp')}</p>
        <div className="segmented-control prompt-copy-language-control" aria-label={t('preferredPromptLanguage')}>
          {LANGUAGE_OPTIONS.map(language => (
            <button
              key={language}
              className={preferredLanguage === language ? 'active' : ''}
              onClick={() => onPreferredLanguage(language)}
            >
              {getPromptCopyLanguageLabel(language, uiLanguage)}
            </button>
          ))}
        </div>
      </section>

      <section className="setting-group">
        <h3>{t('appearance')}</h3>
        <p className="muted">{t('appearanceHelp')}</p>
        <div className="appearance-control" role="radiogroup" aria-label={t('appearance')}>
          {([
            ['pure_white', 'appearancePureWhite'],
            ['gallery_vermilion', 'appearanceGalleryVermilion'],
            ['pine_archive', 'appearancePineArchive'],
            ['aubergine_ink', 'appearanceAubergineInk'],
          ] as const).map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={appearance === preset}
              className={appearance === preset ? 'active' : ''}
              onClick={() => onAppearance(preset)}
            >
              <span className={`appearance-swatch appearance-swatch-${preset}`} aria-hidden="true" />
              <span>{t(label)}</span>
            </button>
          ))}
        </div>
      </section>

            </div>
            <div role="tabpanel" id="settings-panel-agent" aria-labelledby="settings-tab-agent" hidden={activeSection !== 'agent'}>
              {open && !isDemoMode ? <AgentSettings workspaceProfileId={agentWorkspaceProfileId} uiLanguage={uiLanguage} active={activeSection === 'agent'} /> : <p className="muted">{en ? 'Agent settings are available in the local application.' : 'Agent 配置请在本机应用中使用。'}</p>}
            </div>
            <div role="tabpanel" id="settings-panel-capture" aria-labelledby="settings-tab-capture" hidden={activeSection !== 'capture'}>
              {open && !isDemoMode && <BrowserCaptureSettings uiLanguage={uiLanguage} />}
              {open && !isDemoMode && <CaptureOrganizerSettings uiLanguage={uiLanguage} />}
              {isDemoMode && <p className="muted">{en ? 'Capture settings are available in the local application.' : '采集与整理配置请在本机应用中使用。'}</p>}
            </div>
            <div role="tabpanel" id="settings-panel-data" aria-labelledby="settings-tab-data" hidden={activeSection !== 'data'}>
      {!isDemoMode && <section className="setting-group">
        <h3>{en ? 'Library and portable backups' : '图库与可移植备份'}</h3>
        <p className="muted">{en ? 'Library assets, generation history and Agent conversations share the same library. Provider credentials stay outside the backup.' : '正式资产、生成历史与 Agent 会话保存在同一图库。供应商凭据仍在图库之外，不进入备份。'}</p>
        <p><code>{cfg?.library_path || '—'}</code></p>
        <p className="muted">{en ? 'Use the existing local command to inspect backup and restore options:' : '使用现有本地命令查看备份、恢复选项：'}</p>
        <code>image-prompt-library backup --help</code><br/><code>image-prompt-library restore --help</code>
      </section>}
      {!isDemoMode && (
        <section className="setting-group cleanup-section">
           <h3>{t('cleanupTitle')}</h3>
           <p className="muted">{t('cleanupHelp')}</p>
           {!cleanupPreview && <p className="cleanup-precheck-state" role="status">{t('cleanupPrecheck')}</p>}
           {cleanupPreview && cleanupHasWork && (
            <div className="cleanup-counts">
              <span><strong>{brokenImageCount}</strong> {t('brokenImageRecords')}</span>
              <span><strong>{unreferencedFileCount}</strong> {t('unreferencedFiles')}</span>
            </div>
          )}
          {cleanupPreview && !cleanupHasWork && <p className="cleanup-empty-state" role="status">{t('cleanupNoWork')}</p>}
          <div className="provider-actions">
             <button className="secondary" onClick={loadCleanupPreview} disabled={cleanupBusy}>{cleanupBusy ? t('checking') : t('previewCleanup')}</button>
             {cleanupPreview && cleanupHasWork && <button className="danger" onClick={applyCleanup} disabled={cleanupBusy}>{t('applyCleanup')}</button>}
          </div>
          {cleanupMessage && <p className="provider-message">{cleanupMessage}</p>}
        </section>
      )}

            </div>
            <div role="tabpanel" id="settings-panel-about" aria-labelledby="settings-tab-about" hidden={activeSection !== 'about'}>
      <section className="setting-group"><h3>{en ? 'Source and licenses' : '来源与许可证'}</h3>
        <p><a href="https://github.com/Brilliant666/image-prompt-library" target="_blank" rel="noreferrer">Brilliant666/image-prompt-library</a> · AGPL-3.0-or-later</p>
        <p className="muted">{en ? 'Based on EddieTYP/image-prompt-library. Workspace interactions adapted from CookSleep/gpt_image_playground under MIT.' : '基于 EddieTYP/image-prompt-library；画廊、Agent 与分组设置交互适配自 CookSleep/gpt_image_playground（MIT）。'}</p>
        <p className="muted">Playground: <code>1e9d5af60aadd9117a835cc2da43908b8e3370dd</code></p>
      </section>
      <section className="setting-group app-update-section">
         <h3>{t('appUpdate')}</h3>
         {!updateStatus && <p className="muted">{t('updateChecking')}</p>}
        {updateInstalled ? (
          <div className="update-card update-complete-card" role="status">
             <p className="update-kicker">{t('updateInstalled')}</p>
             <p className="update-title">{updateInstalled.requiresManualRestart ? <>{t('updateRestartRequired')} <code>{updateInstalled.targetVersion}</code>.</> : updateInstalled.message}</p>
            <p className="provider-help">{restartInstruction}</p>
            {updateInstalled.requiresManualRestart && <p className="update-command-hint"><code>image-prompt-library start</code></p>}
          </div>
        ) : updateStatus?.error ? (
           <p className="muted">{t('updateStatusFailed')}</p>
        ) : updateStatus?.update_capability === 'source' ? (
           <p className="muted">{t('updateSourceManaged')}</p>
        ) : updateStatus?.update_capability === 'command_only' && updateStatus.update_available ? (
          <div className="update-card">
             <p className="muted"><strong>{t('updateAvailableVersion')}</strong>: <code>{updateStatus.latest_version}</code></p>
             <p className="muted">{t('updatePowerShellHint')}</p>
            {updateStatus.update_command && <p className="update-command-hint"><code>{updateStatus.update_command}</code></p>}
             {updateStatus.release_url && <a className="secondary" href={updateStatus.release_url} target="_blank" rel="noreferrer">{t('viewRelease')}</a>}
          </div>
        ) : updateStatus && !updateStatus.update_available ? (
           <p className="muted">{t('upToDate')} {t('updateCurrentVersion')}: <code>{updateStatus.current_version}</code></p>
        ) : updateStatus?.update_available && (
          <div className="update-card">
             <p className="muted"><strong>{t('updateAvailableVersion')}</strong>: <code>{updateStatus.latest_version}</code></p>
             <p className="muted">{t('updateCurrentVersion')}: <code>{updateStatus.current_version}</code></p>
            {showActiveUpdateConfirm ? (
              <div className="update-warning">
                 <p>{t('updateRequiresRestart')}</p>
                 <p>{t('updateActiveJobs').replace('${running}', String(updateStatus.active_generation_jobs.running)).replace('${queued}', String(updateStatus.active_generation_jobs.queued))}</p>
                <div className="provider-actions">
                   <button className="secondary" onClick={() => setShowActiveUpdateConfirm(false)} disabled={updateBusy}>{t('updateLater')}</button>
                   <button className="danger" onClick={() => beginUpdate(true)} disabled={updateBusy}>{t('cancelJobsAndUpdate')}</button>
                </div>
              </div>
            ) : (
              <div className="provider-actions">
               <button className="primary" onClick={requestUpdate} disabled={updateBusy}>{updateBusy ? t('installing') : t('updateAndRestart')}</button>
               {updateStatus.release_url && <a className="secondary" href={updateStatus.release_url} target="_blank" rel="noreferrer">{t('viewRelease')}</a>}
              </div>
            )}
            <p className="provider-help">{updateStatus.requires_manual_restart ? t('updateTerminalHelp') : t('updateServiceHelp')}</p>
          </div>
        )}
        {!isDemoMode && !updateInstalled && updateStatus?.update_capability !== 'source' && (
          <div className="provider-actions">
            <button className="secondary" onClick={checkForUpdates} disabled={!updateStatus || updateBusy || updateCheckBusy}>
              {updateCheckBusy ? t('updateChecking') : t('checkForUpdates')}
            </button>
          </div>
        )}
        {updateMessage && <p className="provider-message">{updateMessage}</p>}
      </section>

      {!isDemoMode && (
        <section className="setting-group local-setup-section">
          <h3>{t('systemInformation')}</h3>
          <p className="muted">{t('localSetupHelp')}</p>
          <dl className="local-setup-list">
            <div><dt>{t('appVersion')}</dt><dd><code>{cfg?.version || updateStatus?.current_version || 'unknown'}</code></dd></div>
            <div><dt>{t('databasePath')}</dt><dd><code>{cfg?.database_path || 'unavailable'}</code></dd></div>
            <div><dt>{t('updateStatusLabel')}</dt><dd>{updateSetupLabel}</dd></div>
            <div><dt>{t('generationStatusLabel')}</dt><dd>{generationSetupLabel}</dd></div>
          </dl>
          <div className="local-setup-commands" aria-label={t('setupCommands')}>
            <p><span>{t('statusCommandHelp')}</span><code>image-prompt-library status</code></p>
            <p><span>{t('doctorCommandHelp')}</span><code>image-prompt-library doctor</code></p>
            <p><span>{t('firstRunSampleHelp')}</span><code>image-prompt-library sample-data en</code></p>
          </div>
        </section>
      )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
