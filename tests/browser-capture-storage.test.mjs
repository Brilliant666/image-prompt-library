import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { emptyCard, freezeCard, completeCard, recentForTarget } from '../extensions/browser-capture/core.mjs';
import { readCard, writeCard, readRecent, writeSavedCard, clearRecent } from '../extensions/browser-capture/storage.mjs';

const target = { base_url: 'http://127.0.0.1:8013', instance_id: 'isolated-instance', client_id: 'test-client', extension_id: 'a'.repeat(32) };
const source = { ...emptyCard(), image: { blob: new Blob(['synthetic original']), name: 'fixture.png' }, prompt: '  synthetic prompt\r\n\n', title: 'Optional title' };
function saved(index, config = target) {
  const frozen = freezeCard(source, config, () => `request-${index}`);
  return completeCard(frozen, { request_id: frozen.frozen.request_id, item_id: `item-${index}`, title: `Saved ${index}`, created_at: '2026-10-16T12:00:00+00:00' }, new Blob(['small preview']));
}

// Run the production IndexedDB transactions against a standards-compatible
// in-memory engine; native Chrome acceptance remains a separate manual check.
test('saved receipt and recent history commit together and survive reopening the store', async () => {
  globalThis.indexedDB = new IDBFactory();
  await writeCard(freezeCard(source, target, () => 'request-1'));
  const complete = saved(1);
  await writeSavedCard(complete);
  const restored = await readCard();
  const entries = await readRecent();
  assert.equal(restored.status, 'saved');
  assert.equal(restored.image, null);
  assert.equal(restored.prompt, '');
  assert.equal(restored.frozen, null);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].item_id, restored.receipt.item_id);
  assert.equal(await entries[0].thumbnail.text(), 'small preview');
  assert.deepEqual(Object.keys(entries[0]).sort(), ['base_url', 'created_at', 'instance_id', 'item_id', 'request_id', 'thumbnail', 'title']);
});

test('failure of either write aborts both updates and preserves the exact frozen request', async () => {
  for (const failingKey of ['recent', 'card']) {
    globalThis.indexedDB = new IDBFactory();
    const frozen = freezeCard(source, target, () => 'request-2');
    await writeSavedCard(saved(1));
    await writeCard(frozen);
    const previous = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (key === failingKey) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return previous.call(this, value, key);
    };
    try { await assert.rejects(writeSavedCard(saved(2)), /原请求仍保留/); }
    finally { IDBObjectStore.prototype.put = previous; }
    const restored = await readCard();
    assert.equal(restored.status, 'submitting');
    assert.equal(restored.frozen.request_id, frozen.frozen.request_id);
    assert.equal(restored.frozen.prompt, source.prompt);
    assert.equal(await restored.frozen.image.blob.text(), 'synthetic original');
    assert.deepEqual((await readRecent()).map(entry => entry.item_id), ['item-1']);
  }
});

test('retry deduplicates receipts, caps total history at twenty and keeps no original or credentials', async () => {
  globalThis.indexedDB = new IDBFactory();
  for (let index = 0; index < 23; index++) await writeSavedCard(saved(index));
  const retry = saved(22);
  retry.receipt.token = 'synthetic credential must not enter recent history';
  retry.receipt.prompt = source.prompt;
  retry.receipt.original = source.image.blob;
  await writeSavedCard(retry);
  let entries = await readRecent();
  assert.equal(entries.length, 20);
  assert.deepEqual(entries.map(entry => entry.item_id), Array.from({ length: 20 }, (_, index) => `item-${22 - index}`));
  const newReceipt = saved(23);
  Object.assign(newReceipt.receipt, { token: retry.receipt.token, prompt: source.prompt, original: source.image.blob });
  await writeSavedCard(newReceipt);
  entries = await readRecent();
  assert.equal(entries.length, 20);
  assert.equal(entries.some(entry => 'token' in entry || 'prompt' in entry || 'original' in entry || 'client_id' in entry), false);
});

test('instance filtering and clearing do not touch the active draft or another library', async () => {
  globalThis.indexedDB = new IDBFactory();
  const otherInstance = { ...target, instance_id: 'different-instance' };
  const otherAddress = { ...target, base_url: 'http://localhost:8014' };
  await writeSavedCard(saved(1));
  await writeSavedCard(saved(1, otherInstance));
  await writeSavedCard(saved(1, otherAddress));
  await writeCard(source);
  assert.equal((await readRecent()).length, 3, 'same item ID in another library must not collide');
  assert.equal(recentForTarget(await readRecent(), target).length, 1);
  await clearRecent(target);
  assert.equal(recentForTarget(await readRecent(), target).length, 0);
  assert.equal((await readRecent()).length, 2);
  assert.equal((await readCard()).prompt, source.prompt);
  assert.equal(await (await readCard()).image.blob.text(), 'synthetic original');
});

test('concurrent history writes serialize without losing either receipt', async () => {
  globalThis.indexedDB = new IDBFactory();
  await Promise.all([writeSavedCard(saved(1)), writeSavedCard(saved(2))]);
  assert.deepEqual(new Set((await readRecent()).map(entry => entry.item_id)), new Set(['item-1', 'item-2']));
  assert.equal((await readCard()).status, 'saved');
});
