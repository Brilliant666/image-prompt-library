import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';
import type { ClusterRecord } from '../types';
import type { Translator } from '../utils/i18n';
import './CollectionPicker.css';

export type CollectionSelection = { id: string; name: string } | { id: null; name: string };

export default function CollectionPicker({ value, collections, onChange, disabled, t }: {
  value: CollectionSelection;
  collections: ClusterRecord[];
  onChange: (value: CollectionSelection) => void;
  disabled?: boolean;
  t: Translator;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const labelId = useId();
  // Keep an existing selection available even if the current list omits it.
  const options: Pick<ClusterRecord, 'id' | 'name' | 'names'>[] = value.id && !collections.some(collection => collection.id === value.id)
    ? [{ id: value.id, name: value.name, names: {} }, ...collections] : collections;
  const term = query.trim().toLocaleLowerCase();
  const names = (collection: typeof options[number]) => [collection.name, ...Object.values(collection.names || {})];
  const matches = options.filter(collection => names(collection).some(name => name?.toLocaleLowerCase().includes(term)));
  const exactMatch = options.some(collection => names(collection).some(name => name?.toLocaleLowerCase() === term));
  const selectedName = options.find(collection => collection.id === value.id)?.name || value.name;

  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const choose = (selection: CollectionSelection) => {
    if (disabled) return;
    onChange(selection);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.collection-picker-option') || []);
      if (!buttons.length) return;
      event.preventDefault();
      event.stopPropagation();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };

  return <div className="field collection-picker" ref={root} onKeyDown={keyDown}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <span id={labelId}>{t('collection')}</span>
    <button type="button" ref={trigger} className="collection-picker-trigger" disabled={disabled}
      aria-labelledby={`${labelId} ${panelId}-value`} aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => { setQuery(''); setOpen(current => !current); }}>
      <span id={`${panelId}-value`}>{selectedName || t('collectionUnassigned')}</span>
      <ChevronDown size={17} aria-hidden="true" />
    </button>
    {open && <div className="collection-picker-panel" id={panelId} role="region" aria-labelledby={labelId}>
      <label className="collection-picker-search">
        <Search size={16} aria-hidden="true" />
        <input ref={search} value={query} onChange={event => setQuery(event.target.value)}
          placeholder={t('collectionSearch')} aria-label={t('collectionSearch')} />
      </label>
      <div className="collection-picker-options">
        <button type="button" className="collection-picker-option" aria-pressed={!value.id && !value.name}
          onClick={() => choose({ id: null, name: '' })}>
          <span>{t('collectionUnassigned')}</span>{!value.id && !value.name && <Check size={16} aria-hidden="true" />}
        </button>
        {matches.map(collection => <button type="button" key={collection.id} className="collection-picker-option"
          aria-pressed={collection.id === value.id} onClick={() => choose({ id: collection.id, name: collection.name })}>
          <span>{collection.name}</span>{collection.id === value.id && <Check size={16} aria-hidden="true" />}
        </button>)}
        {!matches.length && <p className="collection-picker-empty">{t('collectionNoMatches')}</p>}
        {term && !exactMatch && <button type="button" className="collection-picker-option collection-picker-create"
          onClick={() => choose({ id: null, name: query.trim() })}>
          <span>{t('collectionCreate').replace('{name}', query.trim())}</span><Plus size={16} aria-hidden="true" />
        </button>}
      </div>
      <p className="collection-picker-help">{t('collectionSaveHint')}</p>
    </div>}
  </div>;
}
