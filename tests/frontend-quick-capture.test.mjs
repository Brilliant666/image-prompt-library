import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/utils/quickCapture.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { CAPTURE_MAX_BYTES, CaptureSubmission, captureFormData, captureImageError, captureErrorAllowsEdit } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const file = new File([Uint8Array.from([1, 2, 3, 4])], 'synthetic.png', { type: 'image/png' });
const draft = { file, prompt_text: '  First line\r\n\n「中文」 <&> PBR\t ', language: 'auto', notes: '  note\n' };

test('capture transport keeps original file bytes, prompt whitespace and manual language', async () => {
  const body = captureFormData({ ...draft, language: 'und', request_id: 'a-request-id' });
  assert.equal(JSON.parse(body.get('prompt_text_json')), draft.prompt_text);
  assert.equal(body.get('prompt_text'), null);
  assert.equal(body.get('notes'), draft.notes);
  assert.equal(body.get('language'), 'und');
  assert.equal(body.get('request_id'), 'a-request-id');
  assert.deepEqual(new Uint8Array(await body.get('file').arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
  assert.equal(body.get('model'), null);
  assert.equal(body.get('provider'), null);
});

test('multipart serialization preserves mixed LF/CRLF, trailing spaces and special characters in the original prompt', async () => {
  const body = captureFormData({ ...draft, request_id: 'line-ending-regression' });
  const request = new Request('https://example.invalid/api/captures', { method: 'POST', body });
  const serialized = await request.text();
  const encodedPrompt = serialized.match(/name="prompt_text_json"\r\n\r\n([^\r\n]*)\r\n/);
  assert.ok(encodedPrompt, 'prompt travels as one escaped JSON string');
  assert.equal(JSON.parse(encodedPrompt[1]), draft.prompt_text);
});

test('all file inputs share one count, type, empty and size check without replacing a valid draft', () => {
  assert.equal(captureImageError([file]), undefined);
  assert.equal(captureImageError([{ ...file, name: 'untagged.webp', type: '', size: 16 }]), undefined);
  assert.equal(captureImageError([]), 'oneImage');
  assert.equal(captureImageError([file, file]), 'oneImage');
  assert.equal(captureImageError([{ name: 'empty.png', type: 'image/png', size: 0 }]), 'emptyImage');
  assert.equal(captureImageError([{ name: 'text.txt', type: 'text/plain', size: 5 }]), 'imageType');
  assert.equal(captureImageError([{ name: 'big.png', type: 'image/png', size: CAPTURE_MAX_BYTES + 1 }]), 'imageTooLarge');
});

test('double click is guarded synchronously and uncertain retries reuse the original snapshot and UUID', () => {
  const session = new CaptureSubmission();
  let ids = 0;
  const nextId = () => `request-${++ids}`;
  const first = session.begin(draft, nextId);
  assert.equal(session.begin(draft, nextId), undefined);
  assert.equal(session.reset(), false);
  session.fail(false);
  assert.equal(session.locked, true);
  const retry = session.begin({ ...draft, prompt_text: 'accidentally changed', language: 'en' }, nextId);
  assert.equal(retry, first);
  assert.equal(retry.prompt_text, draft.prompt_text);
  assert.equal(retry.language, 'auto');
  assert.equal(ids, 1);
  session.succeed();
  assert.equal(session.begin(draft, nextId), undefined);
  assert.equal(session.reset(), true);
  assert.equal(session.begin(draft, nextId).request_id, 'request-2');
});

test('definitive validation failure permits correction but ambiguous failures never silently create a second record', () => {
  for (const status of [400, 413, 415, 422]) assert.equal(captureErrorAllowsEdit(status), true);
  for (const status of [undefined, 200, 409, 410, 500, 502, 503]) assert.equal(captureErrorAllowsEdit(status), false);
  const session = new CaptureSubmission();
  session.begin(draft, () => 'invalid');
  session.fail(true);
  assert.equal(session.locked, false);
  assert.equal(session.begin({ ...draft, prompt_text: 'corrected' }, () => 'corrected-id').request_id, 'corrected-id');
});
