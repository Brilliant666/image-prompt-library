import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ItemSortMode, ItemSummary } from '../types';
import type { Translator } from '../utils/i18n';
import ItemCard from './ItemCard';
import ScopeHeader from './ScopeHeader';
import './LibraryCardLayout.css';

type CardLayout = 'vertical' | 'horizontal';
const CARD_LAYOUT_KEY = 'image-prompt-library.library_card_layout.v1';
function loadCardLayout(): CardLayout {
  try { return window.localStorage.getItem(CARD_LAYOUT_KEY) === 'horizontal' ? 'horizontal' : 'vertical'; }
  catch { return 'vertical'; }
}

export default function CardsView({
  items,
  loading = false,
  emptyMode,
  t,
  onOpen,
  onFavorite,
  onEdit,
  editingItemId,
  onToggleSelection,
  selectedIds,
  onCopyPrompt,
  onAdd,
  onOpenConfig,
  total,
  sort,
  onSort,
  clusterName,
  hasActiveSearch = false,
  onClearCluster,
  hasMore = false,
  loadingMore = false,
  loadMoreError,
  onLoadMore,
}: {
  items: ItemSummary[];
  loading?: boolean;
  emptyMode?: 'first-run' | 'no-results';
  t: Translator;
  onOpen: (id: string) => void;
  onFavorite?: (id: string) => void;
  onEdit?: (item: ItemSummary) => void;
  editingItemId?: string;
  onToggleSelection?: (id: string) => void;
  selectedIds?: Set<string>;
  onCopyPrompt: (item: ItemSummary) => void;
  onAdd?: () => void;
  onOpenConfig?: () => void;
  total: number;
  sort: ItemSortMode;
  onSort: (sort: ItemSortMode) => void;
  clusterName?: string;
  hasActiveSearch?: boolean;
  onClearCluster: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreError?: string;
  onLoadMore?: () => void;
}) {
  const [layout, setLayout] = useState<CardLayout>(loadCardLayout);
  const [columnCount, setColumnCount] = useState(1);
  const gridRef = useRef<HTMLElement | null>(null);
  const sparseCount = clusterName && items.length <= 8 ? items.length : 0;
  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (layout !== 'horizontal' || !grid) return;
    const measureColumns = () => {
      const width = grid.getBoundingClientRect().width;
      // Match the existing vertical CSS columns and sparse-collection breakpoints.
      const count = window.innerWidth <= 400 ? 1
        : window.innerWidth <= 760 ? (sparseCount === 1 ? 1 : 2)
          : sparseCount ? Math.min(sparseCount, 3)
            : Math.max(1, Math.floor((width + 18) / (205 + 18)));
      setColumnCount(current => current === count ? current : count);
    };
    measureColumns();
    const observer = new ResizeObserver(measureColumns);
    observer.observe(grid);
    window.addEventListener('resize', measureColumns);
    return () => { observer.disconnect(); window.removeEventListener('resize', measureColumns); };
  }, [layout, sparseCount, hasItems]);
  const changeLayout = (value: string) => {
    const next = value === 'horizontal' ? 'horizontal' : 'vertical';
    setLayout(next);
    try { window.localStorage.setItem(CARD_LAYOUT_KEY, next); } catch { /* Keep the in-session choice if storage is unavailable. */ }
  };
  const layoutControl = <label className="scope-sort-control library-layout-control">
    <span className="scope-sort-prefix">{t('libraryCardLayout')}</span>
    <span className="scope-sort-picker">
      <select className="scope-sort-select" aria-label={t('libraryCardLayout')} value={layout} onChange={event => changeLayout(event.currentTarget.value)}>
        <option value="vertical">{t('libraryVerticalLayout')}</option>
        <option value="horizontal">{t('libraryHorizontalLayout')}</option>
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  </label>;
  const showActions = Boolean(onFavorite && onEdit) && !onToggleSelection;
  if (!items.length && loading) {
    return (
      <>
        <ScopeHeader
          t={t}
          title={clusterName || t(hasActiveSearch ? 'searchResults' : 'allReferences')}
          count={0}
          countLabel={t('referencesShown')}
          sort={sort}
          onSort={onSort}
          extraControls={layoutControl}
        />
        <div className="content-loading-state" role="status" aria-label={t('loading')}>
          <span /><span /><span />
        </div>
      </>
    );
  }
  if (!items.length && emptyMode === 'first-run') {
    return (
      <>
        <ScopeHeader
          t={t}
          title={t(hasActiveSearch ? 'searchResults' : 'allReferences')}
          count={0}
          countLabel={t('referencesShown')}
          sort={sort}
          onSort={onSort}
          extraControls={layoutControl}
        />
        <div className="empty first-run-empty">
          <p className="empty-eyebrow">{t('firstRunLocalInstall')}</p>
          <h2>{t('firstRunEmptyTitle')}</h2>
          <p>{t('firstRunEmptyHelp')}</p>
          <div className="empty-actions">
            {onAdd && <button className="empty-primary" onClick={onAdd}>{t('addFirstPrompt')}</button>}
            {onOpenConfig && <button className="secondary" onClick={onOpenConfig}>{t('firstRunOpenConfig')}</button>}
          </div>
          <div className="first-run-command">
            <span>{t('firstRunSampleHelp')}</span>
            <code>{t('firstRunSampleCommand')}</code>
          </div>
          <p className="first-run-generation-hint">{t('firstRunGenerationHelp')}</p>
        </div>
      </>
    );
  }

  if (!items.length) {
    return (
      <>
        <ScopeHeader
          t={t}
          title={clusterName || t(hasActiveSearch ? 'searchResults' : 'allReferences')}
          count={total}
          countLabel={t('referencesShown')}
          sort={sort}
          onSort={onSort}
          extraControls={layoutControl}
          backLabel={clusterName ? t(hasActiveSearch ? 'searchResults' : 'allReferences') : undefined}
          onBack={clusterName ? onClearCluster : undefined}
        />
        <div className="empty">
          <h2>{t('noMatchingPrompts')}</h2>
          <p>{t('noMatchingPromptsHelp')}</p>
          <div className="empty-actions">
            {onAdd && <button className="empty-primary" onClick={onAdd}>{t('addFirstPrompt')}</button>}
          </div>
        </div>
      </>
    );
  }

  const renderCard = (item: ItemSummary) => (
    <ItemCard key={item.id} t={t} item={item} onOpen={onOpen} onFavorite={onFavorite} onEdit={onEdit} editBusy={editingItemId === item.id} onToggleSelection={onToggleSelection} isSelecting={Boolean(onToggleSelection)} isSelected={Boolean(selectedIds?.has(item.id))} onCopyPrompt={onCopyPrompt} showActions={showActions} />
  );

  return (
    <>
      <ScopeHeader
        t={t}
        title={clusterName || t(hasActiveSearch ? 'searchResults' : 'allReferences')}
        count={total}
        countLabel={t('referencesShown')}
        sort={sort}
        onSort={onSort}
        extraControls={layoutControl}
        backLabel={clusterName ? t(hasActiveSearch ? 'searchResults' : 'allReferences') : undefined}
        onBack={clusterName ? onClearCluster : undefined}
      />
      <section ref={gridRef} className={`cards-grid masonry-like responsive-cards-grid${layout === 'horizontal' ? ' library-horizontal' : ''}${onToggleSelection ? ' is-selecting' : ''}${sparseCount ? ` is-sparse sparse-count-${sparseCount}` : ''}`}>
        {layout === 'horizontal'
          ? Array.from({ length: columnCount }, (_, column) => <div className="library-arrangement-column" key={column}>
            {items.filter((_, index) => index % columnCount === column).map(renderCard)}
          </div>)
          : items.map(renderCard)}
      </section>
      {loadMoreError && <p className="error" role="alert">{t('loadFailed')}</p>}
      {hasMore && <button type="button" className="explore-load-more" onClick={onLoadMore} disabled={loading || loadingMore}>
        {t(loadingMore ? 'loading' : loadMoreError ? 'retry' : 'more')}
      </button>}
    </>
  );
}
