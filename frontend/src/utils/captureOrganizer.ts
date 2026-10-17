export interface CaptureOrganizerFields {
  enabled: boolean;
  base_url: string;
  model: string;
  timeout_seconds: number;
  generate_title: boolean;
  assign_collection: boolean;
  allow_new_collections: boolean;
}

export type OrganizerResultStatus = 'disabled' | 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'skipped';
export interface CaptureOrganizerConfig extends CaptureOrganizerFields {
  has_api_key: boolean;
  configured: boolean;
  last_result?: { status: OrganizerResultStatus; category: string; completed_at: string | null };
}

export const organizerDefaults: CaptureOrganizerFields = {
  enabled: false, base_url: '', model: 'gpt6-luna', timeout_seconds: 60,
  generate_title: true, assign_collection: true, allow_new_collections: true,
};

export type OrganizerErrorCode = 'url' | 'replacement_key' | 'model' | 'timeout' | 'options' | 'connection' | 'validation' | 'authorization' | 'service';
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
    generate_title: config.generate_title, assign_collection: config.assign_collection, allow_new_collections: config.allow_new_collections };
}

/** Empty keys are omitted. A key must never silently follow a changed endpoint. */
export function organizerPayload(form: CaptureOrganizerFields, apiKey: string, saved: CaptureOrganizerConfig): CaptureOrganizerFields & { api_key?: string } {
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
  return { ...fields, ...(key ? { api_key: key } : {}) };
}

export function organizerHasChanges(form: CaptureOrganizerFields, key: string, saved: CaptureOrganizerConfig): boolean {
  return Boolean(key) || JSON.stringify(organizerFields(form)) !== JSON.stringify(organizerFields(saved));
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
