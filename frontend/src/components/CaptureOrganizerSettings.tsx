import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Sparkles } from 'lucide-react';
import type { UiLanguage } from '../types';
import { captureOrganizerLabels } from '../utils/captureOrganizerLabels';
import { organizerFields, organizerHasChanges, organizerPayload, organizerSettingsRequest, testOrganizerConnection, OrganizerSettingsError,
  type CaptureOrganizerConfig, type CaptureOrganizerFields, type OrganizerErrorCode, type OrganizerConnectionTestResult } from '../utils/captureOrganizer';
import './capture-organizer-settings.css';

export default function CaptureOrganizerSettings({ uiLanguage }: { uiLanguage: UiLanguage }) {
  const labels = captureOrganizerLabels(uiLanguage);
  const [saved, setSaved] = useState<CaptureOrganizerConfig>();
  const [form, setForm] = useState<CaptureOrganizerFields>();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | 'test'>();
  const [message, setMessage] = useState<'saved'>();
  const [testResult, setTestResult] = useState<OrganizerConnectionTestResult>();
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

  const performSave = async () => {
    if (inFlight.current || !form || !saved) return;
    inFlight.current = true;
    const request = ++epoch.current;
    controller.current = new AbortController();
    setBusy('save'); setError(undefined); setMessage(undefined); setTestResult(undefined);
    try {
      const payload = organizerPayload(form, apiKey, saved);
      const config = await organizerSettingsRequest('save', payload, controller.current.signal);
      if (request !== epoch.current) return;
      setSaved(config); setForm(organizerFields(config));
      setMessage('saved');
    } catch (failure) {
      if (request === epoch.current) setError(failure instanceof OrganizerSettingsError ? failure.code : 'service');
    } finally {
      if (request === epoch.current) {
        // Never retain a submitted secret in the UI after either response outcome.
        setApiKey('');
        inFlight.current = false; setBusy(undefined);
      }
    }
  };

  const testConnection = async () => {
    if (inFlight.current || !form || !saved || !saved.configured || organizerHasChanges(form, apiKey, saved)) return;
    inFlight.current = true;
    const request = ++epoch.current;
    controller.current = new AbortController();
    setBusy('test'); setError(undefined); setMessage(undefined); setTestResult(undefined);
    try {
      const result = await testOrganizerConnection(saved, controller.current.signal);
      if (request === epoch.current) setTestResult(result);
    } finally {
      if (request === epoch.current) { inFlight.current = false; setBusy(undefined); }
    }
  };

  const change = <K extends keyof CaptureOrganizerFields>(key: K, value: CaptureOrganizerFields[K]) => {
    setForm(current => current ? { ...current, [key]: value } : current);
    setError(undefined); setMessage(undefined); setTestResult(undefined);
  };
  const save = (event: FormEvent) => { event.preventDefault(); void performSave(); };
  const dirty = Boolean(form && saved && organizerHasChanges(form, apiKey, saved));
  const errorText = error ? labels[error === 'model' ? 'modelError' : error === 'timeout' ? 'timeoutError' : error] : '';
  const testFailures = {
    configuration: labels.testConfiguration, authentication: labels.testAuthentication, model: labels.testModelError,
    rate_limit: labels.testRateLimit, timeout: labels.testTimeout, connection: labels.testConnectionError,
    http_error: labels.testHttpError, invalid_response: labels.testInvalidResponse, busy: labels.testBusy,
  };

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
          <label className="capture-organizer-field">API Key<input type="password" value={apiKey} placeholder={saved.has_api_key ? labels.keySaved : labels.keyNew} autoComplete="new-password" spellCheck={false} onChange={event => { setApiKey(event.target.value); setMessage(undefined); setError(undefined); setTestResult(undefined); }} /><small>{labels.keyHelp}</small></label>
          <label className="capture-organizer-field">{labels.model}<input value={form.model} placeholder="gpt-6-luna" required maxLength={120} spellCheck={false} autoComplete="off" onChange={event => change('model', event.target.value)} /><small>{labels.modelHelp}</small></label>
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
            <button type="button" className="secondary" disabled={dirty || !saved.configured} aria-describedby="capture-organizer-test-help" onClick={() => void testConnection()}>{busy === 'test' ? labels.testing : labels.test}</button>
          </div>
          <p className="capture-organizer-help" id="capture-organizer-test-help">{labels.testHelp}</p>
          {(dirty || !saved.configured) && <p className="capture-organizer-help">{labels.testSaveFirst}</p>}
        </fieldset>
      </form>
      <p className="capture-organizer-scope">{labels.scope}</p>
    </>}
    {message && <p className="capture-organizer-feedback" role="status">{labels[message]}</p>}
    {busy === 'test' && <p className="capture-organizer-feedback" role="status">{labels.testingHint}</p>}
    {testResult && <div className={`capture-organizer-feedback capture-organizer-test-result${testResult.status === 'failed' ? ' error' : ''}`} role="status">
      <strong>{labels.testResultLabel}：{testResult.status === 'succeeded' ? labels.testSucceeded : labels.testFailed}</strong>
      {testResult.status === 'failed' && <p>{testResult.category ? testFailures[testResult.category] : labels.testInvalidResponse}</p>}
      <p>{labels.testModelLabel}：<code>{testResult.model || labels.testModelUnknown}</code> · {labels.testElapsed}：{testResult.elapsed_seconds.toFixed(1)} {labels.seconds}{testResult.http_status !== null ? ` · HTTP ${testResult.http_status}` : ''}</p>
      {testResult.outcome_uncertain && <p>{labels.testUncertain}</p>}
      {testResult.status === 'failed' && <p>{labels.testNoRetry}</p>}
    </div>}
    {error && <div className="capture-organizer-feedback error" role="alert"><p>{errorText}</p>{!saved && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void load()}>{labels.retry}</button>}</div>}
  </section>;
}
