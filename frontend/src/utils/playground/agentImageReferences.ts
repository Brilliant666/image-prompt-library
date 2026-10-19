/* Adapted from CookSleep/gpt_image_playground src/lib/agentImageReferences.ts
 * commit 1e9d5af60aadd9117a835cc2da43908b8e3370dd, MIT, Copyright (c) 2026 CookSleep.
 * Generation-job IDs replace the source application's separate image database.
 */
export type AgentReference = { kind: 'library'; imageId: string } | { kind: 'job'; jobId: string } | { kind: 'upload'; uploadId: string };
export interface ReferenceChoice { reference: AgentReference; label: string; url: string; missing?: boolean }
export function referenceKey(ref: AgentReference): string {
  return ref.kind === 'library' ? `library:${ref.imageId}` : ref.kind === 'job' ? `job:${ref.jobId}` : `upload:${ref.uploadId}`;
}
export function uniqueReferences(refs: AgentReference[]): AgentReference[] {
  const seen = new Set<string>();
  return refs.filter(ref => { const key = referenceKey(ref); if (seen.has(key)) return false; seen.add(key); return true; });
}

export function resolveAgentPromptImageReferences(
  prompt: string,
  rounds: Array<{ outputTaskIds: string[] }>,
  availableJobIds: Set<string>,
  currentRefs: AgentReference[],
): { refs: AgentReference[]; missing: string[] } {
  const refs = [...currentRefs];
  const missing: string[] = [];
  for (const match of prompt.matchAll(/@(?:第)?(\d+)轮图(\d+)/g)) {
    const round = rounds[Number(match[1]) - 1];
    const jobId = round?.outputTaskIds[Number(match[2]) - 1];
    if (!jobId || !availableJobIds.has(jobId)) missing.push(match[0]);
    else refs.push({ kind: 'job', jobId });
  }
  for (const match of prompt.matchAll(/@图(\d+)/g)) {
    if (!currentRefs[Number(match[1]) - 1]) missing.push(match[0]);
  }
  return { refs: uniqueReferences(refs), missing: [...new Set(missing)] };
}

export function insertMention(text: string, start: number, end: number, mention: string) {
  const prefix = text.slice(0, start);
  const before = prefix.endsWith('@') ? prefix.slice(0, -1) : prefix;
  const next = `${before}${mention} ${text.slice(end)}`;
  return { text: next, caret: before.length + mention.length + 1 };
}
