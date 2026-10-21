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
function evaluate(js, dependencies, window = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'confirm', 'fetch', js)(name => {
    assert.ok(name in dependencies, `unmocked dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, window, () => true, () => assert.fail('Dropping an image must not fetch a remote URL'));
  return module.exports;
}
const component = await compile('../frontend/src/components/ItemEditorModal.tsx');
const editorPrompts = evaluate(await compile('../frontend/src/utils/editorPrompts.ts'), {});
const capture = evaluate(await compile('../frontend/src/utils/quickCapture.ts'), {});
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
  const slots = [], timers = [], events = { writes: [], uploads: [], changed: 0, deleted: 0, closed: 0 };
  let cursor = 0, dirty = false, tree;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useMemo(callback) { return callback(); },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
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
    './SuggestedTitleField': { default: 'SuggestedTitleField' },
    '../utils/editorPrompts': editorPrompts,
    '../utils/quickCapture': capture,
  }, { matchMedia: () => ({ matches: true }), setTimeout: callback => timers.push(callback) });
  function render() {
    cursor = 0; dirty = false;
    tree = Editor({ item, t: key => key, clusters: [], tags: [], defaultAiProvider: 'openai_compatible', onClose: () => events.closed++, onSaved: () => events.changed++, onDeleted: () => events.deleted++ });
  }
  async function flush() { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); }
  const find = (type, predicate = () => true) => descendants(tree).find(node => node.type === type && predicate(node.props))?.props;
  const zone = role => find('label', props => props.className?.split(' ').includes(`${role}-drop-zone`));
  const input = role => descendants({ props: zone(role) }).find(node => node.type === 'input' && node.props.type === 'file')?.props;
  const filename = role => descendants({ props: zone(role) }).find(node => node.type === 'strong')?.props.children;
  const save = () => find('button', props => props.children === 'saveReference').onClick();
  render();
  return { find, zone, input, filename, save, flush, events, timers };
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
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

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
