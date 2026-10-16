// Only metadata GETs use this deadline and sharing. Never retry image POSTs.
const pendingReads = new Map<string, Promise<unknown>>();
export const READ_TIMEOUT_MS = 15000;

export function readJson<T>(url: string, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  const pending = pendingReads.get(url);
  if (pending) return pending as Promise<T>;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Request timed out. Please retry.'));
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json() as Promise<T>;
  })();
  const result = Promise.race([request, deadline]).finally(() => {
    clearTimeout(timer);
    pendingReads.delete(url);
  });
  pendingReads.set(url, result);
  return result;
}
