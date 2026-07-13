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
  /** TTS engine: 'kokoro' (neural, default) or 'sapi' (Windows system voices). */
  ttsEngine: string;
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
  /** Wake word: listen continuously and only act on utterances that start with
   *  "Oracle" (default on). Turn off to use plain tap-to-talk. */
  wakeWord: boolean;
  /** Whether the first-run onboarding overlay has been dismissed. */
  onboarded: boolean;
  /** Show the TRANSCRIPT panel (default on). It duplicates the session window's
   *  conversation once a session view is open, so it is hot-bar toggleable. */
  showTranscript: boolean;
  /** MCP servers disabled in the Library panel. Everything the user registered
   *  user-scope is allowed by default (Q inherits their terminal's MCP world);
   *  a name here is excluded from new sessions' allowlists. */
  disabledMcp: string[];
  /** Hook ids disabled in the Library panel (stable content hashes from the Rust
   *  side); a matching hook is removed from new sessions via a --settings hooks
   *  override. Editing a hook changes its id, which naturally re-enables it. */
  disabledHooks: string[];
  /** claude --model for new sessions (empty = claude's default). */
  model: string;
  /** claude --effort for new sessions (empty = claude's default). */
  effort: string;
}

/** The valid HUD/orb themes (must stay in sync with THEME_PALETTES and the drawer buttons). */
export const THEME_NAMES = ['cyan', 'aurora', 'ember'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/**
 * Effort levels each model tier accepts (the empty key is "default model" = an unknown
 * model, so it gets a conservative subset valid on any tier). Opus 4.8 additionally offers
 * `ultracode` - a Claude Code session setting (xhigh + dynamic-workflow orchestration) that
 * the Rust spawn translates to `--settings {"ultracode":true}` because it is NOT a real
 * `--effort` value (the CLI silently ignores it as an effort). Sonnet 4.6 has no `xhigh`;
 * Haiku 4.5 does not support the effort parameter at all.
 */
export const EFFORT_BY_MODEL: Record<string, string[]> = {
  opus: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  sonnet: ['low', 'medium', 'high', 'max'],
  haiku: [],
  '': ['low', 'medium', 'high'],
};

/** The effort levels a model value offers (unknown models fall back to the safe subset). */
export function effortLevelsForModel(model: string): string[] {
  return EFFORT_BY_MODEL[model] ?? EFFORT_BY_MODEL[''];
}

/**
 * Clamp a saved effort to one the model actually offers: returns the effort unchanged when
 * it is valid (or the empty "default effort"), otherwise '' so a stale combo left in
 * localStorage (e.g. sonnet+xhigh, haiku+anything, sonnet+ultracode) self-heals to default.
 */
export function clampEffortToModel(model: string, effort: string): string {
  return effort === '' || effortLevelsForModel(model).includes(effort) ? effort : '';
}

/** Default app settings; exported so callers compare against these instead of hardcoding. */
export const DEFAULT_SETTINGS: AppSettings = {
  ttsVoice: '',
  ttsEngine: 'kokoro',
  ttsRate: 0,
  ttsPitch: 0,
  micDeviceId: '',
  // ~600 ms trailing-silence cutoff (matches the Rust default). Was 810; with the
  // end-of-speech now visibly acknowledged, a slightly eager cutoff feels snappy.
  vadMs: 600,
  theme: 'cyan',
  snapThreshold: 12,
  autoReconnect: true,
  notifyOnTurnEnd: true,
  bargeIn: false,
  wakeWord: true,
  onboarded: false,
  showTranscript: true,
  disabledMcp: [],
  disabledHooks: [],
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
