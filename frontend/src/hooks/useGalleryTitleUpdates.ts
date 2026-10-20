import { useCallback, useEffect, useRef } from 'react';
import { api } from '../api/client';

// Read-only status checks: collecting an image is the only action that starts naming.
export function useGalleryTitleUpdates(onUpdated: (itemId: string) => void) {
  const pending = useRef(new Map<string, { timer?: number; attempts: number; failures: number }>());
  const alive = useRef(true);
  const notify = useRef(onUpdated);
  notify.current = onUpdated;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const request of pending.current.values()) window.clearTimeout(request.timer);
      pending.current.clear();
    };
  }, []);
  return useCallback((itemId: string) => {
    if (pending.current.has(itemId)) return;
    const request = { attempts: 0, failures: 0, timer: undefined as number | undefined };
    pending.current.set(itemId, request);
    const current = () => alive.current && pending.current.get(itemId) === request;
    const poll = async () => {
      request.attempts++;
      try {
        const result = await api.galleryTitleStatus(itemId);
        if (!current()) return;
        request.failures = 0;
        if (!['pending', 'running'].includes(result.status)) {
          pending.current.delete(itemId);
          notify.current(itemId);
          return;
        }
      } catch {
        if (!current()) return;
        request.failures++;
      }
      if (request.attempts >= 120 || request.failures >= 3) {
        pending.current.delete(itemId);
        return;
      }
      request.timer = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
  }, []);
}
