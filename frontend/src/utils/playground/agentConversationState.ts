/* Adapted from CookSleep/gpt_image_playground src/lib/agentConversationState.ts
 * commit 1e9d5af60aadd9117a835cc2da43908b8e3370dd, MIT, Copyright (c) 2026 CookSleep.
 * IPL keeps authoritative conversation state on the server; no browser hydration
 * converts live running rounds into errors.
 */
export interface BranchRound {
  id: string;
  parentRoundId?: string | null;
  index: number;
  prompt: string;
  outputTaskIds: string[];
}
export interface BranchConversation<R extends BranchRound = BranchRound> {
  title: string;
  activeRoundId?: string | null;
  rounds: R[];
  messages: Array<{ content: string }>;
}

function getAgentRoundChildren<R extends BranchRound>(conversation: BranchConversation<R>, parentRoundId: string | null) {
  return conversation.rounds.filter(round => (round.parentRoundId ?? null) === parentRoundId);
}

function getLatestAgentLeafId<R extends BranchRound>(conversation: BranchConversation<R>, startRoundId: string | null = null): string | null {
  let currentId = startRoundId;
  if (!currentId) {
    const roots = getAgentRoundChildren(conversation, null);
    currentId = roots[roots.length - 1]?.id ?? null;
  }
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const children: R[] = getAgentRoundChildren(conversation, currentId);
    const nextId: string | null = children[children.length - 1]?.id ?? null;
    if (!nextId) return currentId;
    currentId = nextId;
  }
  return null;
}

export function getAgentRoundPath<R extends BranchRound>(conversation: BranchConversation<R>, roundId: string | null): R[] {
  if (!roundId) return [];
  const byId = new Map(conversation.rounds.map(round => [round.id, round]));
  const path: R[] = [];
  const seen = new Set<string>();
  let current = byId.get(roundId) ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentRoundId ? byId.get(current.parentRoundId) ?? null : null;
  }
  return path;
}

export function getActiveAgentRounds<R extends BranchRound>(conversation: BranchConversation<R>): R[] {
  const activeId = conversation.activeRoundId && conversation.rounds.some(round => round.id === conversation.activeRoundId)
    ? conversation.activeRoundId : getLatestAgentLeafId(conversation);
  return getAgentRoundPath(conversation, activeId ?? null);
}

export function getAgentSiblingRounds<R extends BranchRound>(conversation: BranchConversation<R>, round: R): R[] {
  return getAgentRoundChildren(conversation, round.parentRoundId ?? null);
}

export function getAgentBranchLeafId<R extends BranchRound>(conversation: BranchConversation<R>, roundId: string): string {
  return getLatestAgentLeafId(conversation, roundId) ?? roundId;
}

export function getConversationSearchText<R extends BranchRound>(conversation: BranchConversation<R>): string {
  return [conversation.title, ...conversation.messages.map(message => message.content), ...conversation.rounds.map(round => round.prompt)].join('\n').toLocaleLowerCase();
}
