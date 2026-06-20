/**
 * Persisted app-level settings: TTS voice/rate/pitch, mic device, VAD sensitivity.
 * Stored in localStorage separately from the avatar config.
 */

const STORAGE_KEY = 'q-app-settings';

export interface AppSettings {
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  micDeviceId: string;
  vadMs: number;
  theme: string;
}

const DEFAULTS: AppSettings = {
  ttsVoice: '',
  ttsRate: 0,
  ttsPitch: 0,
  micDeviceId: '',
  vadMs: 810,
  theme: 'cyan',
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage full or unavailable; silently drop
  }
}
