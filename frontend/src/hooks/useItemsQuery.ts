import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ItemList, ItemSortMode } from '../types';
import { DEFAULT_ITEM_SORT } from '../utils/searchSort';

type QueryScope = {
  q: string;
  clusterId?: string;
  tag?: string;
  viewLimit: number;
  sort: ItemSortMode;
};

export function useItemsQuery(q: string, clusterId?: string, tag?: string, viewLimit = 100, reloadKey = 0, sort: ItemSortMode = DEFAULT_ITEM_SORT) {
  const [data, setData] = useState<ItemList>({ items: [], total: 0, limit: viewLimit, offset: 0 });
  const [dataScope, setDataScope] = useState<QueryScope>({ q: '', clusterId: undefined, tag: undefined, viewLimit, sort });
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const queryKey = JSON.stringify([q, clusterId, tag, viewLimit, sort]);
  const scopeKey = JSON.stringify([queryKey, reloadKey]);
  const loadedWindowRef = useRef({ queryKey: '', nextOffset: 0 });
  const requestRef = useRef({ epoch: 0, scopeKey: '', ready: false, busy: false, nextOffset: 0, total: 0 });

  useEffect(() => {
    let cancelled = false;
    const request = { epoch: requestRef.current.epoch + 1, scopeKey, ready: false, busy: false, nextOffset: 0, total: 0 };
    requestRef.current = request;
    const sameQuery = loadedWindowRef.current.queryKey === queryKey;
    const targetOffset = sameQuery ? Math.max(viewLimit, loadedWindowRef.current.nextOffset) : viewLimit;
    const hasVisibleData = data.items.length > 0 || data.total > 0;
    setLoading(true);
    setInitialLoading(!hasVisibleData);
    setRefreshing(hasVisibleData);
    setError(undefined);
    setLoadingMore(false);
    setLoadMoreError(undefined);
    if (!sameQuery) setHasMore(false);

    // Refresh the already loaded window in bounded pages. Publish it atomically so
    // saving a card cannot briefly remove later pages and collapse the scroll area.
    const refresh = async () => {
      const items: ItemList['items'] = [];
      const ids = new Set<string>();
      let offset = 0;
      while (!cancelled) {
        const nextData = await api.items({ q, cluster: clusterId, tag, limit: viewLimit, offset, sort });
        if (cancelled) return;
        for (const item of nextData.items) {
          if (!ids.has(item.id)) { ids.add(item.id); items.push(item); }
        }
        const nextOffset = nextData.offset + nextData.items.length;
        const canContinue = nextData.items.length > 0 && nextOffset > offset && nextOffset < nextData.total;
        if (!canContinue || nextOffset >= targetOffset) {
          setData({ ...nextData, items, offset: 0 });
          setDataScope({ q, clusterId, tag, viewLimit, sort });
          loadedWindowRef.current = { queryKey, nextOffset };
          request.nextOffset = nextOffset;
          request.total = nextData.total;
          request.ready = true;
          setHasMore(canContinue);
          return;
        }
        offset = nextOffset;
      }
    };
    refresh()
      .catch(e => {
        if (!cancelled) {
          setError(String(e));
          setHasMore(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setInitialLoading(false);
          setRefreshing(false);
        }
      });

    return () => { cancelled = true; request.ready = false; request.epoch += 1; };
  }, [q, clusterId, tag, viewLimit, reloadKey, sort, scopeKey, queryKey]);

  const loadMore = useCallback(async () => {
    const request = requestRef.current;
    if (request.scopeKey !== scopeKey || !request.ready || request.busy || request.nextOffset >= request.total) return;
    const epoch = request.epoch;
    const current = () => requestRef.current === request && request.epoch === epoch;
    request.busy = true;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const nextData = await api.items({ q, cluster: clusterId, tag, limit: viewLimit, offset: request.nextOffset, sort });
      if (!current()) return;
      // Advance by the server page, even if a changed record also appeared on an earlier page.
      request.nextOffset = nextData.offset + nextData.items.length;
      request.total = nextData.total;
      loadedWindowRef.current = { queryKey, nextOffset: request.nextOffset };
      setData(previous => {
        const ids = new Set(previous.items.map(item => item.id));
        const additions = nextData.items.filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true; });
        return { ...previous, total: nextData.total, items: [...previous.items, ...additions] };
      });
      setHasMore(nextData.items.length > 0 && request.nextOffset < request.total);
      if (!nextData.items.length) request.ready = false;
    } catch (e) {
      if (current()) setLoadMoreError(String(e));
    } finally {
      if (current()) {
        request.busy = false;
        setLoadingMore(false);
      }
    }
  }, [q, clusterId, tag, viewLimit, sort, scopeKey, queryKey]);

  return { data, loading, initialLoading, refreshing, error, dataScope, hasMore, loadingMore, loadMoreError, loadMore };
}
