import { VERSION } from '../index';
import { THEME_PALETTES, type ThemeName } from '../config/config';
import { attachTauri } from '../integration/tauriAdapter';
import { TelemetryPanels } from '../integration/telemetry';
import { voiceLabel } from '../integration/voices';
import { attachDragResize } from './terminal/dragResize';
import { TerminalManager } from './terminal/TerminalManager';
import { DiffPanel, type DiffEntry } from './diff/DiffPanel';
import { SessionPanel } from './session/SessionPanel';
import { SessionManager } from './session/SessionManager';
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  effortLevelsForModel,
  clampEffortToModel,
  type AppSettings,
  type PanelLayout,
} from './settings';
import { attachShortcuts } from './shortcuts';
import { MiniMode } from './mini-mode';
import { detectGpu } from '../avatar/gpu';
import { showOnboarding } from './onboarding';
import { showProposeCard } from './proposeCard';
import { isWithinDir } from '../integration/conductorProtocol';
import { parseMoodMarker } from '../mood/moodProtocol';
import { LibraryPanel, type HookEntry } from './library/LibraryPanel';
import { createFleetMeter } from '../integration/fleetMeter';

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

  // Surface the WebGL backend in the UI so it is visible even in a release build
  // (which has no devtools): the orb auto-drops to a lighter render path on
  // software rendering (SwiftShader / WARP), the usual cause of runaway CPU. The
  // marker only appears on software rendering; hover the status text for the exact
  // renderer string either way.
  const gpu = detectGpu();
  const versionLabel = `LYNS Voice v${VERSION}${gpu.software ? ' (lite: software GPU)' : ''}`;
  if (label) label.title = `WebGL: ${gpu.renderer}`;

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
  // One light rAF drives the oscilloscope (~30fps) and the uptime ~1x/sec. It does
  // no work while the window is hidden, and the 30fps cap (an SVG trace needs no
  // more) keeps idle CPU low -- this loop runs for the whole session, so both the
  // skip-when-hidden and the cap matter.
  const WAVE_INTERVAL_MS = 1000 / 30;
  let lastWave = 0;
  let lastUptime = 0;
  const tickPanels = (now: number): void => {
    requestAnimationFrame(tickPanels);
    if (document.hidden) return;
    if (now - lastWave >= WAVE_INTERVAL_MS) {
      lastWave = now;
      panels.tickWave();
    }
    if (now - lastUptime >= 1000) {
      lastUptime = now;
      panels.tickUptime();
    }
  };
  requestAnimationFrame(tickPanels);

  const settings = loadSettings();

  const fleetMeter = createFleetMeter(
    document.getElementById('hud-fleet'),
    document.getElementById('hud-fleet-cost'),
  );
  // The spawn gate's reference point: the directory the user connected the primary
  // session to (set below, where startClaude is wrapped). A <<spawn>> whose dir
  // stays inside it keeps the user-chosen blast radius and runs unprompted; any
  // other dir shows a confirm card first (a prompt-injected reply could otherwise
  // point a worker anywhere on disk).
  let primaryDir: string | null = null;
  const handle = attachTauri({
    root,
    initialTheme: (settings.theme as ThemeName) || undefined,
    caption: document.getElementById('caption'),
    onTranscript: (role, text) => panels.addTranscript(role, text),
    onActivity: (a) => {
      panels.addActivity(a.name, a.target);
      addSessionLine('action', a.target ? `${a.name}  ${a.target}` : a.name);
    },
    onStream: (line) => {
      // Narration is Q's reply prose: strip the mood protocol marker so the
      // session view never shows a raw `<<mood:...>>` (caption/TTS already
      // strip it; tool output stays verbatim). A marker-only line vanishes.
      const text =
        line.kind === 'narration' ? parseMoodMarker(line.text).stripped : line.text;
      if (text) addSessionLine(line.kind, text);
    },
    onConductorSpawn: (d) => {
      if (primaryDir && isWithinDir(d.dir, primaryDir)) {
        void sessionMgr.spawn({ name: d.name, dir: d.dir, task: d.task });
        return;
      }
      showProposeCard({
        heading: 'Spawn a session outside the project dir?',
        summary: `Oracle wants to spawn "${d.name}" in ${d.dir} (outside ${primaryDir ?? 'the connected project dir'}). Task: ${d.task}`,
        onApprove: () => void sessionMgr.spawn({ name: d.name, dir: d.dir, task: d.task }),
        onDecline: () =>
          handle.submitText(
            `Do not spawn "${d.name}" in ${d.dir}; stay within the project directory or propose an alternative.`,
          ),
      });
    },
    onConductorTell: (d) => {
      sessionMgr.tell(d.name, d.message);
    },
    onConductorPropose: (d) => {
      showProposeCard({
        summary: d.summary,
        onApprove: () => handle.submitText('Approved. Go ahead and split it into the sessions you proposed.'),
        onDecline: () => handle.submitText('Let us keep it in one session for now.'),
      });
    },
    onDiff: (d) => addDiffEntry({
      tool: d.tool,
      filePath: d.file_path,
      oldString: d.old_string,
      newString: d.new_string,
      content: d.content,
    }),
    onUsage: (u) => {
      panels.addUsage(u);
      fleetMeter.addCost(u.cost_usd);
    },
    onBands: (bands) => panels.pushBands(bands),
    ttsSettings: () => ({
      rate: settings.ttsRate,
      pitch: settings.ttsPitch,
      voice: settings.ttsVoice,
      engine: settings.ttsEngine,
    }),
    micDeviceId: () => settings.micDeviceId,
    autoReconnect: () => settings.autoReconnect,
    notifyOnTurnEnd: () => settings.notifyOnTurnEnd,
    bargeIn: () => settings.bargeIn,
    wakeWordEnabled: () => settings.wakeWord,
    mcpDisabled: () => settings.disabledMcp,
    hooksDisabled: () => settings.disabledHooks,
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
  // Guards a re-entrant start while one is still in flight. isListening() only flips
  // true once capture.start() resolves (mic permission + worklet spin-up), so without
  // this a fast second tap (button or the keyboard shortcut, both routed here) would
  // fire a second startListening instead of being a clean no-op.
  let micStarting = false;
  const toggleMic = (): void => {
    if (handle.isListening()) {
      handle.stopListening();
      reflectListening(false);
      return;
    }
    if (micStarting) return;
    micStarting = true;
    void handle.startListening().then((ok) => {
      micStarting = false;
      if (ok) {
        reflectListening(true);
      } else if (label) {
        label.textContent = 'mic permission denied';
      }
    });
  };
  micButton?.addEventListener('click', toggleMic);
  micFab?.addEventListener('click', toggleMic);

  // Wake mode: start listening on launch so "Oracle" is heard without a tap. Guarded
  // on `onboarded` so a brand-new user finishes onboarding (and the one-time model
  // download note) before the mic auto-engages.
  if (settings.wakeWord && settings.onboarded) {
    void handle.startListening().then((ok) => reflectListening(ok));
  }

  // Phase 3: connect a Claude Code session in a project dir. Once connected,
  // spoken utterances are sent to Claude and the reply is spoken back with mood.
  const claudeDir = document.getElementById('claude-dir') as HTMLInputElement | null;
  const browseBtn = document.getElementById('claude-browse');
  browseBtn?.addEventListener('click', () => {
    void import('@tauri-apps/plugin-dialog')
      .then(async ({ open }) => {
        const dir = await open({ directory: true, multiple: false });
        if (typeof dir === 'string' && dir && claudeDir) claudeDir.value = dir;
      })
      .catch((e) => console.warn('[browse]', e));
  });
  const claudeButton = document.getElementById('claude-btn');
  claudeButton?.addEventListener('click', () => {
    if (handle.isClaudeConnected()) {
      handle.stopClaude();
      primaryDir = null; // no session => no auto-approved spawn radius
      sessionPanel?.destroy();
      sessionPanel = null;
      claudeButton.textContent = 'connect claude';
      claudeButton.classList.remove('active');
      if (label) {
        label.textContent = versionLabel;
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
    void handle.startClaude(dir, settings.model || undefined, settings.effort || undefined).then((ok) => {
      if (label) {
        label.textContent = ok ? 'Claude connected' : 'claude start failed (see logs)';
      }
      if (ok) {
        primaryDir = dir; // the spawn gate's auto-approve radius (see above)
        claudeButton.textContent = 'disconnect';
        claudeButton.classList.add('active');
        ensureSessionPanel(); // open the session view on connect
      }
    });
  });

  // --- Settings controls ---
  wireSettings(settings, (wakeEnabled) => {
    // Keep the always-on mic in step with the wake toggle, mirroring the launch
    // behavior: hands-free needs the mic running; wake-off releases it so open-mic
    // ambient speech cannot become commands.
    if (wakeEnabled && !handle.isListening()) {
      void handle.startListening().then((ok) => reflectListening(ok));
    } else if (!wakeEnabled && handle.isListening()) {
      handle.stopListening();
      reflectListening(false);
    }
  });

  // First-run onboarding overlay (shown once).
  if (!settings.onboarded) {
    showOnboarding(() => {
      settings.onboarded = true;
      saveSettings(settings);
    });
  }

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

    // Which project dir the VISIBLE transcript belongs to. `undefined` = nothing
    // foreign is showing (fresh panel this run); `null` = restored content of
    // unknown provenance (a pre-upgrade file, or saved while disconnected).
    // Connecting to a dir that doesn't match clears the panel: that content is
    // another project's conversation and the new session has no memory of it
    // (live-test report: a transcript from an earlier test in a different folder
    // survived the switch).
    let transcriptDir: string | null | undefined;

    const origStartClaude = handle.startClaude.bind(handle);
    handle.startClaude = async (dir?: string, model?: string, effort?: string): Promise<boolean> => {
      const ok = await origStartClaude(dir, model, effort);
      if (ok && dir) {
        if (transcriptDir !== undefined && transcriptDir !== dir) {
          panels.clearTranscript();
        }
        transcriptDir = dir;
      }
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
          void tauri
            .invoke('transcript_save', { sessionId, entries, dir: transcriptDir ?? null })
            .catch(() => undefined);
        }
      }, 500);
    };
    panels.onTranscriptChange = debouncedSave;

    void tauri.invoke('transcript_load_latest').then((result) => {
      const latest = result as {
        dir: string | null;
        entries: Array<{ role: string; text: string; timestamp: number }>;
      };
      if (latest.entries.length > 0) {
        transcriptDir = latest.dir; // null = unknown provenance: clear on connect
        for (const e of latest.entries) {
          panels.addTranscript(e.role, e.text);
        }
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
    const dots = [ciGreen, ciYellow, ciRed];
    const setCiTitle = (msg: string): void => {
      for (const dot of dots) dot.title = msg;
    };
    const pollCi = (): void => {
      void tauri.invoke('ci_status').then((result) => {
        const { state } = result as { state: string };
        ciGreen.classList.toggle('active', state === 'green');
        ciYellow.classList.toggle('active', state === 'yellow');
        ciRed.classList.toggle('active', state === 'red');
        setCiTitle(state === 'unknown' ? 'CI: no recent runs found' : `CI: ${state}`);
      }).catch((e: unknown) => {
        // Surface why the dots went dark instead of failing silently: a missing or
        // unauthenticated gh is the common cause, shown as a hover tooltip.
        ciGreen.classList.remove('active');
        ciYellow.classList.remove('active');
        ciRed.classList.remove('active');
        setCiTitle(`CI status unavailable: ${String(e)}`);
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

  // The Library: the user's registered MCP servers (their terminal's MCP world),
  // each toggleable per session spawn. Everything is enabled by default; a
  // disable persists in settings and applies to sessions started afterwards.
  const libraryBtn = document.getElementById('library-btn');
  let libraryPanel: LibraryPanel | null = null;
  const closeLibrary = (): void => {
    libraryPanel?.destroy();
    libraryPanel = null;
    libraryBtn?.classList.remove('active');
  };
  libraryBtn?.addEventListener('click', () => {
    if (libraryPanel) {
      closeLibrary();
      return;
    }
    const dir =
      (document.getElementById('claude-dir') as HTMLInputElement | null)?.value.trim() || undefined;
    void Promise.all([
      tauriInvoke<string[]>('library_list_mcp').catch(() => [] as string[]),
      tauriInvoke<HookEntry[]>('library_list_hooks', { dir }).catch(() => [] as HookEntry[]),
    ]).then(([servers, hooks]) => {
      if (libraryPanel) return; // double-click while loading
      const panel = new LibraryPanel({
        x: Math.max(60, window.innerWidth - 520),
        y: 120,
        servers,
        disabled: new Set(settings.disabledMcp),
        onToggle: (name, enabled) => {
          settings.disabledMcp = enabled
            ? settings.disabledMcp.filter((n) => n !== name)
            : [...settings.disabledMcp, name];
          saveSettings(settings);
        },
        hooks,
        disabledHooks: new Set(settings.disabledHooks),
        onToggleHook: (id, enabled) => {
          settings.disabledHooks = enabled
            ? settings.disabledHooks.filter((h) => h !== id)
            : [...settings.disabledHooks, id];
          saveSettings(settings);
        },
        onFocus: () => {
          if (panel.el.style.zIndex !== '10') panel.el.style.zIndex = '10';
        },
        onClose: closeLibrary,
      });
      diffLayer?.appendChild(panel.el);
      libraryPanel = panel;
      libraryBtn.classList.add('active');
    });
  });

  // Session view: a floating terminal of the live Claude stream (narration, the
  // tools it runs, command output) with a typed input as a co-equal to voice.
  // Opens on connect; Alt+J toggles it. Reuses the diff floating layer.
  const sessionLayer = document.getElementById('diff-layer');
  let sessionPanel: SessionPanel | null = null;
  const pendingStream: Array<{ kind: string; text: string }> = [];

  function ensureSessionPanel(): SessionPanel {
    if (sessionPanel) return sessionPanel;
    const panel = new SessionPanel({
      x: 80,
      y: 90,
      title: 'Oracle session',
      onSubmit: (text) => {
        panel.addLine('user', text); // echo typed input into the stream
        handle.submitText(text); // same path as a voice utterance
      },
      onAttach: () => {
        // Pick a file and stage a reference in the compose box (no copy into root);
        // the user reviews/edits before sending, and Claude reads it by path.
        void import('@tauri-apps/plugin-dialog')
          .then(async ({ open }) => {
            const path = await open({ multiple: false, directory: false });
            if (typeof path === 'string' && path) {
              panel.appendToInput(`Read the file at "${path}" and use it.`);
            }
          })
          .catch((e) => console.warn('[attach]', e));
      },
      onFocus: () => {
        if (panel.el.style.zIndex !== '11') panel.el.style.zIndex = '11';
      },
      onClose: () => {
        sessionPanel?.destroy();
        sessionPanel = null;
      },
    });
    (sessionLayer ?? document.body).appendChild(panel.el);
    sessionPanel = panel;
    for (const l of pendingStream) panel.addLine(l.kind, l.text);
    pendingStream.length = 0;
    return panel;
  }

  function addSessionLine(kind: string, text: string): void {
    if (sessionPanel) sessionPanel.addLine(kind, text);
    else pendingStream.push({ kind, text });
  }

  function toggleSessionPanel(): void {
    if (sessionPanel) {
      sessionPanel.destroy();
      sessionPanel = null;
    } else {
      ensureSessionPanel();
    }
  }

  // Background multi-session: Alt+N spawns an additional Claude session in its own
  // panel (watch + type), independent of the primary voice session. The single voice
  // channel stays on the primary session; background sessions notify when they finish.
  const tauriInvoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    import('@tauri-apps/api/core').then(({ invoke }) => invoke<T>(cmd, args));
  const tauriListen = <T>(event: string, handler: (p: T) => void): Promise<() => void> =>
    import('@tauri-apps/api/event').then(({ listen }) => listen<T>(event, (e) => handler(e.payload)));
  const sessionMgr = new SessionManager({
    invoke: tauriInvoke,
    listen: tauriListen,
    layer: sessionLayer ?? document.body,
    defaults: () => ({
      dir: (document.getElementById('claude-dir') as HTMLInputElement | null)?.value.trim() || undefined,
      model: settings.model || undefined,
      effort: settings.effort || undefined,
    }),
    mcpDisabled: () => settings.disabledMcp,
    hooksDisabled: () => settings.disabledHooks,
    onDone: (name, isError) => {
      handle.announce(name, isError); // courteous spoken announcement via the conductor
      if (document.hidden) {
        void import('@tauri-apps/plugin-notification')
          .then(({ sendNotification }) => {
            sendNotification({ title: 'LYNS Voice', body: `${name} ${isError ? 'hit an error' : 'finished'}.` });
          })
          .catch(() => undefined);
      }
    },
    onUsage: (u) => fleetMeter.addCost(u.cost_usd),
    onCountChange: (n) => fleetMeter.setActive(1 + n),
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
          snapThreshold: () => settings.snapThreshold,
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

  // TRANSCRIPT panel visibility: once a session view is open the panel duplicates
  // its conversation, so it is hot-bar toggleable (persisted; default on).
  const transcriptBtn = document.getElementById('transcript-btn');
  const transcriptPanel = document.querySelector<HTMLElement>('.panel-transcript');
  const applyTranscriptVisibility = (): void => {
    if (transcriptPanel) transcriptPanel.style.display = settings.showTranscript ? '' : 'none';
    transcriptBtn?.classList.toggle('active', settings.showTranscript);
  };
  applyTranscriptVisibility();
  transcriptBtn?.addEventListener('click', () => {
    settings.showTranscript = !settings.showTranscript;
    saveSettings(settings);
    applyTranscriptVisibility();
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
    toggleSession: () => toggleSessionPanel(),
    toggleSettings: () => settingsBtn?.click(),
    toggleMic,
    toggleMini: () => void miniMode.toggle(),
    newSession: () => void sessionMgr.spawn(),
    closeFocused: () => {
      if (handle.interrupt()) return; // barge-in: cut off an in-flight turn first
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
    label.textContent = versionLabel;
  }
}

function wireSettings(
  settings: AppSettings,
  onWakeToggle?: (enabled: boolean) => void,
): void {
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
  if (invoke && settings.vadMs !== DEFAULT_SETTINGS.vadMs) {
    invoke('stt_set_vad_hangover', { ms: settings.vadMs }).catch(() => {});
  }

  // Voice selector: populated per engine (Kokoro ids -> friendly labels, or SAPI
  // voice names). Re-run when the engine toggles, since the two lists differ.
  const populateVoices = (engine: string): void => {
    if (!voiceSelect || !invoke) return;
    while (voiceSelect.options.length > 1) voiceSelect.remove(1); // keep the default option
    const def = voiceSelect.options[0];
    if (def) def.textContent = engine === 'sapi' ? 'system default' : 'Oracle default (Emma)';
    void invoke('tts_list_voices', { engine }).then((voices) => {
      const list = voices as string[];
      for (const name of list) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = voiceLabel(name);
        voiceSelect.appendChild(opt);
      }
      // Drop a saved voice not in this engine's list (e.g. after switching engines),
      // falling back to the engine default.
      if (settings.ttsVoice && !list.includes(settings.ttsVoice)) {
        settings.ttsVoice = '';
        saveSettings(settings);
      }
      voiceSelect.value = settings.ttsVoice; // '' selects the default option
    }).catch(() => {});
  };
  populateVoices(settings.ttsEngine);
  voiceSelect?.addEventListener('change', () => {
    settings.ttsVoice = voiceSelect.value;
    saveSettings(settings);
  });

  // TTS engine toggle: neural Kokoro (default) vs Windows SAPI. Switching reloads the
  // voice list (the engines expose different voices) and resets the saved voice.
  const engineCheck = document.getElementById('set-engine') as HTMLInputElement | null;
  if (engineCheck) engineCheck.checked = settings.ttsEngine !== 'sapi';
  engineCheck?.addEventListener('change', () => {
    settings.ttsEngine = engineCheck.checked ? 'kokoro' : 'sapi';
    settings.ttsVoice = ''; // the previous pick belongs to the other engine
    saveSettings(settings);
    populateVoices(settings.ttsEngine);
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

  // Model + effort: applied to the NEXT connected session (per session, set at spawn).
  // Effort levels are model-dependent, so the effort menu is rebuilt whenever the model
  // changes. `ultracode` is Opus-only; the Rust spawn translates it to
  // `--settings {"ultracode":true}` (it is not a real `--effort` value).
  const modelSelect = document.getElementById('set-model') as HTMLSelectElement | null;
  const effortSelect = document.getElementById('set-effort') as HTMLSelectElement | null;

  // Rebuild #set-effort for the given model (per-model menus + self-heal live in settings.ts).
  // The saved effort is clamped to one the model offers, so stale combos (sonnet+xhigh,
  // haiku+anything) reset to default; a reset is persisted so it sticks.
  const rebuildEffortOptions = (modelValue: string): void => {
    if (!effortSelect) return;
    const levels = effortLevelsForModel(modelValue);
    const clamped = clampEffortToModel(modelValue, settings.effort);
    if (clamped !== settings.effort) {
      settings.effort = clamped;
      saveSettings(settings);
    }
    const mkOption = (value: string, label: string): HTMLOptionElement => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      return opt;
    };
    effortSelect.replaceChildren(
      mkOption('', 'default effort'),
      ...levels.map((level) => mkOption(level, level)),
    );
    effortSelect.value = settings.effort;
  };

  if (modelSelect) modelSelect.value = settings.model;
  rebuildEffortOptions(settings.model);
  modelSelect?.addEventListener('change', () => {
    settings.model = modelSelect.value;
    saveSettings(settings);
    rebuildEffortOptions(modelSelect.value);
  });
  effortSelect?.addEventListener('change', () => {
    settings.effort = effortSelect.value;
    saveSettings(settings);
  });

  const bargeCheck = document.getElementById('set-bargein') as HTMLInputElement | null;
  if (bargeCheck) bargeCheck.checked = settings.bargeIn;
  bargeCheck?.addEventListener('change', () => {
    settings.bargeIn = bargeCheck.checked;
    saveSettings(settings);
  });

  const wakeCheck = document.getElementById('set-wakeword') as HTMLInputElement | null;
  if (wakeCheck) wakeCheck.checked = settings.wakeWord;
  wakeCheck?.addEventListener('change', () => {
    // The gating itself is read live via the wakeWordEnabled getter; the callback
    // keeps the always-on mic in step with the toggle (on = engage hands-free
    // listening now, off = release the mic so ambient speech cannot become
    // commands). Live-test report: re-enabling wake word used to leave the mic
    // off until the next launch or a manual tap.
    settings.wakeWord = wakeCheck.checked;
    saveSettings(settings);
    onWakeToggle?.(wakeCheck.checked);
  });

  // Auto-reconnect a dropped claude session (read live via the adapter getter).
  const reconnectCheck = document.getElementById('set-reconnect') as HTMLInputElement | null;
  if (reconnectCheck) reconnectCheck.checked = settings.autoReconnect;
  reconnectCheck?.addEventListener('change', () => {
    settings.autoReconnect = reconnectCheck.checked;
    saveSettings(settings);
  });

  // Notify on a backgrounded turn-end (read live via the adapter getter).
  const notifyCheck = document.getElementById('set-notify') as HTMLInputElement | null;
  if (notifyCheck) notifyCheck.checked = settings.notifyOnTurnEnd;
  notifyCheck?.addEventListener('change', () => {
    settings.notifyOnTurnEnd = notifyCheck.checked;
    saveSettings(settings);
  });

  // Window snap distance (read live by attachDragResize via the getter).
  const snapSlider = document.getElementById('set-snap') as HTMLInputElement | null;
  const snapVal = document.getElementById('set-snap-val');
  if (snapSlider) snapSlider.value = String(settings.snapThreshold);
  if (snapVal) snapVal.textContent = `${settings.snapThreshold}px`;
  snapSlider?.addEventListener('input', () => {
    settings.snapThreshold = Number(snapSlider.value);
    if (snapVal) snapVal.textContent = `${snapSlider.value}px`;
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
