import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../frontend/src/utils/compatibleProfiles.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { recipeProfileId, generationProviderChoices } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('restore pins request profile; old recipes never follow a new default', () => {
  assert.equal(recipeProfileId({ parameters: { compatible_profile_id: 'alpha' } }), 'alpha');
  assert.equal(recipeProfileId({ parameters: { compatible_profile_id: 'beta' }, metadata: { requested: { compatible_profile_id: 'alpha' } } }), 'alpha');
  assert.equal(recipeProfileId({ parameters: {} }), 'legacy');
  assert.equal(recipeProfileId({ parameters: { compatible_profile_id: 'removed' } }), 'removed');
});

test('each endpoint has independent readiness and default model; OAuth remains unchanged', () => {
  const oauth = { provider: 'oauth', model: 'oauth-model', features: { image_edit: true } };
  const base = { provider: 'openai_compatible', features: { image_edit: false, title_suggestion: false } };
  const profiles = [
    { id: 'a', display_name: 'API A', model: 'model-a', configured: true, api_key_present: true },
    { id: 'b', display_name: 'API B', model: '', configured: true, api_key_present: true },
    { id: 'c', display_name: 'API C', model: 'model-c', configured: false, api_key_present: false },
  ];
  const choices = generationProviderChoices([oauth, base], profiles);
  assert.equal(choices[0], oauth);
  assert.deepEqual(choices.slice(1).map(p => [p.profile_id, p.display_name, p.model, p.can_generate]), [
    ['a', 'API A', 'model-a', true], ['b', 'API B', '', true], ['c', 'API C', 'model-c', false],
  ]);
  assert.equal(choices[1].features.image_edit, true);
  assert.equal(choices[3].features.image_edit, false);
  assert.equal(generationProviderChoices([base], [])[0].can_generate, false);
});
const preferenceSource = await readFile(new URL('../frontend/src/utils/generationPreferences.ts', import.meta.url), 'utf8');
const preferenceJs = ts.transpileModule(preferenceSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readGenerationPreference, writeGenerationPreference, lastGenerationProfile } = await import(`data:text/javascript;base64,${Buffer.from(preferenceJs).toString('base64')}`);
test('generation choices survive reopening and stay isolated by endpoint', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const a = { model: 'alias-a', size: '2160x3840', quality: 'max', background: 'auto', output_format: 'png' };
  const b = { ...a, model: 'alias-b', size: '1024x1024', quality: 'xhigh' };
  writeGenerationPreference(storage, 'a', { ...a, api_key: 'not-to-be-saved', prompt: 'private' });
  writeGenerationPreference(storage, 'b', b);
  assert.deepEqual(readGenerationPreference(storage, 'a', 'new-default'), a);
  assert.deepEqual(readGenerationPreference(storage, 'b'), b);
  assert.equal(lastGenerationProfile(storage), 'b');
  assert.equal(readGenerationPreference(storage, 'new', 'default').quality, 'auto');
  assert.equal(readGenerationPreference(storage, 'new', 'default').model, 'default');
  assert.ok(!JSON.stringify([...values.values()]).includes('not-to-be-saved'));
  assert.ok(!JSON.stringify([...values.values()]).includes('private'));
});
test('invalid or disabled preference storage falls back safely', () => {
  for (const value of ['{', 'null', '{"size":"oops","quality":"bogus"}']) {
    assert.equal(readGenerationPreference({ getItem: () => value }, 'a').size, 'auto');
  }
  const denied = { getItem: () => { throw Error('disabled'); }, setItem: () => { throw Error('full'); } };
  assert.equal(readGenerationPreference(denied, 'a').quality, 'auto');
  assert.doesNotThrow(() => writeGenerationPreference(denied, 'a', {}));
});
