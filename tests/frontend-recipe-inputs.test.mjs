import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../frontend/src/utils/recipeInputs.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { recipeInputs, restoreRecipeInputs, fillRecipeInputs } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const media = path => `/media/${path}`;

test('restore preserves ordered original references even when reads complete out of order', async () => {
  const inputs = recipeInputs({ id: 'edit', mode: 'image_edit', parameters: { input_images: [
    { name: 'first', image_id: 'mutable', source: 'library', result_path: 'generation-references/first.png' },
    { name: 'second', result_path: 'generation-references/second.png' },
  ] } }, media);
  const restored = await restoreRecipeInputs(inputs, async input => {
    if (input.name === 'first') await new Promise(resolve => setTimeout(resolve, 10));
    return `data:image/png;base64,${input.name}`;
  });
  assert.deepEqual(restored.map(input => input.name), ['first', 'second']);
  assert.deepEqual(restored.map(input => input.dataUrl), ['data:image/png;base64,first', 'data:image/png;base64,second']);
  assert.ok(restored.every(input => input.source === 'uploaded' && !input.imageId && !input.resultPath && !input.missing));
});

test('missing original remains an ordered blocked slot and replacement fills that slot', async () => {
  const inputs = recipeInputs({ mode: 'image_edit', parameters: { input_images: [{ name: 'first' }, { name: 'second', result_path: 'safe.png' }] } }, media);
  const restored = await restoreRecipeInputs(inputs, async input => {
    if (!input.resultPath) throw new Error('404');
    return 'data:image/png;base64,second';
  });
  assert.equal(restored.length, 2);
  assert.equal(restored[0].missing, true);
  assert.equal(restored[1].missing, false);
  const replacement = { id: 'new', name: 'replacement', source: 'uploaded', previewUrl: '', dataUrl: 'data:image/png;base64,first' };
  const filled = fillRecipeInputs(restored, [replacement], 2);
  assert.deepEqual(filled.map(input => input.name), ['replacement', 'second']);
  assert.ok(filled.every(input => !input.missing));
});

test('both reference modes without recorded inputs remain blocked; ordinary text-to-image has no references', () => {
  for (const mode of ['image_edit', 'text_reference_to_image']) {
    assert.equal(recipeInputs({ mode, parameters: {} }, media)[0].missing, true);
    assert.equal(recipeInputs({ mode, parameters: { input_images: [] } }, media)[0].missing, true);
  }
  assert.deepEqual(recipeInputs({ mode: 'text_to_image', parameters: {} }, media), []);
});

test('malformed input entries cannot disappear and silently change mode', async () => {
  const restored = await restoreRecipeInputs(recipeInputs({ mode: 'image_edit', parameters: { input_images: [null, 'bad'] } }, media), async () => { throw new Error('Missing'); });
  assert.equal(restored.length, 2);
  assert.ok(restored.every(input => input.missing));
});
