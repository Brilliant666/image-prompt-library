import type { ApiNetworkConfig, ApiNetworkMode, ApiNetworkUpdate } from '../types';
import { apiNetworkIssue, apiNetworkMode, apiNetworkPayload, safeProxyEndpoint, type ApiNetworkDraft } from './apiNetwork';

export interface CaptureOrganizerFields {
  enabled: boolean;
  base_url: string;
  model: string;
  timeout_seconds: number;
  generate_title: boolean;
  assign_collection: boolean;
  allow_new_collections: boolean;
  network_mode?: ApiNetworkMode;
}

export type OrganizerResultStatus = 'disabled' | 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'skipped';
export interface CaptureOrganizerConfig extends CaptureOrganizerFields, ApiNetworkConfig {
  has_api_key: boolean;
  configured: boolean;
  last_result?: { status: OrganizerResultStatus; category: string; completed_at: string | null };
}

export const organizerDefaults: CaptureOrganizerFields = {
  enabled: false, base_url: '', model: 'gpt-6-luna', timeout_seconds: 60,
  generate_title: true, assign_collection: true, allow_new_collections: true,
  network_mode: 'direct',
};

export type OrganizerErrorCode = 'url' | 'replacement_key' | 'model' | 'timeout' | 'options' | 'connection' | 'validation' | 'authorization' | 'service' | 'proxy_required' | 'proxy_url';
export class OrganizerSettingsError extends Error {
  constructor(public readonly code: OrganizerErrorCode) { super(code); }
}

function canonicalEndpoint(value: string): string {
  if (!value.trim()) return '';
  try {
    if (/[\x00-\x20]/.test(value.trim())) throw new Error();
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    if (['/chat/completions', '/responses', '/images/'].some(endpoint => url.pathname.includes(endpoint))) throw new Error();
    return url.toString().replace(/\/+$/, '').replace(/(?:\/v1)+$/, '');
  } catch { throw new OrganizerSettingsError('url'); }
}

/** Only these fields may enter React state; response extras and secrets are discarded. */
export function readOrganizerConfig(value: unknown): CaptureOrganizerConfig {
  if (!value || typeof value !== 'object') throw new OrganizerSettingsError('service');
  const input = value as Record<string, unknown>;
  const result: CaptureOrganizerConfig = {
    enabled: input.enabled === true,
    base_url: typeof input.base_url === 'string' ? input.base_url : '',
    model: typeof input.model === 'string' ? input.model : organizerDefaults.model,
    timeout_seconds: typeof input.timeout_seconds === 'number' ? input.timeout_seconds : organizerDefaults.timeout_seconds,
    generate_title: input.generate_title !== false,
    assign_collection: input.assign_collection !== false,
    allow_new_collections: input.allow_new_collections !== false,
    has_api_key: input.has_api_key === true,
    configured: input.configured === true,
    network_mode: apiNetworkMode(input.network_mode),
    proxy_url_present: input.proxy_url_present === true,
    proxy_endpoint: safeProxyEndpoint(input.proxy_endpoint),
  };
  if (input.last_result && typeof input.last_result === 'object') {
    const last = input.last_result as Record<string, unknown>;
    const statuses: readonly unknown[] = ['disabled', 'pending', 'running', 'succeeded', 'failed', 'uncertain', 'skipped'];
    if (statuses.includes(last.status)) result.last_result = {
      status: last.status as OrganizerResultStatus,
      // Never display arbitrary provider error text, even through a supposedly safe field.
      category: typeof last.category === 'string' && /^[a-z_]{1,64}$/.test(last.category) ? last.category : '',
      completed_at: typeof last.completed_at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+Z-]+$/.test(last.completed_at) ? last.completed_at : null,
    };
  }
  return result;
}

export function organizerFields(config: CaptureOrganizerFields): CaptureOrganizerFields {
  return { enabled: config.enabled, base_url: config.base_url, model: config.model, timeout_seconds: config.timeout_seconds,
    generate_title: config.generate_title, assign_collection: config.assign_collection, allow_new_collections: config.allow_new_collections,
    network_mode: apiNetworkMode(config.network_mode) };
}

/** Empty keys are omitted. A key must never silently follow a changed endpoint. */
export function organizerPayload(form: CaptureOrganizerFields, apiKey: string, saved: CaptureOrganizerConfig, network: ApiNetworkDraft = { proxyUrl: '', removeProxy: false }): CaptureOrganizerFields & ApiNetworkUpdate & { api_key?: string } {
  const fields = organizerFields(form);
  fields.base_url = fields.base_url.trim();
  fields.model = fields.model.trim();
  const endpoint = canonicalEndpoint(fields.base_url);
  if (fields.enabled && !endpoint) throw new OrganizerSettingsError('url');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(fields.model)) throw new OrganizerSettingsError('model');
  if (!Number.isInteger(fields.timeout_seconds) || fields.timeout_seconds < 10 || fields.timeout_seconds > 120) throw new OrganizerSettingsError('timeout');
  if (fields.enabled && !fields.generate_title && !fields.assign_collection) throw new OrganizerSettingsError('options');
  const key = apiKey.trim();
  if (saved.has_api_key && endpoint !== canonicalEndpoint(saved.base_url) && !key) throw new OrganizerSettingsError('replacement_key');
  const networkMode = apiNetworkMode(fields.network_mode);
  const issue = apiNetworkIssue(networkMode, network, saved.proxy_url_present === true);
  if (issue) throw new OrganizerSettingsError(issue);
  return { ...fields, ...apiNetworkPayload(networkMode, network), ...(key ? { api_key: key } : {}) };
}

