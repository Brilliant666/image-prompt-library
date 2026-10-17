import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Sparkles } from 'lucide-react';
import type { UiLanguage } from '../types';
import { captureOrganizerLabels } from '../utils/captureOrganizerLabels';
import { organizerFields, organizerHasChanges, organizerPayload, organizerSettingsRequest, OrganizerSettingsError,
  type CaptureOrganizerConfig, type CaptureOrganizerFields, type OrganizerErrorCode } from '../utils/captureOrganizer';
import './capture-organizer-settings.css';

export default function CaptureOrganizerSettings({ uiLanguage }: { uiLanguage: UiLanguage }) {
  const labels = captureOrganizerLabels(uiLanguage);
  const [saved, setSaved] = useState<CaptureOrganizerConfig>();
  const [form, setForm] = useState<CaptureOrganizerFields>();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | 'check'>();
  const [message, setMessage] = useState<'saved' | 'checked' | 'unconfiguredCheck'>();
  const [error, setError] = useState<OrganizerErrorCode>();
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const section = useRef<HTMLElement>(null);

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++epoch.current;
    controller.current = new AbortController();
    setBusy('load'); setError(undefined); setMessage(undefined);
    try {
      const config = await organizerSettingsRequest('load', undefined, controller.current.signal);
      if (request !== epoch.current) return;
      setSaved(config); setForm(organizerFields(config)); setApiKey('');
    } catch (failure) {
      if (request === epoch.current) setError(failure instanceof OrganizerSettingsError ? failure.code : 'service');
    } finally {
      if (request === epoch.current) { inFlight.current = false; setBusy(undefined); }
    }
  };

  useEffect(() => {
    void load();
    if (new URLSearchParams(location.search).has('capture_organizer')) section.current?.scrollIntoView({ block: 'start' });
    return () => { epoch.current += 1; inFlight.current = false; controller.current?.abort(); };
  }, []);

  const perform = async (operation: 'save' | 'check') => {
    if (inFlight.current || !form || !saved) return;
    inFlight.current = true;
    const request = ++epoch.current;
    controller.current = new AbortController();
    setBusy(operation); setError(undefined); setMessage(undefined);
    try {
      const payload = operation === 'save' ? organizerPayload(form, apiKey, saved) : undefined;
      const config = await organizerSettingsRequest(operation, payload, controller.current.signal);
      if (request !== epoch.current) return;
      setSaved(config); setForm(organizerFields(config));
      setMessage(operation === 'save' ? 'saved' : config.configured ? 'checked' : 'unconfiguredCheck');
    } catch (failure) {
      if (request === epoch.current) setError(failure instanceof OrganizerSettingsError ? failure.code : 'service');
    } finally {
      if (request === epoch.current) {
        // Never retain a submitted secret in the UI after either response outcome.
        if (operation === 'save') setApiKey('');
        inFlight.current = false; setBusy(undefined);
      }
    }
  };

  const change = <K extends keyof CaptureOrganizerFields>(key: K, value: CaptureOrganizerFields[K]) => {
    setForm(current => current ? { ...current, [key]: value } : current);
    setError(undefined); setMessage(undefined);
  };
  const save = (event: FormEvent) => { event.preventDefault(); void perform('save'); };
  const dirty = Boolean(form && saved && organizerHasChanges(form, apiKey, saved));
  const errorText = error ? labels[error === 'model' ? 'modelError' : error === 'timeout' ? 'timeoutError' : error] : '';

  return <section ref={section} className="setting-group capture-organizer-settings" aria-labelledby="capture-organizer-heading">
    <header><h3 id="capture-organizer-heading"><Sparkles size={18} aria-hidden="true" />{labels.title}</h3>
      <p className="muted">{labels.description}</p></header>
    {busy === 'load' && <p className="capture-organizer-feedback" role="status">{labels.loading}</p>}
    {form && saved && <>
      <div className="capture-organizer-status" aria-live="polite">
        <strong>{saved.configured ? labels.configured : labels.incomplete}</strong>
        <span>{saved.enabled ? labels.enabledState : labels.disabledState}</span>
        <span>{saved.last_result ? `${labels.resultLabel}：${labels[saved.last_result.status === 'disabled' ? 'disabledState' : saved.last_result.status]}` : labels.notVerified}</span>
      </div>
      <form onSubmit={save} autoComplete="off">
        <fieldset disabled={Boolean(busy)}>
          <label className="capture-organizer-toggle capture-organizer-enable"><input type="checkbox" checked={form.enabled} onChange={event => change('enabled', event.target.checked)} /><span>{labels.enabled}</span></label>
          <p className="capture-organizer-help">{labels.privacy}</p>
          <label className="capture-organizer-field">Base URL<input type="url" value={form.base_url} placeholder="https://api.example.com/v1" maxLength={2048} spellCheck={false} autoComplete="off" onChange={event => change('base_url', event.target.value)} /></label>
          <label className="capture-organizer-field">API Key<input type="password" value={apiKey} placeholder={saved.has_api_key ? labels.keySaved : labels.keyNew} autoComplete="new-password" spellCheck={false} onChange={event => { setApiKey(event.target.value); setMessage(undefined); setError(undefined); }} /><small>{labels.keyHelp}</small></label>
          <label className="capture-organizer-field">{labels.model}<input value={form.model} placeholder="gpt6-luna" required maxLength={120} spellCheck={false} autoComplete="off" onChange={event => change('model', event.target.value)} /><small>{labels.modelHelp}</small></label>
          <details className="capture-organizer-options"><summary>{labels.advanced}</summary>
            <div>
              <label className="capture-organizer-toggle"><input type="checkbox" checked={form.generate_title} onChange={event => change('generate_title', event.target.checked)} /><span>{labels.generateTitle}</span></label>
              <p className="capture-organizer-help">{labels.titleHelp}</p>
              <label className="capture-organizer-toggle"><input type="checkbox" checked={form.assign_collection} onChange={event => change('assign_collection', event.target.checked)} /><span>{labels.assignCollection}</span></label>
              <label className="capture-organizer-toggle"><input type="checkbox" checked={form.allow_new_collections} disabled={!form.assign_collection} onChange={event => change('allow_new_collections', event.target.checked)} /><span>{labels.allowNew}</span></label>
              <p className="capture-organizer-help">{labels.collectionHelp}</p>
              <label className="capture-organizer-field">{labels.timeout}<input type="number" min="10" max="120" step="1" required value={form.timeout_seconds} onChange={event => change('timeout_seconds', Number(event.target.value))} /></label>
            </div>
          </details>
          <div className="capture-organizer-actions">
            <button type="submit" className="primary">{busy === 'save' ? labels.saving : labels.save}</button>
            <button type="button" className="secondary" disabled={dirty} onClick={() => void perform('check')}>{busy === 'check' ? labels.checking : labels.check}</button>
          </div>
          <p className="capture-organizer-help">{labels.localCheck}</p>
        </fieldset>
      </form>
      <p className="capture-organizer-scope">{labels.scope}</p>
    </>}
    {message && <p className="capture-organizer-feedback" role="status">{labels[message]}</p>}
    {error && <div className="capture-organizer-feedback error" role="alert"><p>{errorText}</p>{!saved && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void load()}>{labels.retry}</button>}</div>}
  </section>;
}
