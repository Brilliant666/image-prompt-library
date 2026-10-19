import type { GenerationJobRecord } from '../types';

const COMMON_RATIOS = [[1, 1], [3, 2], [2, 3], [4, 3], [3, 4], [16, 9], [9, 16], [21, 9], [9, 21], [5, 4], [4, 5], [6, 5], [5, 6], [2, 1], [1, 2]];

/** Only decoded output dimensions are accepted; requested size is never a fallback. */
export function galleryImageDimensions(job: Pick<GenerationJobRecord, 'result_width' | 'result_height'>) {
  const width = job.result_width, height = job.result_height;
  if (typeof width !== 'number' || typeof height !== 'number'
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return;
  let a = width, b = height;
  while (b) [a, b] = [b, a % b];
  const exact = `${width / a}:${height / a}`;
  let ratio = exact;
  // Prefer exact, readable ratios. Otherwise approximate a familiar ratio only
  // within 2%, keeping the exact dimensions alongside it and the ratio in its title.
  if (width / a > 30 || height / a > 30) {
    const actual = width / height;
    const nearest = COMMON_RATIOS.reduce((best, candidate) =>
      Math.abs(actual / (candidate[0] / candidate[1]) - 1) < Math.abs(actual / (best[0] / best[1]) - 1) ? candidate : best);
    if (Math.abs(actual / (nearest[0] / nearest[1]) - 1) <= 0.02) ratio = `≈${nearest[0]}:${nearest[1]}`;
  }
  return { pixels: `${width} × ${height}`, ratio, exactRatio: exact };
}

/** Application task time, excluding queue time and later acceptance/cleanup. */
export function galleryTaskElapsed(job: Pick<GenerationJobRecord, 'status' | 'started_at' | 'completed_at'>, now = Date.now()) {
  if (!job.started_at || !['running', 'succeeded', 'accepted', 'failed', 'cancelled', 'discarded'].includes(job.status)) return;
  const running = job.status === 'running';
  const start = Date.parse(job.started_at);
  const end = running ? now : job.completed_at ? Date.parse(job.completed_at) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  const seconds = Math.floor((end - start) / 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const label = seconds >= 3600
    ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
    : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  return { label, running };
}
