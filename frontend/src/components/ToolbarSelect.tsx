import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './ToolbarSelect.css';

export interface ToolbarSelectOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

interface Props<Value extends string> {
  value: Value;
  options: readonly ToolbarSelectOption<Value>[];
  onChange: (value: Value) => void;
  label: string;
  prefix?: string;
  className?: string;
  disabled?: boolean;
}

interface MenuPosition { left: number; top: number; width: number; maxHeight: number; above: boolean }

/** A short, explicit-choice list. Keyboard navigation never commits a value. */
export default function ToolbarSelect<Value extends string>({ value, options, onChange, label, prefix, className = '', disabled = false }: Props<Value>) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition>();
  const selectedIndex = options.findIndex(option => option.value === value);
  const selected = options[selectedIndex];
  const unavailable = () => disabled || !options.some(option => !option.disabled)
    || Boolean(triggerRef.current?.closest('[inert], [hidden], [aria-hidden="true"]'));
  const close = (restoreFocus = false) => {
    setOpen(false);
    setPosition(undefined);
    composing.current = false;
    if (restoreFocus && !unavailable()) triggerRef.current?.focus({ preventScroll: true });
  };
  const show = (edge?: 'first' | 'last') => {
    if (unavailable()) return;
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    setActiveIndex(edge === 'last' ? enabled[enabled.length - 1]
      : edge === 'first' || selectedIndex < 0 || selected?.disabled ? enabled[0] : selectedIndex);
    setOpen(true);
  };
  const choose = (index: number) => {
    if (unavailable()) { close(); return; }
    const option = options[index];
    if (!option || option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (unavailable()) { if (open) close(); return; }
    if (event.key === 'Tab') { if (open) close(); return; }
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); close(true); }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation();
      if (open) choose(activeIndex); else show();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!open) { show(event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined); return; }
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    const current = enabled.indexOf(activeIndex);
    setActiveIndex(event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled[enabled.length - 1]
      : enabled[Math.max(0, Math.min(enabled.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]);
  };

  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    if (unavailable()) { close(); return; }
    // An external value/options update must not leave an invalid active descendant.
    if (!options[activeIndex] || options[activeIndex].disabled) {
      setActiveIndex(selected && !selected.disabled ? selectedIndex : options.findIndex(option => !option.disabled));
    }
  }, [open, options, activeIndex, selectedIndex, disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current, menu = menuRef.current;
    if (!trigger || !menu) return;
    const place = () => {
      if (unavailable()) { close(); return; }
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const margin = 8, gap = 6;
      const menuWidth = Math.min(Math.max(rect.width, 210), Math.max(0, width - margin * 2));
      const left = Math.max(x + margin, Math.min(rect.left, x + width - menuWidth - margin));
      const below = Math.max(0, y + height - margin - rect.bottom - gap);
      const aboveSpace = Math.max(0, rect.top - y - margin - gap);
      const desiredHeight = Math.min(menu.scrollHeight, 280);
      const above = below < desiredHeight && aboveSpace > below;
      const maxHeight = Math.min(280, above ? aboveSpace : below);
      const actualHeight = Math.min(desiredHeight, maxHeight);
      const top = Math.max(y + margin, Math.min(above ? rect.top - gap - actualHeight : rect.bottom + gap, y + height - margin - actualHeight));
      setPosition(current => current && current.left === left && current.top === top && current.width === menuWidth && current.maxHeight === maxHeight && current.above === above
        ? current : { left, top, width: menuWidth, maxHeight, above });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = new ResizeObserver(place);
    observer.observe(trigger); observer.observe(menu);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      observer.disconnect();
    };
  }, [open, disabled]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    // Portals do not inherit inert. Close as soon as the toolbar's ancestors become inert.
    const observer = new MutationObserver(() => { if (unavailable()) close(); });
    for (let ancestor: HTMLElement | null = triggerRef.current; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] });
    }
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      observer.disconnect();
    };
  }, [open, disabled]);

  useEffect(() => {
    if (open && position) menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, position]);

  return <>
    <button ref={triggerRef} type="button" role="combobox" className={`toolbar-select-trigger${className ? ` ${className}` : ''}`}
      aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-listbox` : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
      disabled={disabled || !options.some(option => !option.disabled)} onKeyDown={onKeyDown}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onClick={() => { if (open) close(); else show(); }}>
      {prefix && <span className="toolbar-select-prefix">{prefix}</span>}
      <span className="toolbar-select-value">{selected?.label ?? value}</span>
      <ChevronDown size={14} className="toolbar-select-chevron" aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menuRef} id={`${id}-listbox`} className="toolbar-select-menu" role="listbox" aria-label={label}
      data-placement={position?.above ? 'above' : 'below'}
      style={position ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight } : { visibility: 'hidden' }}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
        className={`toolbar-select-option${activeIndex === index ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}`}
        aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-option-index={index}
        onPointerMove={event => { if (event.pointerType === 'mouse' && !option.disabled) setActiveIndex(index); }}
        onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault(); }}
        onClick={() => choose(index)}>
        <span>{option.label}</span><Check size={14} aria-hidden="true" className="toolbar-select-check" />
      </div>)}
    </div>, document.body)}
  </>;
}
