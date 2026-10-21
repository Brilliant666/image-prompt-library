import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, Trash2, X } from 'lucide-react';
import { api, mediaUrl } from '../api/client';
import { useModalFocus } from '../hooks/useModalFocus';
import { imageThumbnailPath } from '../utils/images';
import type { ItemSummary, UiLanguage } from '../types';
import './TrashModal.css';

const LABELS = {
  zh_hans: { title: '回收站', help: '移入回收站后可恢复到 Library。永久删除记录后无法在此恢复，但不会立即释放磁盘中的图片空间。', empty: '回收站为空', loading: '正在读取回收站…', retry: '重试', loadError: '无法读取回收站，请重试。', actionError: '操作未完成，请重试。', restore: '恢复', remove: '永久删除', close: '关闭回收站', deleted: '移入时间', unknown: '未记录', more: '加载更多', cancel: '取消', confirm: '确认永久删除', warning: '将永久删除这条记录、提示词及图片关联，无法在此恢复。图片文件暂时保留在磁盘中，不会立即释放空间。', busy: '处理中…' },
  zh_hant: { title: '回收站', help: '移入回收站後可還原至 Library。永久刪除記錄後無法在此還原，但不會立即釋放磁碟中的圖片空間。', empty: '回收站為空', loading: '正在讀取回收站…', retry: '重試', loadError: '無法讀取回收站，請重試。', actionError: '操作未完成，請重試。', restore: '還原', remove: '永久刪除', close: '關閉回收站', deleted: '移入時間', unknown: '未記錄', more: '載入更多', cancel: '取消', confirm: '確認永久刪除', warning: '將永久刪除此記錄、提示詞及圖片關聯，無法在此還原。圖片檔案暫時保留在磁碟中，不會立即釋放空間。', busy: '處理中…' },
  en: { title: 'Trash', help: 'Restore an item to return it to Library. Permanently deleted records cannot be restored here. Permanent deletion does not immediately free image storage on disk.', empty: 'Trash is empty', loading: 'Loading trash…', retry: 'Retry', loadError: 'Could not load trash. Please retry.', actionError: 'The action could not be completed. Please retry.', restore: 'Restore', remove: 'Delete permanently', close: 'Close trash', deleted: 'Moved to trash', unknown: 'Not recorded', more: 'Load more', cancel: 'Cancel', confirm: 'Confirm permanent deletion', warning: 'This permanently deletes the item record, its prompts, and image links. It cannot be restored here. Image files remain on disk for now, so this does not immediately free storage.', busy: 'Working…' },
};
export const trashLabels = (language: UiLanguage) => LABELS[language];

