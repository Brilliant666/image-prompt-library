const STATES = new Set(['disabled', 'pending', 'running', 'succeeded', 'failed', 'uncertain', 'skipped']);
export function organizerMetadata(value) {
  if (!value || !STATES.has(value.status)) return undefined;
  // Never persist arbitrary response/error fields, model output, or credentials.
  return { status: value.status, ...(typeof value.collection === 'string' && value.collection.trim() ? { collection: value.collection.slice(0, 100) } : {}) };
}
export function organizerLabel(value) {
  const labels = { pending: '已保存 · 等待自动整理', running: '已保存 · 正在自动整理', succeeded: '自动整理完成', failed: '整理失败，图片和原文已保存', uncertain: '整理结果未确认，不会自动重试', skipped: '已保留当前内容，跳过自动整理' };
  const label = labels[value?.status] || '';
  return label && value?.collection ? `${label} · ${value.collection}` : label;
}
export function pendingOrganizer(receipt) {
  return ['pending', 'running'].includes(receipt?.organizer?.status);
}
export function matchesReceipt(entry, target, update) {
  return Boolean(entry && entry.base_url === target.base_url && entry.instance_id === target.instance_id
    && entry.item_id === update.item_id && entry.request_id === update.request_id);
}
export function updateReceiptMetadata(entry, update) {
  const organizer = organizerMetadata(update.organizer);
  return { ...entry,
    ...(typeof update.title === 'string' && update.title.trim() ? { title: update.title.slice(0, 300) } : {}),
    ...(organizer ? { organizer } : {}),
  };
}
