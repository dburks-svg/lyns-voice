import { VERSION } from '../index';
import { THEME_PALETTES, type ThemeName } from '../config/config';
import { attachTauri } from '../integration/tauriAdapter';
import { TelemetryPanels } from '../integration/telemetry';
import { attachDragResize } from './terminal/dragResize';
import { TerminalManager } from './terminal/TerminalManager';
import { DiffPanel, type DiffEntry } from './diff/DiffPanel';
import { loadSettings, saveSettings, type AppSettings, type PanelLayout } from './settings';
import { attachShortcuts } from './shortcuts';
import { MiniMode } from './mini-mode';

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
    initialTheme: (settings.theme as ThemeName) || undefined,
    caption: document.getElementById('caption'),
    onTranscript: (role, text) => panels.addTranscript(role, text),
    onActivity: (a) => panels.addActivity(a.name, a.target),
    onDiff: (d) => addDiffEntry({
      tool: d.tool,
      filePath: d.file_path,
      oldString: d.old_string,
      newString: d.new_string,
      content: d.content,
    }),
    onUsage: (u) => panels.addUsage(u),
    onBands: (bands) => panels.pushBands(bands),
    ttsSettings: () => ({
      rate: settings.ttsRate,
      pitch: settings.ttsPitch,
      voice: settings.ttsVoice,
    }),
    micDeviceId: () => settings.micDeviceId,
    autoReconnect: settings.autoReconnect,
    notifyOnTurnEnd: settings.notifyOnTurnEnd,
    onReconnectStatus: (status) => {
      const cap = document.getElementById('caption');
      if (!cap) return;
      if (status.attempting) {
        cap.textContent = `Reconnecting (${status.attempt}/${status.maxAttempts})...`;
      } else if (status.attempt >= status.maxAttempts) {
        cap.textContent = 'Auto-reconnect failed.';
      }
    },
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

  // Apply saved theme on startup and wire buttons to switch it live.
  // The orb gets its palette via controller.setPalette; the HUD gets its
  // accent via CSS custom properties set on :root here.
  const applyThemeCss = (theme: ThemeName): void => {
    const palette = THEME_PALETTES[theme];
    if (!palette) return;
    const hex = palette.neonRim;
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    const root = document.documentElement;
    root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    root.style.setProperty('--accent', `rgb(${r}, ${g}, ${b})`);
    root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.45)`);
    root.style.setProperty('--accent-faint', `rgba(${r}, ${g}, ${b}, 0.14)`);
  };

  if (settings.theme) {
    applyThemeCss(settings.theme as ThemeName);
    if (settings.theme !== 'cyan') {
      handle.setTheme(settings.theme as ThemeName);
    }
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.theme-btn')) {
    if (btn.dataset.theme === settings.theme) {
      for (const b of document.querySelectorAll('.theme-btn')) b.classList.remove('active');
      btn.classList.add('active');
    }
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme as ThemeName;
      handle.setTheme(theme);
      applyThemeCss(theme);
      settings.theme = theme;
      saveSettings(settings);
      for (const b of document.querySelectorAll('.theme-btn')) b.classList.remove('active');
      btn.classList.add('active');
    });
  }

  // Dir history + transcript persistence (Phase 2 QOL): load via Tauri invoke.
  const tauriGlobal = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  if (tauriGlobal) {
    const tauri = tauriGlobal as {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    const datalist = document.getElementById('dir-history');
    void tauri.invoke('history_load').then((result) => {
      const dirs = result as string[];
      if (datalist && dirs.length > 0) {
        for (const d of dirs) {
          const opt = document.createElement('option');
          opt.value = d;
          datalist.appendChild(opt);
        }
      }
    }).catch(() => undefined);

    const origStartClaude = handle.startClaude.bind(handle);
    handle.startClaude = async (dir?: string): Promise<boolean> => {
      const ok = await origStartClaude(dir);
      if (ok && dir) {
        void tauri.invoke('history_load').then((result) => {
          const dirs = result as string[];
          const updated = [dir, ...dirs.filter((d) => d !== dir)].slice(0, 10);
          void tauri.invoke('history_save', { dirs: updated }).catch(() => undefined);
          if (datalist) {
            datalist.innerHTML = '';
            for (const d of updated) {
              const opt = document.createElement('option');
              opt.value = d;
              datalist.appendChild(opt);
            }
          }
        }).catch(() => undefined);
      }
      return ok;
    };

    const sessionId = crypto.randomUUID();
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedSave = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const entries = panels.getTranscriptEntries();
        if (entries.length > 0) {
          void tauri.invoke('transcript_save', { sessionId, entries }).catch(() => undefined);
        }
      }, 500);
    };
    panels.onTranscriptChange = debouncedSave;

    void tauri.invoke('transcript_load_latest').then((result) => {
      const entries = result as Array<{ role: string; text: string; timestamp: number }>;
      for (const e of entries) {
        panels.addTranscript(e.role, e.text);
      }
    }).catch(() => undefined);

    void tauri.invoke('transcript_cleanup').catch(() => undefined);
  }

  // Terminal windows: spawn draggable/resizable shells inside the app.
  const terminalLayer = document.getElementById('terminal-layer');
  const terminalBtn = document.getElementById('terminal-btn');
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

  // CI status dots: poll GitHub Actions via `gh run list` every 30s.
  const ciGreen = document.getElementById('ci-green');
  const ciYellow = document.getElementById('ci-yellow');
  const ciRed = document.getElementById('ci-red');
  if (tauriGlobal && ciGreen && ciYellow && ciRed) {
    const tauri = tauriGlobal as {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    const pollCi = (): void => {
      void tauri.invoke('ci_status').then((result) => {
        const { state } = result as { state: string };
        ciGreen.classList.toggle('active', state === 'green');
        ciYellow.classList.toggle('active', state === 'yellow');
        ciRed.classList.toggle('active', state === 'red');
      }).catch(() => {
        ciGreen.classList.remove('active');
        ciYellow.classList.remove('active');
        ciRed.classList.remove('active');
      });
    };
    pollCi();
    setInterval(pollCi, 30_000);
  }

  // Diff viewer: a floating panel showing file diffs from Claude's Edit/Write tools.
  const diffLayer = document.getElementById('diff-layer');
  const diffBtn = document.getElementById('diff-btn');
  let diffPanel: DiffPanel | null = null;
  const pendingDiffs: DiffEntry[] = [];

  function ensureDiffPanel(): DiffPanel {
    if (diffPanel) return diffPanel;
    const vw = window.innerWidth;
    const panel = new DiffPanel({
      x: Math.max(60, vw - 660),
      y: 80,
      onFocus: () => {
        if (panel.el.style.zIndex !== '10') panel.el.style.zIndex = '10';
      },
      onClose: () => {
        diffPanel?.destroy();
        diffPanel = null;
        diffBtn?.classList.remove('active');
      },
    });
    diffLayer?.appendChild(panel.el);
    diffPanel = panel;
    for (const d of pendingDiffs) panel.addDiff(d);
    pendingDiffs.length = 0;
    return panel;
  }

  function addDiffEntry(entry: DiffEntry): void {
    if (diffPanel) {
      diffPanel.addDiff(entry);
    } else {
      pendingDiffs.push(entry);
    }
  }

  diffBtn?.addEventListener('click', () => {
    if (diffPanel) {
      diffPanel.destroy();
      diffPanel = null;
      diffBtn.classList.remove('active');
    } else {
      ensureDiffPanel();
      diffBtn.classList.add('active');
    }
  });

  // Make telemetry panels draggable and resizable. Restore saved positions
  // from localStorage if available; otherwise snapshot from the grid layout.
  requestAnimationFrame(() => {
    const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
    const saved = settings.panelLayouts;
    const savedMap = new Map<string, PanelLayout>();
    if (saved) {
      for (const l of saved) savedMap.set(l.id, l);
    }

    function savePanelLayouts(): void {
      const layouts: PanelLayout[] = [];
      for (const p of document.querySelectorAll<HTMLElement>('.panel')) {
        const id = panelId(p);
        if (!id) continue;
        layouts.push({
          id,
          x: p.offsetLeft,
          y: p.offsetTop,
          width: p.offsetWidth,
          height: p.offsetHeight,
        });
      }
      settings.panelLayouts = layouts;
      saveSettings(settings);
    }

    for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
      const id = panelId(panel);
      const restored = id ? savedMap.get(id) : undefined;

      panel.style.position = 'fixed';
      if (restored) {
        panel.style.left = `${restored.x}px`;
        panel.style.top = `${restored.y}px`;
        panel.style.width = `${restored.width}px`;
        panel.style.height = `${restored.height}px`;
      } else {
        const rect = panel.getBoundingClientRect();
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.width = `${rect.width}px`;
        panel.style.height = `${rect.height}px`;
      }
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
        attachDragResize({
          el: panel,
          dragHandle: head,
          minWidth: 180,
          minHeight: 100,
          onEnd: savePanelLayouts,
          snapThreshold: settings.snapThreshold,
          snapTargets: () => {
            const rects: DOMRect[] = [];
            for (const p of document.querySelectorAll<HTMLElement>('.panel, .terminal-window, .diff-window')) {
              if (p !== panel) rects.push(p.getBoundingClientRect());
            }
            return rects;
          },
        });
      }
    }
  });

  // Compact / mini (PiP) mode: shrink to orb-only always-on-top.
  const miniMode = new MiniMode();
  const miniBtn = document.getElementById('mini-btn');
  const miniRestore = document.getElementById('mini-restore');
  miniBtn?.addEventListener('click', () => void miniMode.enter());
  miniRestore?.addEventListener('click', () => void miniMode.exit());

  // Keyboard shortcuts: Alt+T/D/S toggle panels, Escape closes topmost, Space toggles mic.
  attachShortcuts({
    toggleTerminal: () => terminalBtn?.click(),
    toggleDiffs: () => diffBtn?.click(),
    toggleSettings: () => settingsBtn?.click(),
    toggleMic,
    toggleMini: () => void miniMode.toggle(),
    closeFocused: () => {
      if (settingsDrawer && !settingsDrawer.hidden) {
        settingsBtn?.click();
        return;
      }
      if (diffPanel) {
        diffPanel.destroy();
        diffPanel = null;
        diffBtn?.classList.remove('active');
        return;
      }
      const wins = [...document.querySelectorAll<HTMLElement>('.terminal-window')];
      if (wins.length > 0) {
        const top = wins.reduce((a, b) =>
          (parseInt(b.style.zIndex || '0') > parseInt(a.style.zIndex || '0') ? b : a));
        top.querySelector<HTMLElement>('.tab-close')?.click();
      }
    },
  });

  // Right-click copy menu for transcript and diff panels.
  const transcriptEl = document.getElementById('hud-transcript');
  if (transcriptEl) {
    let copyMenu: HTMLElement | null = null;
    const dismissCopyMenu = (): void => {
      copyMenu?.remove();
      copyMenu = null;
    };
    transcriptEl.addEventListener('contextmenu', (e) => {
      const sel = window.getSelection()?.toString();
      if (!sel) return;
      e.preventDefault();
      dismissCopyMenu();
      const menu = document.createElement('div');
      menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:999;
        background:rgba(20,30,40,0.95);border:1px solid var(--accent-faint,#3af);
        padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;color:#cfe9f5;`;
      menu.textContent = 'Copy';
      menu.addEventListener('click', () => {
        void navigator.clipboard.writeText(sel);
        dismissCopyMenu();
      });
      document.body.appendChild(menu);
      copyMenu = menu;
      document.addEventListener('pointerdown', (ev) => {
        if (ev.target !== menu) dismissCopyMenu();
      }, { once: true });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') dismissCopyMenu();
      }, { once: true });
    });
  }

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

function panelId(el: HTMLElement): string | undefined {
  for (const cls of el.classList) {
    if (cls.startsWith('panel-')) return cls;
  }
  return undefined;
}

bootstrap();
