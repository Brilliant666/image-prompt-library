import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, type AgentConversationSummary } from '../../api/agentClient';

/** Search and pagination share a scope; they never change the open conversation. */
export function useAgentConversations(active: boolean, search: string) {
  const query = search.trim();
  const scope = useRef({ active, query });
  scope.current = { active, query };
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [rows, setRows] = useState<AgentConversationSummary[]>([]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [resultQuery, setResultQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async (cursor?: string) => {
    if (!scope.current.active) return;
    const requestedQuery = scope.current.query;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const token = ++sequence.current;
    const current = () => !abort.signal.aborted && token === sequence.current
      && scope.current.active && scope.current.query === requestedQuery;
    setLoading(true); setError('');
    try {
      const result = await agentApi.conversations(cursor, abort.signal, requestedQuery);
      if (!current()) return;
      setRows(old => cursor ? [...old, ...result.conversations.filter(row => !old.some(item => item.id === row.id))] : result.conversations);
      setResultQuery(requestedQuery); setNextCursor(result.nextCursor); setStale(false);
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : '会话读取失败');
    } finally { if (current()) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!active) { setLoading(false); return; }
    // A small delay avoids a database search for every keystroke. Cancellation
    // also protects against responses that finish after switching away.
    setLoading(true); setError('');
    const timer = setTimeout(() => void refresh(), query ? 220 : 0);
    return () => { clearTimeout(timer); ++sequence.current; controller.current?.abort(); };
  }, [active, query, refresh]);

  const upsert = useCallback((row: AgentConversationSummary) => {
    if (scope.current.query) {
      // A conversation poll must not replace a paginated search with page one,
      // or insert a row whose body has not been matched by the server. Keep the
      // current result window until the user explicitly refreshes its scope.
      const existing = rowsRef.current.find(item => item.id === row.id);
      if (!existing || existing.revision !== row.revision) setStale(true);
      return;
    }
    setRows(old => [row, ...old.filter(item => item.id !== row.id)].sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);
  const remove = useCallback((id: string) => setRows(old => old.filter(row => row.id !== id)), []);
  return {
    rows: resultQuery === query ? rows : [],
    nextCursor: resultQuery === query ? nextCursor : null,
    loading, error, stale, refresh, upsert, remove,
  };
}
