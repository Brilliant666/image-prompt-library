import { appendRecent } from './core.mjs';
import { matchesReceipt, updateReceiptMetadata } from './organizer.mjs';

const DATABASE = 'image-prompt-library-capture';
const STORE = 'current';
function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(new Error('无法读取本地草稿存储。'));
    request.onsuccess = () => resolve(request.result);
  });
}
export async function readCard() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get('card');
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = () => { db.close(); reject(new Error('无法读取本地草稿。')); };
  });
}
export async function writeCard(card) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(card, 'card');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(new Error('草稿未能写入本地存储；尚未提交，请保留当前窗口。')); };
    tx.onabort = tx.onerror;
  });
}
export async function readRecent() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get('recent');
    tx.oncomplete = () => { db.close(); resolve(request.result || []); };
    tx.onerror = () => { db.close(); reject(new Error('无法读取最近收录。')); };
    tx.onabort = tx.onerror;
  });
}
export async function writeSavedCard(card) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get('recent');
    let recent;
    request.onsuccess = () => {
      try {
        recent = appendRecent(request.result || [], card.receipt);
        store.put(recent, 'recent');
        store.put(card, 'card');
      } catch { tx.abort(); }
    };
    tx.oncomplete = () => { db.close(); resolve(recent); };
    tx.onerror = () => { db.close(); reject(new Error('保存回执未能写入本机，原请求仍保留，请恢复回执。')); };
    tx.onabort = tx.onerror;
  });
}
export async function clearRecent(config) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get('recent');
    let recent;
    request.onsuccess = () => {
      recent = (request.result || []).filter(entry => entry.base_url !== config.base_url || entry.instance_id !== config.instance_id);
      store.put(recent, 'recent');
    };
    tx.oncomplete = () => { db.close(); resolve(recent); };
    tx.onerror = () => { db.close(); reject(new Error('未能清空最近收录，图库中的内容不受影响。')); };
    tx.onabort = tx.onerror;
  });
}
// Refresh only existing receipt metadata. Never insert a history row, restore a
// cleared card, change revision, or reset the independent continue countdown.
export async function refreshReceiptMetadata(target, update) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const historyRequest = store.get('recent');
    const cardRequest = store.get('card');
    let recent, card;
    historyRequest.onsuccess = () => {
      recent = (historyRequest.result || []).map(entry => matchesReceipt(entry, target, update) ? updateReceiptMetadata(entry, update) : entry);
      store.put(recent, 'recent');
    };
    cardRequest.onsuccess = () => {
      card = cardRequest.result;
      if (card?.status === 'saved' && matchesReceipt(card.receipt, target, update)) {
        card = { ...card, receipt: updateReceiptMetadata(card.receipt, update) };
        store.put(card, 'card');
      }
    };
    tx.oncomplete = () => { db.close(); resolve({ card, recent }); };
    tx.onerror = () => { db.close(); reject(new Error('整理状态暂未同步；图库中的收录不受影响。')); };
    tx.onabort = tx.onerror;
  });
}
// Chrome's local area is not synchronised. Content scripts are not allowed access.
export async function readConfig() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return (await chrome.storage.local.get('pairing')).pairing || null;
}
export async function writeConfig(pairing) {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (pairing) await chrome.storage.local.set({ pairing });
  else await chrome.storage.local.remove('pairing');
}
