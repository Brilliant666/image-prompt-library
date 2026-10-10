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