export function organizerHasChanges(form: CaptureOrganizerFields, key: string, saved: CaptureOrganizerConfig, network: ApiNetworkDraft = { proxyUrl: '', removeProxy: false }): boolean {
  return Boolean(key || network.proxyUrl || network.removeProxy) || JSON.stringify(organizerFields(form)) !== JSON.stringify(organizerFields(saved));
}

/** Same-origin local settings only. This never calls the configured third-party endpoint. */
export async function organizerSettingsRequest(operation: 'load' | 'save' | 'check', payload?: ReturnType<typeof organizerPayload>, signal?: AbortSignal): Promise<CaptureOrganizerConfig> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  try {
    const response = await fetch(`/api/capture-organizer/${operation === 'check' ? 'check' : 'config'}`, {
      method: operation === 'load' ? 'GET' : operation === 'save' ? 'PUT' : 'POST',
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      ...(operation === 'save' ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) throw new OrganizerSettingsError([401, 403].includes(response.status) ? 'authorization' : [400, 409, 422].includes(response.status) ? 'validation' : 'service');
    return readOrganizerConfig(await response.json());
  } catch (error) {
    if (error instanceof OrganizerSettingsError) throw error;
    throw new OrganizerSettingsError('connection');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

const ORGANIZER_TEST_CATEGORIES = ['configuration', 'authentication', 'model', 'rate_limit', 'timeout', 'connection', 'http_error', 'invalid_response', 'busy'] as const;
export type OrganizerTestCategory = typeof ORGANIZER_TEST_CATEGORIES[number];
export interface OrganizerConnectionTestResult {
  status: 'succeeded' | 'failed';
  model: string;
  elapsed_seconds: number;
  category: OrganizerTestCategory | '';
  http_status: number | null;
  outcome_uncertain?: boolean;
}

export function organizerTestTimeoutMs(savedTimeoutSeconds: number): number {
  const seconds = Number.isInteger(savedTimeoutSeconds) && savedTimeoutSeconds >= 10 && savedTimeoutSeconds <= 120 ? savedTimeoutSeconds : organizerDefaults.timeout_seconds;
  return (seconds + 10) * 1000;
}

/** Test responses are separate from actual capture-organization results. */
export function readOrganizerTestResult(value: unknown): OrganizerConnectionTestResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (!['succeeded', 'failed'].includes(String(input.status)) || typeof input.model !== 'string'
    || (input.model !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(input.model))
    || typeof input.elapsed_seconds !== 'number' || !Number.isFinite(input.elapsed_seconds) || input.elapsed_seconds < 0
    || (input.http_status !== null && !(typeof input.http_status === 'number' && Number.isInteger(input.http_status) && input.http_status >= 100 && input.http_status <= 599))) return undefined;
  if (input.status === 'succeeded') {
    if (!input.model || input.category !== '' || typeof input.http_status !== 'number' || input.http_status < 200 || input.http_status > 299) return undefined;
  } else if (!(ORGANIZER_TEST_CATEGORIES as readonly unknown[]).includes(input.category)) return undefined;
  return { status: input.status as 'succeeded' | 'failed', model: input.model, elapsed_seconds: input.elapsed_seconds,
    category: input.category as OrganizerTestCategory | '', http_status: input.http_status as number | null,
    ...(input.status === 'failed' && ['timeout', 'connection', 'invalid_response'].includes(String(input.category)) ? { outcome_uncertain: true } : {}),
  };
}

/** One explicit test of saved configuration. Never forwards form values, keys or library data. */
export async function testOrganizerConnection(saved: CaptureOrganizerConfig, signal?: AbortSignal): Promise<OrganizerConnectionTestResult> {
  if (!saved.configured || !saved.has_api_key) return {
    status: 'failed', model: saved.model, elapsed_seconds: 0, category: 'configuration', http_status: null,
  };
  const started = performance.now();
  const controller = new AbortController();
  let deadlineReached = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  const abortFailure = new Error('connection_test_interrupted');
  let rejectOnAbort: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(abortFailure);
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const failed = (category: OrganizerTestCategory, httpStatus: number | null = null, uncertain = true): OrganizerConnectionTestResult => ({
    status: 'failed', model: saved.model, elapsed_seconds: Math.max(0, (performance.now() - started) / 1000),
    category, http_status: httpStatus, outcome_uncertain: uncertain,
  });
  try {
    timeout = setTimeout(() => { deadlineReached = true; abort(); }, organizerTestTimeoutMs(saved.timeout_seconds));
    const response = await Promise.race([fetch('/api/capture-organizer/test', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
    }), interruption]);
    // An outer HTTP error is from the local route, not an upstream model status.
    if (!response.ok) return failed(response.status === 403 ? 'configuration' : 'http_error');
    let body: unknown;
    try { body = await Promise.race([response.json(), interruption]); }
    catch (error) { if (error instanceof SyntaxError) return failed('invalid_response'); throw error; }
    return readOrganizerTestResult(body) || failed('invalid_response');
  } catch {
    return failed(deadlineReached ? 'timeout' : 'connection');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}
