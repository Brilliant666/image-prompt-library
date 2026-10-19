import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { IDBFactory } from 'fake-indexeddb';

const modules = new Map();
async function loadTs(relative) {
  const url = new URL(relative, import.meta.url);
  if (modules.has(url.href)) return modules.get(url.href);
  const source = await readFile(url, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies = new Map();
  for (const match of js.matchAll(/require\("([^"]+)"\)/g)) dependencies.set(match[1], await loadTs(new URL(`${match[1]}.ts`, url).href));
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => dependencies.get(name), module, module.exports);
  modules.set(url.href, module.exports);
  return module.exports;
}
const compatible = await loadTs('../frontend/src/utils/compatibleRecipe.ts');
const gallery = await loadTs('../frontend/src/utils/galleryRecipe.ts');
const drafts = await loadTs('../frontend/src/utils/galleryDraft.ts');
const preferences = await loadTs('../frontend/src/utils/generationPreferences.ts');
const transportKeys = ['base_url_mode', 'stream', 'partial_images', 'response_format'];
const legacy = { base_url_mode: 'versioned', stream: false, partial_images: 0, response_format: 'auto' };
const streaming = { base_url_mode: 'custom', stream: true, partial_images: 3, response_format: 'b64_json' };
const prompt = '  合成测试\r\n第二行\t ';
const job = (extra = {}) => ({
  id: 'transport-history', provider: 'openai_compatible', mode: 'text_to_image', prompt_text: prompt,
  status: 'succeeded', model: 'synthetic-image', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  parameters: { model: 'synthetic-image', compatible_profile_id: 'original-api', size: '1536x1024', quality: 'high', background: 'opaque', output_format: 'png' },
  ...extra,
});
const selected = value => compatible.pickCompatibleTransportOverrides(value);
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), values };
};

test('history metadata takes precedence over parameters without losing false, zero or auto', () => {
  const original = job();
  original.parameters = { ...original.parameters, ...streaming };
  original.metadata = { requested: { ...legacy, api_key: 'private-key', base_url: 'https://private.invalid' } };
  const before = JSON.stringify(original);
  const recipe = compatible.restoreCompatibleRecipe(original);
  assert.deepEqual(selected(recipe), legacy);
  assert.equal(recipe.transportLegacyDerived, undefined, 'all four recorded values are authoritative');
  assert.deepEqual(selected(compatible.compatibleParameters(recipe)), legacy);
  assert.equal(JSON.stringify(original), before);
  assert.ok(!JSON.stringify(recipe).includes('private-'));
  assert.ok(!JSON.stringify(recipe).includes('private.invalid'));
});

test('transport restoration merges recorded fields individually and preserves each option', () => {
  const original = job();
  original.parameters = { ...original.parameters, ...legacy };
  original.metadata = { requested: { stream: true, partial_images: 2, response_format: 'b64_json' } };
  assert.deepEqual(selected(compatible.restoreCompatibleRecipe(original)), { ...legacy, stream: true, partial_images: 2, response_format: 'b64_json' });
  delete original.metadata;
  original.parameters = { ...original.parameters, ...streaming };
  assert.deepEqual(selected(compatible.restoreCompatibleRecipe(original)), streaming);
  original.metadata = { requested: { stream: 'false', partial_images: '0', base_url_mode: 'invalid', response_format: null } };
  assert.deepEqual(selected(compatible.restoreCompatibleRecipe(original)), streaming, 'invalid metadata cannot erase a valid frozen parameter');
});

for (const status of ['succeeded', 'accepted', 'failed', 'cancelled']) {
  for (const mode of ['text_to_image', 'image_edit']) {
    test(`${status} ${mode} history reaches the Gallery request with the same transport and original text`, () => {
      const original = job({ status, mode });
      original.metadata = { requested: { ...streaming, partial_images: 0 } };
      const inputs = mode === 'image_edit' ? [{ id: 'synthetic-reference', name: 'reference.png', source: 'uploaded', previewUrl: 'data:image/png;base64,AA==', dataUrl: 'data:image/png;base64,AA==' }] : [];
      const draft = gallery.draftFromJob(original, inputs);
      const payload = gallery.galleryPayload(draft, 4);
      assert.deepEqual(selected(payload.parameters), { ...streaming, partial_images: 0 });
      assert.equal(payload.parameters.compatible_profile_id, 'original-api');
      assert.equal(payload.prompt_text, prompt);
      assert.equal(payload.mode, mode);
      assert.deepEqual(payload.parameters.input_images.map(value => value.id), inputs.map(value => value.id));
    });
  }
}

test('old history retains the legacy wire behavior while new tasks omit transport overrides', () => {
  const historical = gallery.draftFromJob(job(), []);
  assert.deepEqual(selected(gallery.galleryPayload(historical, 4).parameters), legacy);
  assert.equal(historical.recipe.transportLegacyDerived, true, 'legacy behavior is inferred rather than claimed to be recorded');
  assert.equal(gallery.galleryPayload(historical, 4).parameters.transportLegacyDerived, undefined, 'local provenance is not an API request option');
  assert.equal(drafts.validateGalleryDraft(historical).recipe.transportLegacyDerived, true);
  assert.equal(compatible.clearCompatibleTransportOverrides(historical.recipe).transportLegacyDerived, undefined);
  const fresh = gallery.emptyGalleryDraft();
  fresh.prompt = prompt;
  fresh.profileId = 'new-api';
  fresh.recipe.model = 'synthetic-image';
  const payload = gallery.galleryPayload(fresh, 4);
  for (const key of transportKeys) assert.equal(Object.hasOwn(payload.parameters, key), false, `${key} must be supplied by the current API profile`);
  assert.deepEqual(selected(drafts.validateGalleryDraft(fresh).recipe), {});
});

