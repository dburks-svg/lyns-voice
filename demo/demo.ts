import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Avatar,
  AvatarController,
  DEFAULT_CONFIG,
  MicAnalyser,
  SpeechReactor,
  VERSION,
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
  speakButton.addEventListener('click', () => {
    const utterance = new SpeechSynthesisUtterance(
      'Online and ready. All systems nominal, sir. How may I assist you today?',
    );
    window.speechSynthesis.speak(utterance);
  });
}

bootstrap();
