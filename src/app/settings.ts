/**
 * Persisted app-level settings: TTS voice/rate/pitch, mic device, VAD sensitivity.
 * Stored in localStorage separately from the avatar config.
 */

const STORAGE_KEY = 'q-app-settings';

export interface PanelLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppSettings {
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  micDeviceId: string;
  vadMs: number;
  theme: string;
  panelLayouts?: PanelLayout[];
  snapThreshold: number;
  autoReconnect: boolean;
  notifyOnTurnEnd: boolean;
  /** Voice barge-in: a spoken utterance during a reply cuts it off (default off). */
  bargeIn: boolean;
  /** Whether the first-run onboarding overlay has been dismissed. */
  onboarded: boolean;
  /** claude --model for new sessions (empty = claude's default). */
  model: string;
  /** claude --effort for new sessions (empty = claude's default). */
  effort: string;
}

/** The valid HUD/orb themes (must stay in sync with THEME_PALETTES and the drawer buttons). */
export const THEME_NAMES = ['cyan', 'aurora', 'ember'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/** Default app settings; exported so callers compare against these instead of hardcoding. */
export const DEFAULT_SETTINGS: AppSettings = {
  ttsVoice: '',
  ttsRate: 0,
  ttsPitch: 0,
  micDeviceId: '',
  vadMs: 810,
  theme: 'cyan',
  snapThreshold: 12,
  autoReconnect: true,
  notifyOnTurnEnd: true,
  bargeIn: false,
  onboarded: false,
  model: '',
  effort: '',
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // Clamp a corrupt/hand-edited theme to a real palette so a bad value falls back to
    // the default rather than being silently ignored (no theme button would highlight).
    if (!THEME_NAMES.includes(merged.theme as ThemeName)) {
      merged.theme = DEFAULT_SETTINGS.theme;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage full or unavailable; silently drop
  }
}
