import type { GenerationJobRecord } from '../types';
import type { Translator } from '../utils/i18n';
import { compatibleMismatches } from '../utils/compatibleRecipe';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function reported(value: unknown, t: Translator) {
  return typeof value === 'string' && value.trim() || typeof value === 'number' ? String(value) : t('notReported');
}

export function GenerationResultSummary({ job, t }: { job: GenerationJobRecord; t: Translator }) {
  if (job.provider !== 'openai_compatible') return null;
  const requested = record(job.metadata?.requested);
  const decoded = record(job.metadata?.decoded_image);
  const response = record(job.metadata?.response);
  const diagnostics = record(job.metadata?.error_diagnostics || job.metadata?.request_diagnostics);
  const hasDecodedImage = typeof decoded.width === 'number' && decoded.width > 0
    && typeof decoded.height === 'number' && decoded.height > 0 && typeof decoded.format === 'string';
  const succeeded = Boolean(job.result_path && hasDecodedImage && ['succeeded', 'accepted'].includes(job.status));
  const mismatches = compatibleMismatches(job);
  const status = succeeded ? mismatches.length ? 'imageResultMismatch' : 'imageResultDecoded' : 'imageResultUnverified';
  const size = (value: unknown) => reported(value, t).replace(/^(\d+)x(\d+)$/, '$1 × $2');
  const format = (value: unknown) => typeof value === 'string' ? value.toUpperCase() : t('notReported');
  const facts: [Parameters<Translator>[0], unknown][] = [
    ['requestedImageModel', requested.model], ['returnedImageModel', response.model],
    ['imageServiceQuality', response.quality], ['imageServiceSize', response.size],
    ['imageRequestId', response.request_id || diagnostics.request_id],
    ['imageElapsed', typeof diagnostics.elapsed_seconds === 'number' ? `${diagnostics.elapsed_seconds} s` : undefined],
    ['imageHttpStatus', diagnostics.http_status],
  ];
  const raw: [Parameters<Translator>[0], unknown][] = [
    ['imageRequestDetails', job.metadata?.requested], ['imageResponseDetails', job.metadata?.response],
    ['imageDecodedDetails', job.metadata?.decoded_image], ['imageDiagnostics', Object.keys(diagnostics).length ? diagnostics : undefined],
  ];
  return <section className={`generation-result-summary${mismatches.length ? ' is-warning' : succeeded ? ' is-success' : ''}`} aria-label={t('generationRecord')}>
    <strong className="generation-result-summary-status">{t(status)}</strong>
    <div className="generation-result-comparison">
      <div><span>{t('imageRequestedOutput')}</span><strong>{size(requested.size)} · {format(requested.output_format)}</strong><small>{t('queueQuality')}: {reported(requested.quality, t)}</small></div>
      <div><span>{t('imageActualOutput')}</span><strong>{hasDecodedImage ? `${decoded.width} × ${decoded.height} · ${format(decoded.format)}` : t('notReported')}</strong><small>{decoded.has_transparent_pixels === true ? t('imageActualTransparent') : decoded.has_transparent_pixels === false ? t('imageActualOpaque') : t('notReported')}</small></div>
    </div>
    {mismatches.length > 0 && <p className="generation-result-warning" role="status">{mismatches.map(key => t(key)).join(' ')}</p>}
    <details className="generation-result-diagnostics">
      <summary>{t('imageMoreDetails')}</summary>
      <dl className="generation-result-facts">{facts.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{reported(value, t)}</dd></div>)}</dl>
      <p className="muted">{t('imageResponseDetails')}</p>
      {(job.status === 'failed' || job.status === 'cancelled') && <p>{t('imageLocalCancelNote')}</p>}
      <details className="generation-result-raw"><summary>{t('imageRawRecords')}</summary>
        {raw.map(([key, value]) => <div key={key}><strong>{t(key)}</strong><pre>{value ? JSON.stringify(value, null, 2) : t('notReported')}</pre></div>)}
        <p>{job.started_at || job.created_at} → {job.completed_at || '—'}</p>
      </details>
    </details>
  </section>;
}
