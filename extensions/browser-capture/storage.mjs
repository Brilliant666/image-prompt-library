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
