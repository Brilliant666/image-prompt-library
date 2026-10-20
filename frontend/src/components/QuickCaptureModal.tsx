import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import { Check, ChevronDown, ImagePlus, Plus, X } from 'lucide-react';
import { api, CaptureRequestError, mediaUrl } from '../api/client';
import { useModalFocus } from '../hooks/useModalFocus';
import type { ItemDetail, UiLanguage } from '../types';
import { imageThumbnailPath } from '../utils/images';
import { CAPTURE_IMAGE_ACCEPT, CaptureSubmission, captureErrorAllowsEdit, captureImageError, type CaptureLanguage, type CaptureLanguageResult } from '../utils/quickCapture';
import { quickCaptureLabels } from '../utils/quickCaptureLabels';
import './quick-capture.css';

export default function QuickCaptureModal({ open, uiLanguage, onClose, onSaved, onFullEditor }: {
  open: boolean;
  uiLanguage: UiLanguage;
  onClose: () => void;
  onSaved: () => void;
  onFullEditor: (item: ItemDetail) => void;
}) {
  const text = quickCaptureLabels(uiLanguage);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [language, setLanguage] = useState<CaptureLanguage>('auto');
  const [detected, setDetected] = useState<CaptureLanguageResult>();
  const [detecting, setDetecting] = useState(false);
  const [title, setTitle] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [recoverableConflict, setRecoverableConflict] = useState(false);
  const [savedItem, setSavedItem] = useState<ItemDetail>();
  const [dragging, setDragging] = useState(false);
  const submission = useRef(new CaptureSubmission());
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const locked = submission.current.locked;
  const close = () => { if (!saving) onClose(); };
  const { containerRef, handleModalKeyDown } = useModalFocus<HTMLDivElement>(close, { active: open, fallbackFocusSelector: '.add-fab, .empty-primary' });

  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    setPreviewFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!open || savedItem || language !== 'auto' || !prompt.trim()) {
      setDetecting(false);
      if (!prompt.trim()) setDetected(undefined);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setDetecting(true);
    setDetected(undefined);
    const timer = window.setTimeout(() => {
      api.detectCaptureLanguage(prompt, controller.signal).then(result => {
        if (!cancelled) setDetected(result);
      }).catch(() => {
        if (!cancelled) setDetected({ language: 'und', uncertain: true, reason: 'unavailable' });
      }).finally(() => { if (!cancelled) setDetecting(false); });
    }, 350);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [prompt, language, open, savedItem]);

  useEffect(() => {
    if (!file && !prompt) return;
    if (savedItem) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [file, prompt, savedItem]);

  const acceptFiles = (files: File[]) => {
    if (locked || saving || savedItem) return;
    const problem = captureImageError(files);
    if (problem) { setError(text[problem]); return; }
    setError('');
    setFile(files[0]);
  };

  const paste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((value): value is File => Boolean(value));
    if (!files.length) return; // Let textarea/input handle ordinary pasted text unchanged.
    event.preventDefault();
    acceptFiles(files);
  };

  const drop = (event: DragEvent) => {
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      event.preventDefault();
      acceptFiles(files);
      return;
    }
    const types = Array.from(event.dataTransfer.types);
    if (types.includes('text/uri-list') || /<img\b/i.test(event.dataTransfer.getData('text/html')) || /^https?:\/\/\S+$/i.test(event.dataTransfer.getData('text/plain').trim())) {
      event.preventDefault();
      if (!locked && !savedItem) setError(text.urlOnly);
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (savedItem || saving) return;
    if (!file || !prompt.trim()) { setError(text.required); return; }
    const payload = submission.current.begin({ file, prompt_text: prompt, language, title, source_name: sourceName, source_url: sourceUrl, notes }, () => crypto.randomUUID());
    if (!payload) return;
    setSaving(true);
    setError('');
    setRecoverableConflict(false);
    try {
      const item = await api.capture(payload);
      submission.current.succeed();
      setSavedItem(item);
      onSaved();
    } catch (failure) {
      submission.current.fail(captureErrorAllowsEdit(failure instanceof CaptureRequestError ? failure.status : undefined));
      setRecoverableConflict(failure instanceof CaptureRequestError && [409, 410].includes(failure.status));
      setError(failure instanceof Error ? `${text.failure} ${failure.message}` : text.failure);
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (!submission.current.reset()) return;
    setFile(undefined);
    setPrompt('');
    setLanguage('auto');
    setDetected(undefined);
    setTitle('');
    setSourceName('');
    setSourceUrl('');
    setNotes('');
    setError('');
    setSavedItem(undefined);
    window.requestAnimationFrame(() => promptInput.current?.focus());
  };

  if (!open) return null;
  const savedImage = savedItem?.images[0];
  return <div className="modal-backdrop quick-capture-backdrop" onClick={close}>
    <div ref={containerRef} className="modal polished-modal quick-capture-modal" role="dialog" aria-modal="true" aria-labelledby="quick-capture-title" tabIndex={-1}
      onClick={event => event.stopPropagation()} onPaste={paste} onDrop={drop}
      onDragOver={event => {
        if (Array.from(event.dataTransfer.types).some(type => ['Files', 'text/uri-list', 'text/html'].includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; if (!locked && !savedItem) setDragging(true); }
      }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); return; }
        handleModalKeyDown(event);
      }}>
      <header className="quick-capture-header">
        <div><p className="modal-kicker">Image Prompt Library</p><h2 id="quick-capture-title">{text.heading}</h2><p>{text.intro}</p></div>
        <button type="button" className="iconbtn" onClick={close} disabled={saving} aria-label={text.close}><X size={21} /></button>
      </header>
      {savedItem ? <section className="quick-capture-success" role="status">
        {savedImage && <img src={mediaUrl(imageThumbnailPath(savedImage))} alt={savedItem.title} />}
        <div><h3><Check size={22} />{text.saved}</h3><p>{savedItem.title}</p><p className="muted">{text.savedHelp}</p></div>
        <div className="quick-capture-success-actions"><button type="button" className="primary" onClick={next}><Plus size={18} />{text.next}</button><button type="button" className="secondary" onClick={() => onFullEditor(savedItem)}>{text.fullEditor}</button></div>
      </section> : <form onSubmit={submit} className={dragging ? 'quick-capture-form is-dragging' : 'quick-capture-form'}>
        <div className="quick-capture-grid">
          <div className="quick-capture-image-column">
            <div className="quick-capture-pane-title">{text.image}</div>
            <input ref={fileInput} type="file" accept={CAPTURE_IMAGE_ACCEPT} className="sr-only" tabIndex={-1} disabled={locked || saving} onChange={event => { acceptFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
            <button type="button" className={`quick-capture-image${preview ? ' has-image' : ''}`} onClick={() => fileInput.current?.click()} disabled={locked || saving} aria-label={file ? text.replace : text.choose}>
              {preview && !previewFailed ? <img src={preview} alt={text.image} onError={() => setPreviewFailed(true)} /> : <span><ImagePlus size={38} /><strong>{previewFailed ? text.imagePreviewFailed : text.drop}</strong><span>{text.paste}</span><span className="quick-capture-choose">{file ? text.replace : text.choose}</span></span>}
              {preview && !previewFailed && <span className="quick-capture-replace">{text.replace}</span>}
            </button>
            <p className="quick-capture-note">{text.imageNote}</p>
          </div>
          <div className="quick-capture-content">
            <label className="quick-capture-prompt"><span>{text.prompt}</span><textarea ref={promptInput} data-modal-initial-focus value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={text.promptPlaceholder} disabled={locked || saving} spellCheck={false} /></label>
            <div className="quick-capture-language">
              <label><span>{text.language}</span><select aria-label={text.language} value={language} onChange={event => setLanguage(event.target.value as CaptureLanguage)} disabled={locked || saving}>{(['auto', 'en', 'zh_hans', 'zh_hant', 'und'] as const).map(value => <option key={value} value={value}>{text[value]}</option>)}</select></label>
              <p aria-live="polite">{language !== 'auto' ? text.manual : detecting ? text.detecting : detected ? `${text.detected}：${text[detected.language]}${detected.uncertain ? ` · ${text.uncertain}` : ''}` : text.uncertain}</p>
            </div>
          </div>
        </div>
        <details className="quick-capture-details"><summary><ChevronDown size={16} />{text.details}</summary>
          <div className="quick-capture-fields">
            <label><span>{text.title}</span><input value={title} onChange={event => setTitle(event.target.value)} placeholder={text.titlePlaceholder} disabled={locked || saving} /></label>
            <label><span>{text.source}</span><input value={sourceName} onChange={event => setSourceName(event.target.value)} placeholder={text.sourcePlaceholder} disabled={locked || saving} /></label>
            <label><span>{text.url}</span><input type="url" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} placeholder="https://…" disabled={locked || saving} /></label>
            <label><span>{text.notes}</span><textarea value={notes} onChange={event => setNotes(event.target.value)} rows={3} disabled={locked || saving} /></label>
          </div>
        </details>
        {error && <div className="quick-capture-error" role="alert"><p>{error}</p>{locked && !saving && !recoverableConflict && <p>{text.uncertainSave}</p>}{recoverableConflict && <button type="button" className="secondary" onClick={() => { if (confirm(text.unlockConfirm)) { submission.current.reset(); setRecoverableConflict(false); setError(''); } }}>{text.unlock}</button>}</div>}
        <footer className="quick-capture-footer"><div><span>{text.shortcut}</span><span>{text.draftKept}</span></div><button type="submit" className="primary" disabled={saving || !file || !prompt.trim()}>{saving ? text.saving : locked ? text.retry : text.save}</button></footer>
      </form>}
    </div>
  </div>;
}
