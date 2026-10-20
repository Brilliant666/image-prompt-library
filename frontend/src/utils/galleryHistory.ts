import type { GenerationJobRecord } from '../types';

const FILTER_KEY = 'image-prompt-library:gallery-filter:v1';
const HISTORY_KEY = 'image-prompt-library:gallery-history:v1';
const STATUSES = ['queued', 'running', 'succeeded', 'accepted', 'failed', 'cancelled', 'discarded'];
const FILTERS = ['', 'active', 'successful', 'completed', ...STATUSES];
const VISIBLE_FILTERS = ['', 'active', 'successful', 'accepted', 'failed'];
const MAX_JOBS = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE = 30 * 60 * 1000;

export interface GalleryHistory { jobs: GenerationJobRecord[]; total: number; savedAt: number }

export function readGalleryFilter(): string {
  try {
    const value = localStorage.getItem(FILTER_KEY);
    if (value !== null && VISIBLE_FILTERS.includes(value)) return value;
    if (value === 'queued' || value === 'running') return 'active';
    if (value === 'succeeded') return 'successful';
  } catch { /* Browser storage may be unavailable. */ }
  return '';
}

export function saveGalleryFilter(value: string): void {
  if (!VISIBLE_FILTERS.includes(value)) return;
  try { localStorage.setItem(FILTER_KEY, value); } catch { /* Filtering still works without persistence. */ }
}

export function galleryFilterStatuses(filter: string): string | undefined {
  if (filter === 'active') return 'queued,running';
  if (filter === 'successful') return 'succeeded,accepted';
  if (filter === 'completed') return 'succeeded,accepted,failed';
  return STATUSES.includes(filter) ? filter : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function label(value: unknown, max = 512): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/^\s*(?:data|blob):/i.test(value);
}
function date(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function localImagePath(value: unknown): value is string {
  return label(value, 2048) && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(value)
    && !/[?#]/.test(value) && !value.split(/[\\/]/).includes('..');
}

// Display-only projection. Never cache input images, metadata, credentials or the full recipe.
function cardJob(value: unknown): GenerationJobRecord | undefined {
  if (!record(value) || !label(value.id) || !label(value.provider, 128)
    || typeof value.prompt_text !== 'string' || typeof value.status !== 'string' || !STATUSES.includes(value.status)
    || !date(value.created_at) || !date(value.updated_at)) return;
  const job: GenerationJobRecord = {
    id: value.id, provider: value.provider, prompt_text: value.prompt_text,
    status: value.status, created_at: value.created_at, updated_at: value.updated_at,
  };
  if (label(value.mode, 128)) job.mode = value.mode;
  if (label(value.model)) job.model = value.model;
  if (typeof value.edited_prompt_text === 'string') job.edited_prompt_text = value.edited_prompt_text;
  if (localImagePath(value.result_path)) job.result_path = value.result_path;
  for (const key of ['result_width', 'result_height'] as const) {
    const size = value[key];
    if (typeof size === 'number' && Number.isSafeInteger(size) && size > 0) job[key] = size;
  }
  for (const key of ['started_at', 'completed_at', 'accepted_at', 'discarded_at', 'cancelled_at'] as const) {
    if (date(value[key])) job[key] = value[key];
  }
  if (record(value.parameters)) {
    const parameters: Record<string, string> = {};
    const { quality, compatible_profile_name: name } = value.parameters;
    if (typeof quality === 'string' && ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(quality)) parameters.quality = quality;
    if (label(name, 256)) parameters.compatible_profile_name = name;
    if (Object.keys(parameters).length) job.parameters = parameters;
  }
  return job;
}

function matchesFilter(job: GenerationJobRecord, filter: string): boolean {
  const statuses = galleryFilterStatuses(filter);
  return !statuses || statuses.split(',').includes(job.status);
}
function validScope(scope: string): boolean { return typeof scope === 'string' && !!scope.trim() && scope.length <= 4096; }

export function clearGalleryHistory(): void {
  try { sessionStorage.removeItem(HISTORY_KEY); } catch { /* Best effort; never interfere with the live gallery. */ }
}

export function readGalleryHistory(scope: string, filter: string): GalleryHistory | undefined {
  if (!validScope(scope) || !FILTERS.includes(filter)) return;
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    if (!raw) return;
    if (raw.length * 2 > MAX_BYTES) { clearGalleryHistory(); return; }
    const snapshot: unknown = JSON.parse(raw);
    if (!record(snapshot) || snapshot.version !== 1 || snapshot.scope !== scope || snapshot.filter !== filter) return;
    const { jobs, total, savedAt } = snapshot;
    if (!Array.isArray(jobs) || jobs.length > MAX_JOBS || typeof total !== 'number'
      || !Number.isSafeInteger(total) || total < jobs.length || typeof savedAt !== 'number'
      || !Number.isFinite(savedAt) || savedAt > Date.now() || Date.now() - savedAt > MAX_AGE) {
      clearGalleryHistory(); return;
    }
    const safeJobs = jobs.map(cardJob);
    if (safeJobs.some(job => !job || !matchesFilter(job, filter))) { clearGalleryHistory(); return; }
    const result = safeJobs as GenerationJobRecord[];
    if (new Set(result.map(job => job.id)).size !== result.length) { clearGalleryHistory(); return; }
    return { jobs: result, total, savedAt };
  } catch { clearGalleryHistory(); return; }
}

export function saveGalleryHistory(scope: string, filter: string, value: Pick<GalleryHistory, 'jobs' | 'total'>): void {
  if (!validScope(scope) || !FILTERS.includes(filter)) return;
  try {
    if (!Array.isArray(value.jobs) || !Number.isSafeInteger(value.total) || value.total < value.jobs.length) return;
    const jobs = value.jobs.slice(0, MAX_JOBS).map(cardJob);
    if (jobs.some(job => !job || !matchesFilter(job, filter))) return;
    const safeJobs = jobs as GenerationJobRecord[];
    if (new Set(safeJobs.map(job => job.id)).size !== safeJobs.length) return;
    const snapshot = JSON.stringify({ version: 1, scope, filter, jobs, total: value.total, savedAt: Date.now() });
    // Web Storage stores UTF-16 strings; bound the actual string rather than only its UTF-8 size.
    if (snapshot.length * 2 > MAX_BYTES) { clearGalleryHistory(); return; }
    sessionStorage.setItem(HISTORY_KEY, snapshot);
  } catch { clearGalleryHistory(); }
}
