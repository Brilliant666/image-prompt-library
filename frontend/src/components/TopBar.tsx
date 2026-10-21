import { Filter, Search, Settings, Plus, Trash2 } from 'lucide-react';
import headerLogo from '../assets/header-logo.png';
import type { ViewMode } from '../types';
import type { Translator } from '../utils/i18n';
import ViewToggle from './ViewToggle';

interface Props {
  q: string;
  t: Translator;
  queryFilterChips: string[];
  updateBadgeLabel?: string;
  onQ: (v: string) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  onFilters: () => void;
  onConfig: () => void;
  onCapture?: () => void;
  onTrash?: () => void;
  trashLabel?: string;
  filtersOpen?: boolean;
  configOpen?: boolean;
  hasActiveFilter?: boolean;
  modalOpen?: boolean;
}

export default function TopBar({
  q,
  t,
  queryFilterChips,
  updateBadgeLabel,
  onQ,
  view,
  onView,
  onFilters,
  onConfig,
  onCapture,
  onTrash,
  trashLabel,
  filtersOpen = false,
  configOpen = false,
  hasActiveFilter = false,
  modalOpen = false,
}: Props) {
  const hasActiveSearch = Boolean(queryFilterChips.length);
  const isLibraryView = view === 'explore' || view === 'cards';

  return (
    <>
      <header className="chrome" inert={modalOpen} aria-hidden={modalOpen || undefined}>
        <nav className="nav-row" aria-label={t('primaryNavigation')}>
          <div className="logo mobile-brand" aria-label={t('appHome')}>
            <img className="logo-mark" src={headerLogo} alt="" aria-hidden="true" />
            <b className="logo-wordmark" lang="en">Image Prompt Library</b>
          </div>

          <div className="view-dock">
            <ViewToggle t={t} view={view} onView={onView} />
          </div>

          <div className="header-actions">
            {onCapture && <button className="iconbtn workspace-capture" onClick={onCapture} aria-label="快捷收录" title="快捷收录"><Plus size={18}/><span>收录</span></button>}

            <button className="iconbtn config-button" onClick={onConfig} aria-label={t('config')} aria-haspopup="dialog" aria-expanded={configOpen} aria-controls="config-drawer">
              <Settings size={19} />
              {updateBadgeLabel && <span className="update-available-badge">{updateBadgeLabel}</span>}
            </button>
          </div>
        </nav>
      </header>

      <div className="library-tools" hidden={!isLibraryView} inert={modalOpen} aria-hidden={!isLibraryView || modalOpen || undefined}>
        <div className="library-toolbar">
          <label className="search toolbar-search" aria-label={t('searchAria')}>
            <Search size={20} />
            <input
              value={q}
              onChange={event => onQ(event.target.value)}
              placeholder={t('searchPlaceholder')}
            />
          </label>

          <button
            className={`vista-button filter-button${hasActiveFilter ? ' active' : ''}`}
            onClick={onFilters}
            aria-label={t('filters')}
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            aria-controls="filters-drawer"
          >
            <Filter size={18} />
            <span className="filter-label">{t('filters')}</span>
          </button>
          {view === 'cards' && onTrash && <button type="button" className="vista-button filter-button library-trash-trigger" onClick={onTrash} aria-label={trashLabel} title={trashLabel} aria-haspopup="dialog"><Trash2 size={18} /><span className="filter-label">{trashLabel}</span></button>}
        </div>

        {hasActiveSearch && isLibraryView && (
          <div className="status-row mobile-status-view-row">
            <div className="active-filter-strip" aria-label={t('currentFilters')}>
              {queryFilterChips.map(chip => <span key={chip} className="chip query-filter-chip">{chip}</span>)}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
