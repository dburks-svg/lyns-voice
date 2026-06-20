import { VERSION } from '../index';
import { type ThemeName } from '../config/config';
import { attachTauri } from '../integration/tauriAdapter';
import { TelemetryPanels } from '../integration/telemetry';
import { attachDragResize } from './terminal/dragResize';
import { TerminalManager } from './terminal/TerminalManager';
import { loadSettings, saveSettings, type AppSettings } from './settings';

/**
 * Q desktop app entry.
 *
 * Mounts the holographic orb into the FUI stage through `attachTauri`, which owns
 * the voice-signal seam and the TTS path, and wires the four telemetry panels
 * (transcript / activity / session / waveform) to the live voice loop. The top
 * HUD cluster cycles the four states and drives a manual "speak" until the STT
 * (Phase 2) and Claude bridge (Phase 3) adapters take over. The state machine,
 * mood, and TTS are reused verbatim; only the renderer and the shell are new.
 */
async function bootstrap(): Promise<void> {
  const root = document.getElementById('avatar-root');
  if (!root) {
    return;
  }
  const label = document.getElementById('status');

  const byId = (id: string): HTMLElement | null => document.getElementById(id);
  const panels = new TelemetryPanels({
    transcript: byId('hud-transcript'),
    activity: byId('hud-activity'),
    wave: document.getElementById('hud-wave') as unknown as SVGElement | null,
    tokensIn: byId('hud-tokens-in'),
    tokensOut: byId('hud-tokens-out'),
    cost: byId('hud-cost'),
    turns: byId('hud-turns'),
    uptime: byId('hud-uptime'),
  });
  panels.startUptime();
  // One light rAF drives the oscilloscope every frame and the uptime ~4x/sec.
  let uptimeThrottle = 0;
  const tickPanels = (): void => {
    panels.tickWave();
    if ((uptimeThrottle = (uptimeThrottle + 1) % 15) === 0) {
      panels.tickUptime();
    }
    requestAnimationFrame(tickPanels);
  };
  requestAnimationFrame(tickPanels);

  const settings = loadSettings();

  const handle = attachTauri({
    root,
    caption: document.getElementById('caption'),
    onTranscript: (role, text) => panels.addTranscript(role, text),
    onActivity: (a) => panels.addActivity(a.name, a.target),
    onUsage: (u) => panels.addUsage(u),
    onBands: (bands) => panels.pushBands(bands),
    ttsSettings: () => ({
      rate: settings.ttsRate,
      pitch: settings.ttsPitch,
      voice: settings.ttsVoice,
    }),
    micDeviceId: () => settings.micDeviceId,
  });

  // Settings drawer toggle
  const settingsBtn = document.getElementById('settings-btn');
  const settingsDrawer = document.getElementById('settings-drawer');
  settingsBtn?.addEventListener('click', () => {
    const open = settingsDrawer?.hidden === false;
    if (settingsDrawer) settingsDrawer.hidden = open;
    settingsBtn.classList.toggle('active', !open);
  });

  // Tap-to-talk. Mic capture + local Whisper STT auto-finalize on a
  // pause; the recognized text appears in the caption. (Phase 3 sends it to Claude.)
  // Two controls share one toggle: the HUD `#mic-btn` and the footer `#mic-fab`
  // TAP TO TALK; both reflect the listening state.
  const micButton = document.getElementById('mic-btn');
  const micFab = document.getElementById('mic-fab');
  const reflectListening = (listening: boolean): void => {
    if (micButton) {
      micButton.textContent = listening ? 'stop' : 'talk';
      micButton.classList.toggle('active', listening);
    }
    micFab?.classList.toggle('active', listening);
  };
  const toggleMic = (): void => {
    if (handle.isListening()) {
      handle.stopListening();
      reflectListening(false);
      return;
    }
    void handle.startListening().then((ok) => {
      if (ok) {
        reflectListening(true);
      } else if (label) {
        label.textContent = 'mic permission denied';
      }
    });
  };
  micButton?.addEventListener('click', toggleMic);
  micFab?.addEventListener('click', toggleMic);

  // Phase 3: connect a Claude Code session in a project dir. Once connected,
  // spoken utterances are sent to Claude and the reply is spoken back with mood.
  const claudeDir = document.getElementById('claude-dir') as HTMLInputElement | null;
  const claudeButton = document.getElementById('claude-btn');
  claudeButton?.addEventListener('click', () => {
    if (handle.isClaudeConnected()) {
      handle.stopClaude();
      claudeButton.textContent = 'connect claude';
      claudeButton.classList.remove('active');
      if (label) {
        label.textContent = `Q v${VERSION}`;
      }
      return;
    }
    const dir = claudeDir?.value.trim();
    if (!dir) {
      if (label) {
        label.textContent = 'enter a project dir for Claude (it can act there by voice)';
      }
      return;
    }
    void handle.startClaude(dir).then((ok) => {
      if (label) {
        label.textContent = ok ? 'Claude connected' : 'claude start failed (see logs)';
      }
      if (ok) {
        claudeButton.textContent = 'disconnect';
        claudeButton.classList.add('active');
      }
    });
  });

  // --- Settings controls ---
  wireSettings(settings);

  // Apply saved theme on startup and wire buttons to switch it live
  if (settings.theme && settings.theme !== 'cyan') {
    handle.setTheme(settings.theme as ThemeName);
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.theme-btn')) {
    if (btn.dataset.theme === settings.theme) {
      for (const b of document.querySelectorAll('.theme-btn')) b.classList.remove('active');
      btn.classList.add('active');
    }
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme as ThemeName;
      handle.setTheme(theme);
      settings.theme = theme;
      saveSettings(settings);
    });
  }

  // Terminal windows: spawn draggable/resizable shells inside the app.
  const terminalLayer = document.getElementById('terminal-layer');
  const terminalBtn = document.getElementById('terminal-btn');
  const tauriGlobal = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  if (terminalLayer && tauriGlobal) {
    const tauri = tauriGlobal as {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    const { listen } = await import('@tauri-apps/api/event');
    const getCwd = (): string | undefined =>
      (document.getElementById('claude-dir') as HTMLInputElement | null)?.value.trim() || undefined;
    const termMgr = new TerminalManager(
      terminalLayer,
      {
        invoke: tauri.invoke.bind(tauri),
        listen: listen as (
          event: string,
          handler: (e: { payload: unknown }) => void,
        ) => Promise<() => void>,
      },
      getCwd,
    );
    terminalBtn?.addEventListener('click', () => {
      void termMgr.spawn(getCwd());
    });
  }

  // Make the four telemetry panels draggable and resizable. Wait one frame
  // so the grid layout has rendered, then snapshot each panel's position and
  // switch it to fixed positioning with drag/resize handles.
  requestAnimationFrame(() => {
    const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
    for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
      const rect = panel.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      panel.style.zIndex = '2';

      for (const d of DIRS) {
        const h = document.createElement('div');
        h.className = `resize-handle rh-${d}`;
        h.dataset.dir = d;
        panel.appendChild(h);
      }

      const head = panel.querySelector<HTMLElement>('.panel-head');
      if (head) {
        head.style.cursor = 'grab';
        attachDragResize({ el: panel, dragHandle: head, minWidth: 180, minHeight: 100 });
      }
    }
  });

  if (label) {
    label.textContent = `Q v${VERSION}`;
  }
}