export default function TrashModal({ uiLanguage, onClose, onChanged }: { uiLanguage: UiLanguage; onClose: () => void; onChanged: () => void }) {
  const text = trashLabels(uiLanguage);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmItem, setConfirmItem] = useState<ItemSummary>();
  const live = useRef(true);
  const sequence = useRef(0);
  const mutation = useRef(false);
  const confirmationRef = useRef<HTMLButtonElement | null>(null);
  const close = () => { if (!mutation.current) { if (confirmItem) setConfirmItem(undefined); else onClose(); } };
  const { containerRef, handleModalKeyDown } = useModalFocus<HTMLDivElement>(close, { fallbackFocusSelector: '.library-trash-trigger' });
  const load = async (offset = 0) => {
    const request = ++sequence.current;
    setLoading(true); setLoadError(false);
    try {
      const data = await api.items({ trashed: true, limit: 50, offset, sort: 'updated_desc' });
      if (!live.current || request !== sequence.current) return;
      setItems(current => offset ? [...current, ...data.items.filter(item => !current.some(existing => existing.id === item.id))] : data.items);
      setTotal(data.total);
    } catch { if (live.current && request === sequence.current) setLoadError(true); }
    finally { if (live.current && request === sequence.current) setLoading(false); }
  };
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; sequence.current++; }; }, []);
  useEffect(() => { if (confirmItem) confirmationRef.current?.focus(); }, [confirmItem]);
  const change = async (item: ItemSummary, permanent: boolean) => {
    if (mutation.current || (permanent && confirmItem?.id !== item.id)) return;
    mutation.current = true; setBusy(true); setActionError(false);
    // A response from an earlier page load must not reintroduce a restored item.
    sequence.current++;
    try {
      if (permanent) await api.permanentlyDeleteItem(item.id);
      else await api.restoreItem(item.id);
      onChanged();
      if (!live.current) return;
      setConfirmItem(undefined);
      setItems(current => current.filter(value => value.id !== item.id));
      setTotal(current => Math.max(0, current - 1));
      await load();
    } catch { if (live.current) setActionError(true); }
    finally { mutation.current = false; if (live.current) { setBusy(false); setLoading(false); } }
  };
  const date = (value?: string | null) => {
    if (!value) return text.unknown;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? text.unknown : parsed.toLocaleString(uiLanguage === 'en' ? 'en-US' : uiLanguage === 'zh_hant' ? 'zh-TW' : 'zh-CN');
  };
  return <div className="modal-backdrop" onClick={close}>
    <div ref={containerRef} className="modal polished-modal library-trash-modal" role="dialog" aria-modal="true" aria-labelledby="library-trash-title" tabIndex={-1} onKeyDown={handleModalKeyDown} onClick={event => event.stopPropagation()}>
      <header className="library-trash-head" inert={Boolean(confirmItem)}><div><h2 id="library-trash-title">{text.title}</h2><p>{text.help}</p></div><button type="button" className="modal-icon-button" disabled={busy || Boolean(confirmItem)} aria-label={text.close} onClick={close}><X size={20} /></button></header>
      {actionError && <p role="alert" className="library-trash-error">{text.actionError}</p>}
      <div className="library-trash-content" inert={Boolean(confirmItem)}>
        {loading && <p role="status">{text.loading}</p>}
        {loadError && <p role="alert">{text.loadError} <button type="button" onClick={() => void load()} disabled={busy || loading || Boolean(confirmItem)}>{text.retry}</button></p>}
        {!loading && !loadError && items.length === 0 && <p className="library-trash-empty">{text.empty}</p>}
        <ul className="library-trash-list">
          {items.map(item => <li key={item.id} className="library-trash-item">
            {item.first_image && imageThumbnailPath(item.first_image) ? <img src={mediaUrl(imageThumbnailPath(item.first_image))} alt="" loading="lazy" /> : <span className="library-trash-placeholder"><Trash2 size={24} /></span>}
            <div className="library-trash-copy"><strong>{item.title}</strong><small>{text.deleted}：{date(item.deleted_at)}</small></div>
            <div className="library-trash-actions">
              <button type="button" onClick={() => void change(item, false)} disabled={busy || loading || Boolean(confirmItem)} aria-label={`${text.restore}：${item.title}`}><ArchiveRestore size={16} />{text.restore}</button>
              <button type="button" className="library-trash-remove" onClick={() => { setActionError(false); setConfirmItem(item); }} disabled={busy || loading || Boolean(confirmItem)} aria-label={`${text.remove}：${item.title}`}><Trash2 size={16} />{text.remove}</button>
            </div>
          </li>)}
        </ul>
        {items.length > 0 && items.length < total && <button type="button" className="library-trash-more" disabled={busy || loading || Boolean(confirmItem)} onClick={() => void load(items.length)}>{text.more}</button>}
      </div>
      {confirmItem && <section className="library-trash-confirm" role="alertdialog" aria-modal="true" aria-labelledby="library-trash-confirm-title" aria-describedby="library-trash-confirm-warning">
        <h3 id="library-trash-confirm-title">{text.remove}：{confirmItem.title}</h3><p id="library-trash-confirm-warning">{text.warning}</p>
        <div><button ref={confirmationRef} type="button" disabled={busy} onClick={() => { setConfirmItem(undefined); setActionError(false); }}>{text.cancel}</button><button type="button" className="library-trash-remove" disabled={busy} onClick={() => void change(confirmItem, true)}>{busy ? text.busy : text.confirm}</button></div>
      </section>}
    </div>
  </div>;
}