test('a partial historical record fills only missing options with the legacy defaults', () => {
  const original = job();
  original.parameters.stream = true;
  original.metadata = { requested: { base_url_mode: 'custom' } };
  assert.deepEqual(selected(gallery.galleryPayload(gallery.draftFromJob(original, []), 4).parameters), { ...legacy, stream: true, base_url_mode: 'custom' });
  assert.equal(gallery.draftFromJob(original, []).recipe.transportLegacyDerived, true);
});

test('editing ordinary fields preserves historical transport; explicit connection switches clear it without mutation', () => {
  const original = job();
  original.metadata = { requested: streaming };
  const draft = gallery.draftFromJob(original, []);
  const before = JSON.stringify(draft.recipe);
  const edited = { ...draft, prompt: 'Different prompt', recipe: { ...draft.recipe, quality: 'low', size: '1024x1536' } };
  assert.deepEqual(selected(gallery.galleryPayload(edited, 4).parameters), streaming);
  const cleared = compatible.clearCompatibleTransportOverrides(edited.recipe);
  assert.deepEqual(selected(cleared), {});
  assert.equal(cleared.quality, 'low');
  assert.equal(cleared.size, '1024x1536');
  assert.deepEqual(selected(edited.recipe), streaming);
  assert.equal(JSON.stringify(draft.recipe), before);
  const switched = { ...edited, profileId: 'another-api', recipe: cleared };
  assert.deepEqual(selected(gallery.galleryPayload(switched, 4).parameters), {});
});

test('historical transport never becomes ordinary per-profile generation preferences', () => {
  const saved = storage();
  const original = job(); original.metadata = { requested: streaming };
  const restored = gallery.draftFromJob(original, []);
  preferences.writeGenerationPreference(saved, 'original-api', { ...restored.recipe, api_key: 'private-secret', base_url: 'https://private.invalid' });
  const remembered = preferences.readGenerationPreference(saved, 'original-api', 'new-model');
  assert.equal(remembered.model, 'synthetic-image');
  assert.equal(remembered.size, '1536x1024');
  for (const key of transportKeys) assert.equal(Object.hasOwn(remembered, key), false);
  assert.ok(!JSON.stringify([...saved.values.values()]).includes('private'));
  // Even a preference from an older client containing transport must not override API defaults.
  const key = [...saved.values.keys()].find(value => value.endsWith('original-api'));
  saved.values.set(key, JSON.stringify({ ...remembered, ...streaming }));
  assert.deepEqual(selected(preferences.readGenerationPreference(saved, 'original-api')), {});
});

test('current draft persists transport across close/reopen without persisting credentials', async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'indexedDB', prior); else delete globalThis.indexedDB; });
  for (const transport of [streaming, legacy]) {
    const original = job(); original.metadata = { requested: transport };
    const draft = gallery.draftFromJob(original, []);
    draft.recipe.api_key = 'do-not-store';
    draft.recipe.base_url = 'https://private.invalid';
    draft.authorization = 'do-not-store';
    await drafts.saveGalleryDraft(draft);
    const recovered = await drafts.readGalleryDraft();
    assert.deepEqual(selected(recovered.recipe), transport);
    assert.deepEqual(selected(gallery.galleryPayload(recovered, 4).parameters), transport);
    assert.equal(recovered.prompt, prompt);
    assert.equal(recovered.profileId, 'original-api');
    assert.ok(!JSON.stringify(recovered).includes('do-not-store'));
    assert.ok(!JSON.stringify(recovered).includes('private.invalid'));
  }
  await drafts.saveGalleryDraft();
  assert.equal(await drafts.readGalleryDraft(), undefined);
});

test('OAuth drafts and requests do not carry compatible API transport options', () => {
  for (const provider of ['openai_codex_oauth_native', 'xai_grok_oauth']) {
    const original = job({ provider, metadata: { requested: streaming } });
    const draft = gallery.draftFromJob(original, []);
    assert.deepEqual(selected(draft.recipe), {});
    assert.deepEqual(selected(gallery.galleryPayload(draft, 4).parameters), {});
    draft.recipe = { ...draft.recipe, ...streaming };
    assert.deepEqual(selected(drafts.validateGalleryDraft(draft).recipe), {});
  }
});

test('transport validation excludes corrupt options from drafts and rejects invalid direct request recipes', () => {
  const base = { model: 'synthetic-image', quality: 'auto', size: 'auto', background: 'auto', output_format: 'png' };
  for (const invalid of [{ stream: 'false' }, { stream: 0 }, { partial_images: '0' }, { partial_images: true }, { partial_images: 1.5 }, { partial_images: -1 }, { partial_images: 4 }, { base_url_mode: 'unknown' }, { response_format: 'url' }]) {
    assert.deepEqual(selected(invalid), {});
    assert.throws(() => compatible.compatibleParameters({ ...base, ...invalid }), /传输配置无效/);
    const draft = { ...gallery.emptyGalleryDraft(), recipe: { ...base, ...invalid } };
    assert.deepEqual(selected(drafts.validateGalleryDraft(draft).recipe), {});
  }
});
