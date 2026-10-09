const SUPPORTED_RATIOS = ['auto', '1:1', '3:4', '9:16', '4:3', '16:9'];

export function generationAspectRatio(parameters?: Record<string, unknown>, restoreLegacySize = false): string {
  const requested = parameters?.requested_aspect_ratio;
  if (typeof requested === 'string' && SUPPORTED_RATIOS.includes(requested)) return requested;
  if (!restoreLegacySize || typeof parameters?.size !== 'string') return 'auto';
  const size = /^(\d+)x(\d+)$/.exec(parameters.size);
  if (!size) return 'auto';
  const width = Number(size[1]);
  const height = Number(size[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return 'auto';
  // Restore only exact supported ratios; a legacy 2:3 image must not become 3:4.
  return SUPPORTED_RATIOS.slice(1).find(ratio => {
    const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
    return width * ratioHeight === height * ratioWidth;
  }) || 'auto';
}
