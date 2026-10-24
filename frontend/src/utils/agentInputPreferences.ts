export interface AgentInputPreferences {
  enterSubmit: boolean;
  clearInputAfterSubmit: boolean;
}

export const AGENT_INPUT_PREFERENCES_KEY = 'ipl.agent.input-preferences.v1';
export const AGENT_INPUT_PREFERENCES_EVENT = 'ipl:agent-input-preferences-changed';
export const AGENT_INPUT_PREFERENCES_DEFAULTS: AgentInputPreferences = {
  enterSubmit: true,
  clearInputAfterSubmit: true,
};

// Agent chat has its own defaults. Existing Gallery preferences are never
// migrated or rewritten when a user opens or customizes Agent.
export function readAgentInputPreferences(): AgentInputPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(AGENT_INPUT_PREFERENCES_KEY) || '{}');
    return Object.fromEntries(Object.entries(AGENT_INPUT_PREFERENCES_DEFAULTS).map(([key, fallback]) =>
      [key, typeof value?.[key] === 'boolean' ? value[key] : fallback])) as unknown as AgentInputPreferences;
  } catch { return { ...AGENT_INPUT_PREFERENCES_DEFAULTS }; }
}

export function saveAgentInputPreferences(value: AgentInputPreferences): boolean {
  try {
    const safe = Object.fromEntries(Object.entries(AGENT_INPUT_PREFERENCES_DEFAULTS).map(([key, fallback]) =>
      [key, typeof value[key as keyof AgentInputPreferences] === 'boolean' ? value[key as keyof AgentInputPreferences] : fallback]));
    localStorage.setItem(AGENT_INPUT_PREFERENCES_KEY, JSON.stringify(safe));
    window.dispatchEvent(new Event(AGENT_INPUT_PREFERENCES_EVENT));
    return true;
  } catch { return false; }
}
