import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
function evaluate(js, dependencies, window = {}, objectUrls = URL) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'confirm', 'fetch', 'URL', js)(name => {
    assert.ok(name in dependencies, `unmocked dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, window, () => true, () => assert.fail('Dropping an image must not fetch a remote URL'), objectUrls);
  return module.exports;
}
const component = await compile('../frontend/src/components/ItemEditorModal.tsx');
const editorPrompts = evaluate(await compile('../frontend/src/utils/editorPrompts.ts'), {});
const capture = evaluate(await compile('../frontend/src/utils/quickCapture.ts'), {});
const { makeTranslator } = evaluate(await compile('../frontend/src/utils/i18n.ts'), {});
const originalPrompt = '  synthetic prompt\r\n保留空白\n\t ';
const item = {
  id: 'synthetic-library-item', title: 'Existing manual title', model: 'synthetic-model', author: 'Synthetic author', tags: [],
  notes: 'Existing note',
  prompts: [{ id: 'prompt-original', item_id: 'synthetic-library-item', language: 'en', text: originalPrompt, is_original: true, is_primary: true, provenance: { kind: 'manual' } }],
  images: [{ id: 'original-image', role: 'result_image', original_path: 'originals/synthetic-original.png', thumb_path: 'thumbs/synthetic-original.webp' }],
};
function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(descendants)];
}
function harness(overrides = {}) {
  const slots = [], timers = [], effects = new Map(), pendingEffects = [];
  const events = { writes: [], uploads: [], createdUrls: [], revokedUrls: [], changed: 0, deleted: 0, closed: 0 };
  let cursor = 0, dirty = false, tree;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useMemo(callback) { return callback(); },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(callback, dependencies) {
      const i = cursor++, previous = effects.get(i);
      if (previous && dependencies && dependencies.length === previous.dependencies?.length
        && dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))) return;
      pendingEffects.push(() => {
        previous?.cleanup?.();
        effects.set(i, { dependencies, cleanup: callback() });
      });
    },
  };
  const jsx = (type, props) => ({ type, props });
  const api = {
    updateItem: async (id, payload) => { events.writes.push(['update', id, payload]); return item; },
    createItem: async () => { assert.fail('Adding an image must not create a second Library card'); },
    updateImages: async (...args) => { events.writes.push(['images', ...args]); return item; },
    uploadImage: async (...args) => { events.uploads.push(args); return { id: `uploaded-${events.uploads.length}` }; },
    deleteItem: async id => { events.writes.push(['delete', id]); },
    item: async () => item,
    ...overrides.api,
  };
  const { default: Editor } = evaluate(component, {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../api/client': { api, mediaUrl: path => `/media/${path}` },
    '../hooks/useModalFocus': { useModalFocus: () => ({ containerRef: {}, handleModalKeyDown() {} }) },
    '../utils/images': { imageThumbnailPath: image => image.thumb_path },
    './SuggestedTitleField': { __esModule: true, default: 'SuggestedTitleField' },
    './CollectionPicker': { __esModule: true, default: 'CollectionPicker' },
    '../utils/editorPrompts': editorPrompts,
    '../utils/quickCapture': capture,
  }, { matchMedia: () => ({ matches: true }), setTimeout: callback => timers.push(callback) }, {
    createObjectURL(file) { const url = `blob:synthetic-preview-${events.createdUrls.length + 1}`; events.createdUrls.push({ file, url }); return url; },
    revokeObjectURL(url) { events.revokedUrls.push(url); },
  });
  function render() {
    cursor = 0; dirty = false;
    tree = Editor({ item: 'item' in overrides ? overrides.item : item, t: overrides.t || (key => key), clusters: overrides.clusters || [], tags: [], defaultAiProvider: 'openai_compatible', onClose: () => events.closed++, onSaved: () => events.changed++, onDeleted: () => events.deleted++ });
    while (pendingEffects.length) pendingEffects.shift()();
  }
  async function flush() { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); }
  const find = (type, predicate = () => true) => descendants(tree).find(node => node.type === type && predicate(node.props))?.props;
  const zone = role => find('label', props => props.className?.split(' ').includes(`${role}-drop-zone`));
  const input = role => descendants({ props: zone(role) }).find(node => node.type === 'input' && node.props.type === 'file')?.props;
  const filename = role => descendants({ props: zone(role) }).find(node => node.type === 'strong')?.props.children;
  const preview = role => descendants({ props: zone(role) }).find(node => node.type === 'img' && node.props.className === 'editor-upload-preview')?.props;
  const pasteTarget = role => find('button', props => props['data-paste-role'] === role);
  const paste = event => find('div', props => props.role === 'dialog').onPaste(event);
  const save = () => find('button', props => props.children === 'saveReference').onClick();
  render();
  const unmount = () => { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); };
  return { find, zone, input, filename, preview, pasteTarget, paste, save, flush, unmount, events, timers, get tree() { return tree; } };
}
function dragEvent(files = [], data = {}) {
  const calls = { prevented: 0, stopped: 0 };
  return {
    calls, currentTarget: { contains: () => false }, relatedTarget: null,
    dataTransfer: { files, items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })), types: files.length ? ['Files'] : Object.keys(data), getData: type => data[type] || '', dropEffect: 'none' },
    preventDefault() { calls.prevented++; }, stopPropagation() { calls.stopped++; },
  };
}
const image = (name = 'synthetic.png') => new File([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)], name, { type: 'image/png' });
function clipboardEvent(files = [], data = {}) {
  const event = dragEvent(files, data);
  event.clipboardData = {
    ...event.dataTransfer,
    items: [...event.dataTransfer.items, ...Object.keys(data).map(type => ({ kind: 'string', type, getAsFile: () => null }))],
  };
  return event;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

for (const blank of ['', ' \t\n ']) {
  test(`editor serializes cleared metadata explicitly and reopens it empty (${JSON.stringify(blank)})`, async () => {
    const original = { ...structuredClone(item), source_url: 'https://example.invalid/original' };
    let persisted = original, payload;
    const h = harness({ item: original, api: {
      updateItem: async (id, value) => {
        assert.equal(id, original.id);
        payload = JSON.parse(JSON.stringify(value));
        persisted = { ...persisted, ...payload };
        return persisted;
      },
    } });
    h.find('input', props => props.placeholder === 'notReported').onChange({ target: { value: blank } });
    h.find('input', props => props.type === 'url').onChange({ target: { value: blank } });
    h.find('textarea', props => props.placeholder === 'addNote').onChange({ target: { value: blank } });
    await h.flush();
    await h.save(); await h.flush();
    assert.equal(payload.model, '');
    assert.equal(payload.source_url, null);
    assert.equal(payload.notes, null);
    assert.equal('prompts' in payload, false);
    for (const field of ['id', 'title', 'author', 'tags', 'prompts', 'images']) assert.deepEqual(persisted[field], original[field]);
    assert.deepEqual(h.events.uploads, []);
    assert.equal(h.events.writes.length, 0, 'metadata-only save must not write image order or remove images');
    const reopened = harness({ item: persisted });
    assert.equal(reopened.find('input', props => props.placeholder === 'notReported').value, '');
    assert.equal(reopened.find('input', props => props.type === 'url').value, '');
    assert.equal(reopened.find('textarea', props => props.placeholder === 'addNote').value, '');
    assert.equal(reopened.find('textarea', props => props.value === originalPrompt).value, originalPrompt);
  });
}

test('editor keeps omitted empty metadata on create so server defaults still apply', async () => {
  let payload;
  const h = harness({ item: undefined, api: {
    createItem: async value => {
      payload = JSON.parse(JSON.stringify(value));
      return { ...structuredClone(item), ...payload, images: [] };
    },
  } });
  h.find('SuggestedTitleField').onChange('Synthetic new card');
  h.find('textarea', props => props.placeholder === 'simplifiedPromptPlaceholder').onChange({ target: { value: originalPrompt } });
  h.find('input', props => props.placeholder === 'notReported').onChange({ target: { value: '' } });
  h.zone('result').onDrop(dragEvent([image()])); await h.flush();
  await h.save(); await h.flush();
  for (const field of ['model', 'source_url', 'notes']) assert.equal(field in payload, false);
  assert.equal(payload.prompts[0].text, originalPrompt);
  assert.equal(h.events.uploads.length, 1);
});

test('editor preserves an existing collection by ID without submitting its localized display name', async () => {
  const collection = { id: 'portrait-collection', name: 'Portraits', names: { en: 'Portraits', zh_hans: '环境人像' }, count: 1, preview_images: [] };
  const h = harness({ item: { ...item, cluster: collection }, clusters: [{ ...collection, name: '环境人像' }] });
  assert.deepEqual(h.find('CollectionPicker').value, { id: collection.id, name: 'Portraits' });
  await h.save(); await h.flush();
  const payload = JSON.parse(JSON.stringify(h.events.writes[0][2]));
  assert.equal(payload.cluster_id, collection.id);
  assert.equal('cluster_name' in payload, false);
  assert.equal('prompts' in payload, false);
  assert.deepEqual(h.events.uploads, []);
  assert.equal(h.find('textarea', props => props.value === originalPrompt).value, originalPrompt);
});

for (const [label, selection, expected] of [
  ['a different existing collection', { id: 'existing-2', name: '本地化名称' }, { cluster_id: 'existing-2' }],
  ['unassigned', { id: null, name: '' }, { cluster_id: null }],
  ['an explicitly created collection', { id: null, name: '  New synthetic collection  ' }, { cluster_name: 'New synthetic collection' }],
]) {
  test(`editor applies ${label} only on save and keeps prompts and pending attachments intact`, async () => {
    const h = harness({ item: { ...item, cluster: { id: 'old-collection', name: 'Old collection' } } });
    const file = image('retained-attachment.png');
    h.zone('result').onDrop(dragEvent([file])); await h.flush();
    h.find('CollectionPicker').onChange(selection); await h.flush();
    assert.deepEqual(h.events.writes, []);
    assert.deepEqual(h.events.uploads, []);
    assert.equal(h.filename('result'), file.name);
    assert.equal(h.find('textarea', props => props.value === originalPrompt).value, originalPrompt);
    await h.save(); await h.flush();
    const payload = JSON.parse(JSON.stringify(h.events.writes[0][2]));
    const actual = Object.fromEntries(Object.entries(payload).filter(([key]) => key === 'cluster_id' || key === 'cluster_name'));
    assert.deepEqual(actual, expected);
    assert.equal('prompts' in payload, false);
    assert.deepEqual(h.events.uploads, [[item.id, file, 'result_image']]);
    assert.equal(h.events.writes.some(([kind]) => kind === 'images'), false);
  });
}

test('closing the editor after a collection choice does not create or move a collection', async () => {
  const h = harness();
  h.find('CollectionPicker').onChange({ id: null, name: 'Unsaved collection' }); await h.flush();
  h.find('button', props => props['aria-label'] === 'close').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, []);
  assert.deepEqual(h.events.uploads, []);
  for (const timer of h.timers) timer();
  assert.equal(h.events.closed, 1);
});

test('editor drops retain both original Files and upload to the same item with the correct roles only on save', async () => {
  const h = harness(), result = image('second.png'), reference = image('source.png');
  for (const [role, file] of [['result', result], ['reference', reference]]) {
    const event = dragEvent([file]);
    h.zone(role).onDrop(event); await h.flush();
    assert.ok(event.calls.prevented > 0);
    assert.ok(event.calls.stopped > 0);
    assert.equal(h.filename(role), file.name);
  }
  assert.deepEqual(h.events.writes, []);
  assert.deepEqual(h.events.uploads, []);
  assert.equal(h.find('textarea', props => props.value === originalPrompt).value, originalPrompt);
  await h.save(); await h.flush();
  assert.equal(h.events.writes.length, 1);
  assert.equal(h.events.writes[0][1], item.id);
  assert.equal(h.events.writes[0][2].title, item.title);
  assert.equal('prompts' in h.events.writes[0][2], false);
  assert.deepEqual(h.events.uploads, [[item.id, result, 'result_image'], [item.id, reference, 'reference_image']]);
  assert.deepEqual(new Uint8Array(await h.events.uploads[0][1].arrayBuffer()), new Uint8Array(await result.arrayBuffer()));
  assert.equal(item.images[0].id, 'original-image');
  assert.equal(h.events.changed, 1);
});

for (const role of ['result', 'reference']) {
  test(`editor ${role} picker remains usable, resets its input, and cancellation keeps the pending file`, async () => {
    const h = harness(), file = image(`${role}.png`);
    const input = { files: [file], value: 'synthetic-picker-value' };
    h.input(role).onChange({ target: input, currentTarget: input }); await h.flush();
    assert.equal(input.value, '');
    assert.equal(h.filename(role), file.name);
    const cancelled = { files: [], value: '' };
    h.input(role).onChange({ target: cancelled, currentTarget: cancelled }); await h.flush();
    assert.equal(h.filename(role), file.name);
    await h.save(); await h.flush();
    assert.deepEqual(h.events.uploads, [[item.id, file, `${role}_image`]]);
  });

  const invalid = [
    ['multiple files', [image('one.png'), image('two.png')]],
    ['unsupported type', [new File(['text'], 'note.txt', { type: 'text/plain' })]],
    ['empty image', [new File([], 'empty.png', { type: 'image/png' })]],
    ['oversized image', [{ name: 'too-big.png', type: 'image/png', size: 30 * 1024 * 1024 + 1 }]],
  ];
  for (const [reason, files] of invalid) {
    test(`editor ${role} rejects ${reason} without replacing the previously selected file`, async () => {
      const h = harness(), original = image('keep.png');
      h.zone(role).onDrop(dragEvent([original])); await h.flush();
      h.zone(role).onDrop(dragEvent(files)); await h.flush();
      assert.equal(h.filename(role), original.name);
      assert.ok(h.find('p', props => props.className === 'form-error')?.children);
      const input = { files, value: 'invalid-picker-value' };
      h.input(role).onChange({ target: input, currentTarget: input }); await h.flush();
      assert.equal(input.value, '');
      assert.equal(h.filename(role), original.name);
      assert.equal(h.events.uploads.length, 0);
      await h.save(); await h.flush();
      assert.deepEqual(h.events.uploads, [[item.id, original, `${role}_image`]]);
    });
  }

  test(`editor ${role} shows local drag feedback and clears it on leave and drop`, async () => {
    const h = harness(), event = dragEvent([image()]);
    h.zone(role).onDragOver(event); await h.flush();
    assert.ok(event.calls.prevented > 0);
    assert.match(h.zone(role).className, /is-dragging/);
    h.zone(role).onDragLeave(dragEvent()); await h.flush();
    assert.doesNotMatch(h.zone(role).className, /is-dragging/);
    h.zone(role).onDragOver(event); await h.flush();
    h.zone(role).onDrop(event); await h.flush();
    assert.doesNotMatch(h.zone(role).className, /is-dragging/);
  });
}

for (const data of [{ 'text/uri-list': 'https://example.invalid/source.png' }, { 'text/html': '<img src="https://example.invalid/source.png">' }]) {
  test(`editor rejects ${Object.keys(data)[0]} drops without requests or loss of the pending image`, async () => {
    const h = harness(), file = image();
    h.zone('reference').onDrop(dragEvent([file])); await h.flush();
    const event = dragEvent([], data);
    h.zone('reference').onDrop(event); await h.flush();
    assert.ok(event.calls.prevented > 0);
    assert.equal(h.filename('reference'), file.name);
    assert.ok(h.find('p', props => props.className === 'form-error')?.children);
    assert.deepEqual(h.events.writes, []);
    assert.deepEqual(h.events.uploads, []);
  });
}

test('editor prevents file changes while saving, preserving the files already selected for the pending request', async () => {
  const pending = deferred();
  const h = harness({ api: { updateItem: () => pending.promise } });
  const result = image('before-save.png'), reference = image('before-save-reference.png');
  h.zone('result').onDrop(dragEvent([result])); h.zone('reference').onDrop(dragEvent([reference])); await h.flush();
  const saving = h.save(); await h.flush();
  for (const role of ['result', 'reference']) {
    assert.equal(h.input(role).disabled, true);
    h.zone(role).onDrop(dragEvent([image('late-drop.png')]));
    const input = { files: [image('late-picker.png')], value: 'late' };
    h.input(role).onChange({ target: input, currentTarget: input });
  }
  await h.flush();
  assert.equal(h.filename('result'), result.name);
  assert.equal(h.filename('reference'), reference.name);
  pending.resolve(item); await saving; await h.flush();
  assert.deepEqual(h.events.uploads, [[item.id, result, 'result_image'], [item.id, reference, 'reference_image']]);
});

test('editor ignores incoming files once closing begins', async () => {
  const h = harness(), file = image('keep.png');
  h.zone('result').onDrop(dragEvent([file])); await h.flush();
  h.find('button', props => props['aria-label'] === 'close').onClick(); await h.flush();
  h.zone('result').onDrop(dragEvent([image('late.png')])); await h.flush();
  assert.equal(h.filename('result'), file.name);
  assert.equal(h.input('result').disabled, true);
  assert.deepEqual(h.events.uploads, []);
});

test('editor ignores drop and picker changes while deletion is pending', async () => {
  const pending = deferred();
  const h = harness({ api: { deleteItem: () => pending.promise } });
  const result = image('keep-result.png'), reference = image('keep-reference.png');
  h.zone('result').onDrop(dragEvent([result]));
  h.zone('reference').onDrop(dragEvent([reference])); await h.flush();
  const deleting = h.find('button', props => props.className === 'danger').onClick(); await h.flush();
  for (const role of ['result', 'reference']) {
    assert.equal(h.input(role).disabled, true);
    h.zone(role).onDrop(dragEvent([image('late-drop.png')]));
    const input = { files: [image('late-picker.png')], value: 'late' };
    h.input(role).onChange({ target: input, currentTarget: input });
  }
  await h.flush();
  assert.equal(h.filename('result'), result.name);
  assert.equal(h.filename('reference'), reference.name);
  assert.deepEqual(h.events.uploads, []);
  pending.resolve(); await deleting; await h.flush();
  assert.equal(h.events.deleted, 1);
});

test('editor pastes to result by default, switches targets, and saves both original files with the unchanged prompt', async () => {
  const h = harness(), first = image('first.png'), result = image('result.png'), reference = image('reference.png');
  assert.equal(h.pasteTarget('result')['aria-pressed'], true);
  const event = clipboardEvent([first]);
  h.paste(event); await h.flush();
  assert.ok(event.calls.prevented > 0);
  assert.ok(event.calls.stopped > 0);
  assert.equal(h.filename('result'), first.name);
  h.pasteTarget('reference').onClick(); await h.flush();
  assert.equal(h.pasteTarget('reference')['aria-pressed'], true);
  assert.equal(h.pasteTarget('result')['aria-pressed'], false);
  h.paste(clipboardEvent([reference])); await h.flush();
  h.pasteTarget('result').onClick(); await h.flush();
  h.paste(clipboardEvent([result])); await h.flush();
  assert.equal(h.filename('result'), result.name);
  assert.equal(h.filename('reference'), reference.name);
  assert.equal(h.find('textarea', props => props.value === originalPrompt).value, originalPrompt);
  assert.deepEqual(h.events.writes, []);
  assert.deepEqual(h.events.uploads, []);
  await h.save(); await h.flush();
  assert.equal('prompts' in h.events.writes[0][2], false);
  assert.deepEqual(h.events.uploads, [[item.id, result, 'result_image'], [item.id, reference, 'reference_image']]);
});

test('focusing either upload area selects its paste target without clearing the other image', async () => {
  const h = harness(), result = image('focus-result.png'), reference = image('focus-reference.png');
  h.zone('reference').onFocus(); await h.flush();
  h.paste(clipboardEvent([reference])); await h.flush();
  h.zone('result').onFocus(); await h.flush();
  h.paste(clipboardEvent([result])); await h.flush();
  assert.equal(h.filename('result'), result.name);
  assert.equal(h.filename('reference'), reference.name);
  assert.equal(h.pasteTarget('result')['aria-pressed'], true);
});

for (const data of [{ 'text/plain': '  paste ordinary text\n' }, { 'text/uri-list': 'https://example.invalid/image.png' }]) {
  test(`editor leaves ${Object.keys(data)[0]} paste entirely native and retains pending images`, async () => {
    const h = harness(), file = image('keep.png');
    h.paste(clipboardEvent([file])); await h.flush();
    const event = clipboardEvent([], data);
    h.paste(event); await h.flush();
    assert.equal(event.calls.prevented, 0);
    assert.equal(event.calls.stopped, 0);
    assert.equal(h.filename('result'), file.name);
    assert.equal(h.find('textarea', props => props.value === originalPrompt).value, originalPrompt);
    assert.equal(h.find('p', props => props.className === 'form-error'), undefined);
    assert.deepEqual(h.events.writes, []);
    assert.deepEqual(h.events.uploads, []);
  });
}

test('editor rejects multiple clipboard images without replacing either valid pending image', async () => {
  const h = harness(), result = image('keep-result.png'), reference = image('keep-reference.png');
  h.paste(clipboardEvent([result])); await h.flush();
  h.pasteTarget('reference').onClick(); await h.flush();
  h.paste(clipboardEvent([reference])); await h.flush();
  const event = clipboardEvent([image('one.png'), image('two.png')]);
  h.paste(event); await h.flush();
  assert.ok(event.calls.prevented > 0);
  assert.equal(h.find('p', props => props.className === 'form-error').children, 'editorOneImage');
  assert.equal(h.filename('result'), result.name);
  assert.equal(h.filename('reference'), reference.name);
  assert.deepEqual(h.events.uploads, []);
  await h.save(); await h.flush();
  assert.deepEqual(h.events.uploads, [[item.id, result, 'result_image'], [item.id, reference, 'reference_image']]);
});

test('editor rejects incoming clipboard files while saving and preserves the pending request', async () => {
  const pending = deferred(), h = harness({ api: { updateItem: () => pending.promise } });
  const file = image('before-save.png');
  h.paste(clipboardEvent([file])); await h.flush();
  const saving = h.save(); await h.flush();
  assert.equal(h.pasteTarget('result').disabled, true);
  assert.equal(h.pasteTarget('reference').disabled, true);
  h.paste(clipboardEvent([image('late.png')])); await h.flush();
  assert.equal(h.filename('result'), file.name);
  pending.resolve(item); await saving; await h.flush();
  assert.deepEqual(h.events.uploads, [[item.id, file, 'result_image']]);
});

test('editor ignores clipboard images after closing begins', async () => {
  const h = harness(), file = image('keep.png');
  h.paste(clipboardEvent([file])); await h.flush();
  h.find('button', props => props['aria-label'] === 'close').onClick(); await h.flush();
  h.paste(clipboardEvent([image('late.png')])); await h.flush();
  assert.equal(h.filename('result'), file.name);
  assert.deepEqual(h.events.uploads, []);
});

test('editor previews pasted result and reference images in their respective areas without uploading', async () => {
  const h = harness(), result = image('preview-result.png'), reference = image('preview-reference.png');
  assert.equal(h.preview('result'), undefined);
  assert.equal(h.preview('reference'), undefined);
  h.paste(clipboardEvent([result])); await h.flush();
  h.pasteTarget('reference').onClick(); await h.flush();
  h.paste(clipboardEvent([reference])); await h.flush();
  for (const [role, file] of [['result', result], ['reference', reference]]) {
    const created = h.events.createdUrls.find(entry => entry.file === file);
    assert.ok(created);
    assert.equal(h.preview(role).src, created.url);
    assert.equal(h.preview(role).alt, file.name);
  }
  assert.deepEqual(h.events.writes, []);
  assert.deepEqual(h.events.uploads, []);
  assert.deepEqual(h.events.revokedUrls, []);
});

test('replacing a preview revokes its old URL, preserves the other role, and unmount releases the remaining URLs', async () => {
  const h = harness(), first = image('first.png'), next = image('next.png'), reference = image('reference.png');
  h.zone('result').onDrop(dragEvent([first]));
  h.zone('reference').onDrop(dragEvent([reference])); await h.flush();
  const oldUrl = h.preview('result').src, referenceUrl = h.preview('reference').src;
  h.zone('result').onDrop(dragEvent([next])); await h.flush();
  const newUrl = h.preview('result').src;
  assert.notEqual(newUrl, oldUrl);
  assert.equal(h.events.createdUrls.find(entry => entry.url === newUrl).file, next);
  assert.deepEqual(h.events.revokedUrls, [oldUrl]);
  assert.equal(h.preview('reference').src, referenceUrl);
  h.unmount();
  assert.deepEqual(h.events.revokedUrls, [oldUrl, newUrl, referenceUrl]);
});

test('picker cancellation and invalid incoming files preserve both existing previews and their URLs', async () => {
  const h = harness();
  for (const role of ['result', 'reference']) {
    const input = { files: [image(`${role}.png`)], value: 'selected' };
    h.input(role).onChange({ target: input, currentTarget: input }); await h.flush();
  }
  const previews = { result: h.preview('result').src, reference: h.preview('reference').src };
  for (const role of ['result', 'reference']) {
    const cancelled = { files: [], value: '' };
    h.input(role).onChange({ target: cancelled, currentTarget: cancelled });
    h.zone(role).onDrop(dragEvent([image('one.png'), image('two.png')])); await h.flush();
    assert.equal(h.preview(role).src, previews[role]);
  }
  assert.equal(h.events.createdUrls.length, 2);
  assert.deepEqual(h.events.revokedUrls, []);
});

test('successful save uploads original Files and releases both pending preview URLs', async () => {
  const h = harness(), result = image('result.png'), reference = image('reference.png');
  h.zone('result').onDrop(dragEvent([result]));
  h.zone('reference').onDrop(dragEvent([reference])); await h.flush();
  const urls = h.events.createdUrls.map(entry => entry.url);
  await h.save(); await h.flush();
  assert.deepEqual(h.events.uploads, [[item.id, result, 'result_image'], [item.id, reference, 'reference_image']]);
  assert.equal(h.preview('result'), undefined);
  assert.equal(h.preview('reference'), undefined);
  assert.deepEqual(h.events.revokedUrls, urls);
  h.unmount();
  assert.deepEqual(h.events.revokedUrls, urls);
});

test('new-item partial upload failure moves the partial record to trash, preserves pending files, and retries as a new record', async () => {
  const records = new Map(), uploads = [], deleted = [];
  let firstReferenceFails = true;
  const english = makeTranslator('en');
  const h = harness({ item: undefined, t: key => key === 'imageUploadFailed' ? english(key) : key, api: {
    createItem: async payload => {
      const record = { ...payload, id: `new-${records.size + 1}`, images: [], deleted_at: null };
      records.set(record.id, record);
      return record;
    },
    updateItem: async () => assert.fail('Retry must not overwrite the recoverable partial item'),
    uploadImage: async (id, file, role) => {
      uploads.push([id, file, role]);
      if (role === 'reference_image' && firstReferenceFails) {
        firstReferenceFails = false;
        throw new Error('synthetic reference upload failure');
      }
      records.get(id).images.push({ id: `image-${uploads.length}`, role });
      return { id: `image-${uploads.length}` };
    },
    deleteItem: async id => { records.get(id).deleted_at = 'synthetic-trash-time'; deleted.push(id); return records.get(id); },
  } });
  const result = image('pending-result.png'), reference = image('pending-reference.png');
  h.find('SuggestedTitleField').onChange('Manual synthetic title');
  h.find('textarea', props => props.placeholder === 'simplifiedPromptPlaceholder').onChange({ target: { value: originalPrompt } });
  h.zone('result').onDrop(dragEvent([result]));
  h.zone('reference').onDrop(dragEvent([reference])); await h.flush();
  await h.save(); await h.flush();
  assert.deepEqual(deleted, ['new-1']);
  assert.equal(records.get('new-1').deleted_at, 'synthetic-trash-time');
  assert.equal(records.get('new-1').images.length, 1);
  assert.equal(h.filename('result'), result.name);
  assert.equal(h.filename('reference'), reference.name);
  assert.equal(h.find('textarea', props => props.placeholder === 'simplifiedPromptPlaceholder').value, originalPrompt);
  assert.equal(h.find('p', props => props.className === 'form-error').children,
    'Image upload did not complete. The partial item was moved to trash. Retry here or inspect it in Library trash.');
  assert.equal(h.events.closed, 0);
  const partialSnapshot = JSON.stringify(records.get('new-1'));
  await h.save(); await h.flush();
  assert.equal(records.size, 2);
  assert.equal(JSON.stringify(records.get('new-1')), partialSnapshot);
  assert.equal(records.get('new-2').deleted_at, null);
  assert.deepEqual(uploads.slice(-2), [['new-2', result, 'result_image'], ['new-2', reference, 'reference_image']]);
  assert.ok(records.get('new-2').prompts.some(prompt => prompt.text === originalPrompt));
  assert.equal(h.events.changed, 1);
});

function uploadRetryFixture({ initial = item, failReadback = false, rollbackFails = false } = {}) {
  let record = structuredClone(initial), failReference = true, failReads = failReadback;
  const writes = [], uploads = [], removed = [];
  const h = harness({ item: rollbackFails ? undefined : initial, api: {
    createItem: async payload => { record = { ...structuredClone(item), ...payload, images: [], id: 'new-partial' }; return structuredClone(record); },
    updateItem: async (id, payload) => { writes.push(['metadata', id]); record = { ...record, ...JSON.parse(JSON.stringify(payload)) }; return structuredClone(record); },
    updateImages: async (id, images) => {
      writes.push(['images', structuredClone(images)]);
      removed.push(...record.images.filter(old => !images.some(image => image.id === old.id)).map(image => image.id));
      record.images = images.map(image => ({ ...record.images.find(old => old.id === image.id), ...image }));
      return structuredClone(record);
    },
    uploadImage: async (id, file, role) => {
      uploads.push([id, file.name, role]);
      if (role === 'reference_image' && failReference) { failReference = false; throw Error('synthetic reference upload failure'); }
      const uploaded = { id: file.name, item_id: id, role, original_path: `originals/${file.name}`, thumb_path: `thumbs/${file.name}.webp` };
      record.images.push(uploaded);
      return structuredClone(uploaded);
    },
    item: async () => { if (failReads) throw Error('synthetic readback failure'); return structuredClone(record); },
    deleteItem: async () => { throw Error('synthetic rollback failure'); },
  } });
  if (rollbackFails) {
    h.find('SuggestedTitleField').onChange('Synthetic new card');
    h.find('textarea', props => props.placeholder === 'simplifiedPromptPlaceholder').onChange({ target: { value: originalPrompt } });
  }
  const stage = async () => {
    h.zone('result').onDrop(dragEvent([image('successful-result.png')]));
    h.zone('reference').onDrop(dragEvent([image('pending-reference.png')])); await h.flush();
  };
  return { h, stage, writes, uploads, removed, allowReadback: () => { failReads = false; }, get record() { return record; } };
}

test('retrying a partial upload retains the acknowledged result image and uploads only the failed reference', async () => {
  const f = uploadRetryFixture(), { h } = f;
  await f.stage(); await h.save(); await h.flush();
  assert.deepEqual(f.record.images.map(image => image.id), ['original-image', 'successful-result.png']);
  assert.equal(h.filename('result'), 'resultImageAlreadySaved');
  assert.equal(h.filename('reference'), 'pending-reference.png');
  assert.equal(h.find('p', props => props.className === 'form-error').children, 'savePartiallyCompleted');
  await h.save(); await h.flush();
  assert.deepEqual(f.record.images.map(image => image.id), ['original-image', 'successful-result.png', 'pending-reference.png']);
  assert.deepEqual(f.removed, []);
  assert.equal(f.writes.some(([kind]) => kind === 'images'), false);
  assert.deepEqual(f.uploads.map(([, name]) => name), ['successful-result.png', 'pending-reference.png', 'pending-reference.png']);
  assert.equal(h.find('textarea', props => props.value === originalPrompt).value, originalPrompt);
});

test('failed upload reconciliation blocks further writes until the current images can be read', async () => {
  const f = uploadRetryFixture({ failReadback: true }), { h } = f;
  await f.stage(); await h.save(); await h.flush();
  const firstWrites = structuredClone(f.writes), firstUploads = structuredClone(f.uploads);
  await h.save(); await h.flush();
  assert.deepEqual(f.writes, firstWrites);
  assert.deepEqual(f.uploads, firstUploads);
  assert.deepEqual(f.removed, []);
  f.allowReadback();
  await h.save(); await h.flush();
  assert.deepEqual(f.record.images.map(image => image.id), ['original-image', 'successful-result.png', 'pending-reference.png']);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.uploads.map(([, name]) => name), ['successful-result.png', 'pending-reference.png', 'pending-reference.png']);
});

test('failed new-item rollback reconciles both image snapshots so retry does not delete its uploaded result', async () => {
  const f = uploadRetryFixture({ rollbackFails: true }), { h } = f;
  await f.stage(); await h.save(); await h.flush();
  assert.equal(h.find('p', props => props.className === 'form-error').children, 'saveRollbackFailed');
  await h.save(); await h.flush();
  assert.deepEqual(f.record.images.map(image => image.id), ['successful-result.png', 'pending-reference.png']);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.uploads.map(([, name]) => name), ['successful-result.png', 'pending-reference.png', 'pending-reference.png']);
});

test('new-item rollback and readback failure still permit a safe refresh before retry', async () => {
  const f = uploadRetryFixture({ rollbackFails: true, failReadback: true }), { h } = f;
  await f.stage(); await h.save(); await h.flush();
  assert.equal(h.find('button', props => props.children === 'saveReference').disabled, false);
  const uploads = structuredClone(f.uploads);
  await h.save(); await h.flush();
  assert.deepEqual(f.uploads, uploads);
  assert.deepEqual(f.writes, []);
  f.allowReadback();
  await h.save(); await h.flush();
  assert.deepEqual(f.record.images.map(image => image.id), ['successful-result.png', 'pending-reference.png']);
  assert.deepEqual(f.removed, []);
});

const imageRows = h => descendants(h.tree).filter(node => node.type === 'article' && node.props.className?.includes('item-image-manager-row'));
const rowButton = (row, label) => descendants(row).find(node => node.type === 'button' && node.props['aria-label'] === label).props;

test('partial upload reconciliation retains intentional image removal, cover and order before retry', async () => {
  const initial = { ...item, images: [item.images[0], { ...item.images[0], id: 'second-result' }, { ...item.images[0], id: 'old-reference', role: 'reference_image' }] };
  const f = uploadRetryFixture({ initial }), { h } = f;
  rowButton(imageRows(h)[1], 'setPrimaryImage').onClick(); await h.flush();
  rowButton(imageRows(h)[2], 'removeImage').onClick(); await h.flush();
  await f.stage(); await h.save(); await h.flush();
  await h.save(); await h.flush();
  assert.deepEqual(f.record.images.map(image => image.id), ['second-result', 'original-image', 'successful-result.png', 'pending-reference.png']);
  assert.deepEqual(f.removed, ['old-reference']);
  assert.equal(f.writes.filter(([kind]) => kind === 'images').length, 1);
  assert.ok(imageRows(h)[0].props.className.includes('is-primary'));
});

test('image-list edits during an in-flight save cannot create an unacknowledged replacement draft', async () => {
  const initial = { ...item, images: [item.images[0], { ...item.images[0], id: 'second-result' }] }, pending = deferred();
  const h = harness({ item: initial, api: { updateItem: () => pending.promise } });
  const saving = h.save(); await h.flush();
  const rows = imageRows(h);
  for (const row of rows) {
    for (const label of ['setPrimaryImage', 'moveImageEarlier', 'moveImageLater', 'removeImage']) {
      const button = rowButton(row, label);
      assert.equal(button.disabled, true);
      button.onClick();
    }
    const select = descendants(row).find(node => node.type === 'select').props;
    assert.equal(select.disabled, true);
    select.onChange({ target: { value: 'reference_image' } });
  }
  await h.flush();
  assert.equal(imageRows(h).length, 2);
  pending.resolve(initial); await saving; await h.flush();
  assert.equal(h.events.writes.some(([kind]) => kind === 'images'), false);
  assert.equal(imageRows(h).length, 2);
});
