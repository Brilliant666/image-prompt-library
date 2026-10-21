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
  const scopeKey = JSON.stringify([q, clusterId, tag, viewLimit, reloadKey, sort]);
  const requestRef = useRef({ epoch: 0, scopeKey: '', ready: false, busy: false, nextOffset: 0, total: 0 });

  useEffect(() => {
    let cancelled = false;
    const request = { epoch: requestRef.current.epoch + 1, scopeKey, ready: false, busy: false, nextOffset: 0, total: 0 };
    requestRef.current = request;
    const hasVisibleData = data.items.length > 0 || data.total > 0;
    setLoading(true);
    setInitialLoading(!hasVisibleData);
    setRefreshing(hasVisibleData);
    setError(undefined);
    setLoadingMore(false);
    setLoadMoreError(undefined);
    setHasMore(false);

    api.items({ q, cluster: clusterId, tag, limit: viewLimit, offset: 0, sort })
      .then(nextData => {
        if (!cancelled) {
          setData(nextData);
          setDataScope({ q, clusterId, tag, viewLimit, sort });
          request.nextOffset = nextData.offset + nextData.items.length;
          request.total = nextData.total;
          request.ready = true;
          setHasMore(nextData.items.length > 0 && request.nextOffset < request.total);
        }
      })
      .catch(e => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setInitialLoading(false);
          setRefreshing(false);
        }
      });

    return () => { cancelled = true; request.ready = false; request.epoch += 1; };
  }, [q, clusterId, tag, viewLimit, reloadKey, sort, scopeKey]);

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
  }, [q, clusterId, tag, viewLimit, sort, scopeKey]);

  return { data, loading, initialLoading, refreshing, error, dataScope, hasMore, loadingMore, loadMoreError, loadMore };
}
