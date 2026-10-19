export interface LocalPreferences {
  enterSubmit: boolean;
  clearInputAfterSubmit: boolean;
  persistInputOnRestart: boolean;
  notifyOnCompletion: boolean;
}

export const LOCAL_PREFERENCES_DEFAULTS: LocalPreferences = {
  enterSubmit: false,
  clearInputAfterSubmit: false,
  persistInputOnRestart: false,
  notifyOnCompletion: false,
};
const STORAGE_KEY = 'image-prompt-library.local-preferences.v1';

export function readLocalPreferences(): LocalPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(LOCAL_PREFERENCES_DEFAULTS).map(([key, fallback]) =>
      [key, typeof value?.[key] === 'boolean' ? value[key] : fallback])) as unknown as LocalPreferences;
  } catch { return { ...LOCAL_PREFERENCES_DEFAULTS }; }
}

export function saveLocalPreferences(value: LocalPreferences): boolean {
  try {
    const safe = Object.fromEntries(Object.entries(LOCAL_PREFERENCES_DEFAULTS).map(([key, fallback]) => {
      const item = value[key as keyof LocalPreferences];
      return [key, typeof item === 'boolean' ? item : fallback];
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('ipl:local-preferences-changed'));
    return true;
  } catch { return false; }
}
