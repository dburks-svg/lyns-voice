import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Avatar,
  AvatarController,
  DEFAULT_CONFIG,
  MicAnalyser,
  SpeechReactor,
  VERSION,
  prefersReducedMotion,
  type AvatarState,
  type Skin,
} from '../src/index';
import headUrl from '../vendor/head.glb?url';

/**
 * Standalone demo bootstrap (Phase 3).
 *
 * Mounts the avatar, runs the controller-driven loop, and wires the control
 * panel: manual state buttons, a real microphone test (Listening), and a real
 * speech-synthesis test (Speaking with word-boundary impulses).
 */
function bootstrap(): void {
  const root = document.getElementById('avatar-root');
  const controls = document.getElementById('controls');
  const status = document.getElementById('status');
  if (!root) {
    return;
  }

  const avatar = new Avatar({
    skin: DEFAULT_CONFIG.skin,
    headUrl,
    gltfLoaderFactory: () => new GLTFLoader(),
  });
  avatar.reducedMotion = prefersReducedMotion(window);
  avatar.mount(root);

  const setStatus = (text: string): void => {
    if (status) {
      status.textContent = `Jarvis Avatar v${VERSION} - ${avatar.skin} - ${text}`;
    }
  };

  const controller = new AvatarController({ avatar, onStateChange: setStatus });
  avatar.beforeRender = (time) => controller.tick(time);
  avatar.start();
  setStatus(controller.current);

  window.addEventListener('resize', () => avatar.resize(root.clientWidth, root.clientHeight));

  const skinButton = document.getElementById('skin-toggle');
  skinButton?.addEventListener('click', () => {
    const next: Skin = avatar.skin === 'head' ? 'orb' : 'head';
    void avatar.setSkin(next).then(() => {
      avatar.resize(root.clientWidth, root.clientHeight);
      setStatus(controller.current);
    });
  });

  for (const button of controls?.querySelectorAll<HTMLButtonElement>('button[data-state]') ?? []) {
    button.addEventListener('click', () => {
      const next = button.dataset.state as AvatarState | undefined;
      if (next) {
        controller.setState(next);
      }
    });
  }

  wireMicTest(controller, setStatus);
  wireSpeakTest(controller);
}

function wireMicTest(controller: AvatarController, setStatus: (text: string) => void): void {
  const micButton = document.getElementById('mic-test');
  if (!micButton) {
    return;
  }
  const mic = new MicAnalyser({
    onLevel: (level) => controller.setMicLevel(level),
    onBands: (bands) => controller.setMicBands(bands),
  });
  let micOn = false;
  micButton.addEventListener('click', () => {
    if (micOn) {
      mic.stop();
      micOn = false;
      controller.setState('idle');
      return;
    }
    void mic.start().then((ok) => {
      micOn = ok;
      controller.setState(ok ? 'listening' : 'idle');
      if (!ok) {
        setStatus('mic permission denied');
      }
    });
  });
}

function wireSpeakTest(controller: AvatarController): void {
  const speakButton = document.getElementById('speak-test');
  if (!speakButton) {
    return;
  }
  const speech = new SpeechReactor({
    onSpeakingStart: () => controller.setState('speaking'),
    onSpeakingEnd: () => controller.setState('idle'),
    onBoundary: () => controller.pulse(),
  });
  speech.attach();

  const synth = window.speechSynthesis;
  const LINE = 'Online and ready. All systems nominal, sir. How may I assist you today?';

  // Voices load asynchronously; cache and refresh on 'voiceschanged'. An empty
  // list is fine (the engine default speaks). Prefer a LOCAL English voice -
  // network voices often fail silently.
  let voices: SpeechSynthesisVoice[] = synth?.getVoices() ?? [];
  const refreshVoices = (): void => {
    voices = synth?.getVoices() ?? [];
  };
  refreshVoices();
  synth?.addEventListener?.('voiceschanged', refreshVoices);
  const pickVoice = (): SpeechSynthesisVoice | undefined =>
    voices.find((v) => v.localService && v.lang.startsWith('en')) ??
    voices.find((v) => v.lang.startsWith('en'));

  // Hold a strong reference to each utterance until it ends so Chrome cannot
  // garbage-collect it mid-speech (a known bug where speech silently never starts).
  const alive = new Set<SpeechSynthesisUtterance>();
  let speakTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let demoTimer: ReturnType<typeof setInterval> | null = null;
  const stopDemo = (): void => {
    if (demoTimer !== null) {
      clearInterval(demoTimer);
      demoTimer = null;
    }
  };
  const clearWatchdog = (): void => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  const runSpeak = (): void => {
    speakTimer = null;
    if (!synth) {
      return;
    }
    stopDemo();
    if (synth.paused) {
      synth.resume(); // unstick a paused engine
    }

    const utterance = new SpeechSynthesisUtterance(LINE);
    const voice = pickVoice();
    if (voice) {
      utterance.voice = voice;
    }
    alive.add(utterance);
    let started = false;
    const release = (): void => {
      alive.delete(utterance);
    };
    utterance.addEventListener('start', () => {
      started = true;
      clearWatchdog();
      stopDemo(); // real speech took over; drop the visual fallback
    });
    utterance.addEventListener('end', release);
    utterance.addEventListener('error', () => {
      clearWatchdog();
      release();
    });

    synth.speak(utterance);

    // Watchdog: if no real speech starts (no voice / muted engine), still animate
    // so the button visibly responds.
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (started) {
        return;
      }
      controller.setState('speaking');
      let ticks = 0;
      stopDemo();
      demoTimer = setInterval(() => {
        controller.pulse();
        ticks += 1;
        if (ticks > 14) {
          stopDemo();
          controller.setState('idle');
        }
      }, 180);
    }, 350);
  };

  speakButton.addEventListener('click', () => {
    if (!synth) {
      return;
    }
    // Debounce rapid presses into one scheduled speak, and DECOUPLE cancel from
    // speak: only cancel when the engine is busy, then speak on a short macrotask
    // so the cancel teardown settles first (fixes the ~1-in-10 same-tick race).
    if (speakTimer !== null) {
      clearTimeout(speakTimer);
    }
    const busy = synth.speaking || synth.pending;
    if (busy) {
      synth.cancel();
    }
    speakTimer = setTimeout(runSpeak, busy ? 120 : 0);
  });
}

bootstrap();
