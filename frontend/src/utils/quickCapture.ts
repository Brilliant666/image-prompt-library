export type CaptureLanguage = 'auto' | 'en' | 'zh_hans' | 'zh_hant' | 'und';
export interface CaptureLanguageResult { language: Exclude<CaptureLanguage, 'auto'>; uncertain: boolean; reason: string }
export interface CaptureDraft {
  file: File;
  prompt_text: string;
  language: CaptureLanguage;
  title?: string;
  source_name?: string;
  source_url?: string;
  notes?: string;
}
export interface CaptureRequest extends CaptureDraft { request_id: string }
export const CAPTURE_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
export const CAPTURE_MAX_BYTES = 30 * 1024 * 1024;

// This is early feedback only. The server decodes the actual bytes and determines format/dimensions.
export function captureImageError(files: readonly Pick<File, 'type' | 'name' | 'size'>[]): 'oneImage' | 'emptyImage' | 'imageType' | 'imageTooLarge' | undefined {
  if (files.length !== 1) return 'oneImage';
  const file = files[0];
  if (!file.size) return 'emptyImage';
  if (file.size > CAPTURE_MAX_BYTES) return 'imageTooLarge';
  if (!CAPTURE_IMAGE_ACCEPT.split(',').includes(file.type.toLowerCase()) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) return 'imageType';
}

export function captureFormData(payload: CaptureRequest): FormData {
  const body = new FormData();
  body.set('file', payload.file);
  body.set('request_id', payload.request_id);
  // Multipart string fields normalize bare LF to CRLF. A JSON string keeps the
  // user's exact line endings and whitespace through the browser's serializer.
  body.set('prompt_text_json', JSON.stringify(payload.prompt_text));
  body.set('language', payload.language);
  for (const key of ['title', 'source_name', 'source_url', 'notes'] as const) {
    if (payload[key] !== undefined) body.set(key, payload[key]);
  }
  return body;
}

export function captureErrorAllowsEdit(status?: number): boolean {
  // Only definitive validation failures allow a new payload/key. A timeout, malformed
  // response or server error may follow a committed capture and must retain the key.
  return status !== undefined && [400, 413, 415, 422].includes(status);
}

/** One explicit save, including retries after an uncertain response, owns one UUID. */
export class CaptureSubmission {
  private snapshot?: CaptureRequest;
  private busy = false;
  private completed = false;

  get locked() { return Boolean(this.snapshot); }

  begin(draft: CaptureDraft, createId: () => string): CaptureRequest | undefined {
    if (this.busy || this.completed) return undefined;
    this.snapshot ||= { ...draft, request_id: createId() };
    this.busy = true;
    return this.snapshot;
  }

  succeed() { this.busy = false; this.completed = true; }

  fail(allowEdit: boolean) {
    this.busy = false;
    if (allowEdit) this.snapshot = undefined;
  }

  reset() {
    if (this.busy) return false;
    this.snapshot = undefined;
    this.completed = false;
    return true;
  }
}
