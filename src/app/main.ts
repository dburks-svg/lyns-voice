import { VERSION, type AvatarState } from '../index';
import { attachTauri } from '../integration/tauriAdapter';
import { TelemetryPanels } from '../integration/telemetry';

/**
 * Jarvis desktop app entry.
 *
 * Mounts the holographic orb into the FUI stage through `attachTauri`, which owns
 * the voice-signal seam and the TTS path, and wires the four telemetry panels
 * (transcript / activity / session / waveform) to the live voice loop. The top
 * HUD cluster cycles the four states and drives a manual "speak" until the STT
 * (Phase 2) and Claude bridge (Phase 3) adapters take over. The state machine,
 * mood, and TTS are reused verbatim; only the renderer and the shell are new.
 */
function bootstrap(): void {
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

  const handle = attachTauri({
    root,
    caption: document.getElementById('caption'),
    onTranscript: (role, text) => panels.addTranscript(role, text),
    onActivity: (a) => panels.addActivity(a.name, a.target),
    onUsage: (u) => panels.addUsage(u),
    onBands: (bands) => panels.pushBands(bands),
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-state]')) {
    button.addEventListener('click', () => {
      const next = button.dataset.state as AvatarState | undefined;
      if (next) {
        handle.setState(next);
      }
    });
  }

  // Phase 1 manual TTS trigger: speak the typed line through native SAPI. Try a
  // mood tag (e.g. "<<mood:happy>> hello") to confirm it tints and is never heard
  // or shown. The Claude bridge drives this same path in Phase 3.
  const speakInput = document.getElementById('speak-input') as HTMLInputElement | null;
  const speakButton = document.getElementById('speak-btn');
  const doSpeak = (): void => {
    const text = speakInput?.value.trim();
    if (!text) {
      return;
    }
    void handle.speak(text).then((ok) => {
      if (!ok && label) {
        label.textContent = 'voice unavailable (TTS failed)';
      }
    });
  };
  speakButton?.addEventListener('click', doSpeak);
  speakInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      doSpeak();
    }
  });

  // Phase 2: tap-to-talk. Mic capture + local Whisper STT auto-finalize on a
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
        label.textContent = `Jarvis v${VERSION}`;
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

  if (label) {
    label.textContent = `Jarvis v${VERSION}`;
  }
}

bootstrap();
