import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { ItemSortMode } from '../types';
import type { Translator } from '../utils/i18n';
import ToolbarSelect from './ToolbarSelect';

export default function ScopeHeader({
  t,
  title,
  count,
  countLabel,
  sort,
  onSort,
  backLabel,
  onBack,
  extraControls,
}: {
  t: Translator;
  title: string;
  count: number;
  countLabel: string;
  sort?: ItemSortMode;
  onSort?: (sort: ItemSortMode) => void;
  backLabel?: string;
  onBack?: () => void;
  extraControls?: ReactNode;
}) {
  const showSort = Boolean(sort && onSort);

  return (
    <header className={`scope-header${onBack ? ' has-back' : ''}${extraControls ? ' has-extra-controls' : ''}`}>
      <div className="scope-heading">
        <h1>{title}</h1>
        <span className="scope-count">
          <span aria-hidden="true">· </span>
          {count}
          <span className="sr-only"> {countLabel}</span>
        </span>
      </div>
      {(onBack || showSort || extraControls) && (
        <div className={`scope-actions${onBack ? ' has-back' : ''}`}>
          {onBack && backLabel && (
            <button type="button" className="scope-back-button" onClick={onBack}>
              <ArrowLeft size={16} aria-hidden="true" />
              {backLabel}
            </button>
          )}
          {showSort && (
            <ToolbarSelect<ItemSortMode> className="scope-sort-control" label={t('sortChip')} prefix={t('sortChip')}
              value={sort!} onChange={value => onSort?.(value)} options={[
                { value: 'updated_desc', label: t('sortByUpdated') },
                { value: 'created_desc', label: t('sortByCreated') },
                { value: 'created_asc', label: t('sortByOldest') },
                { value: 'title_asc', label: t('sortByTitle') },
                { value: 'title_desc', label: t('sortByTitleDesc') },
                { value: 'source_asc', label: t('sortBySource') },
                { value: 'model_asc', label: t('sortByModel') },
              ]} />
          )}
          {extraControls}
        </div>
      )}
    </header>
  );
}