function wireSettings(settings: AppSettings): void {
  const tauriGlobal = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  const invoke = tauriGlobal
    ? (tauriGlobal as { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }).invoke.bind(tauriGlobal)
    : null;

  const rateSlider = document.getElementById('set-rate') as HTMLInputElement | null;
  const rateVal = document.getElementById('set-rate-val');
  const pitchSlider = document.getElementById('set-pitch') as HTMLInputElement | null;
  const pitchVal = document.getElementById('set-pitch-val');
  const vadSlider = document.getElementById('set-vad') as HTMLInputElement | null;
  const vadVal = document.getElementById('set-vad-val');
  const voiceSelect = document.getElementById('set-voice') as HTMLSelectElement | null;
  const micSelect = document.getElementById('set-mic') as HTMLSelectElement | null;

  // Restore saved values into the controls
  if (rateSlider) { rateSlider.value = String(settings.ttsRate); }
  if (rateVal) { rateVal.textContent = String(settings.ttsRate); }
  if (pitchSlider) { pitchSlider.value = String(settings.ttsPitch); }
  if (pitchVal) { pitchVal.textContent = String(settings.ttsPitch); }
  if (vadSlider) { vadSlider.value = String(settings.vadMs); }
  if (vadVal) { vadVal.textContent = `${settings.vadMs}ms`; }

  // Rate slider
  rateSlider?.addEventListener('input', () => {
    settings.ttsRate = Number(rateSlider.value);
    if (rateVal) rateVal.textContent = rateSlider.value;
    saveSettings(settings);
  });

  // Pitch slider
  pitchSlider?.addEventListener('input', () => {
    settings.ttsPitch = Number(pitchSlider.value);
    if (pitchVal) pitchVal.textContent = pitchSlider.value;
    saveSettings(settings);
  });

  // VAD sensitivity slider
  vadSlider?.addEventListener('input', () => {
    settings.vadMs = Number(vadSlider.value);
    if (vadVal) vadVal.textContent = `${vadSlider.value}ms`;
    saveSettings(settings);
    invoke?.('stt_set_vad_hangover', { ms: settings.vadMs }).catch(() => {});
  });
  // Apply saved VAD on startup
  if (invoke && settings.vadMs !== 810) {
    invoke('stt_set_vad_hangover', { ms: settings.vadMs }).catch(() => {});
  }

  // Voice selector: populate from SAPI
  if (voiceSelect && invoke) {
    void invoke('tts_list_voices').then((voices) => {
      for (const name of voices as string[]) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        voiceSelect.appendChild(opt);
      }
      if (settings.ttsVoice) voiceSelect.value = settings.ttsVoice;
    }).catch(() => {});
  }
  voiceSelect?.addEventListener('change', () => {
    settings.ttsVoice = voiceSelect.value;
    saveSettings(settings);
  });

  // Mic device selector: populate from browser API
  if (micSelect) {
    const populateMics = (): void => {
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        const inputs = devices.filter((d) => d.kind === 'audioinput');
        while (micSelect.options.length > 1) micSelect.options.remove(1);
        for (const dev of inputs) {
          const opt = document.createElement('option');
          opt.value = dev.deviceId;
          opt.textContent = dev.label || `mic ${dev.deviceId.slice(0, 8)}`;
          micSelect.appendChild(opt);
        }
        if (settings.micDeviceId) micSelect.value = settings.micDeviceId;
      }).catch(() => {});
    };
    populateMics();
    navigator.mediaDevices?.addEventListener('devicechange', populateMics);
  }
  micSelect?.addEventListener('change', () => {
    settings.micDeviceId = micSelect.value;
    saveSettings(settings);
  });

}

bootstrap();
