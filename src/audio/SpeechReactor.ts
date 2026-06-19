/**
 * Speech-output reactivity for the Speaking state.
 *
 * The browser does NOT expose `speechSynthesis` audio to an AnalyserNode, so we
 * cannot read TTS amplitude directly (this is why AVATAR_SPEC's "capture the TTS
 * output stream" is infeasible). Instead we drive the mesh from word-boundary
 * events, with a synthetic time-based envelope as a fallback for voices that do
 * not emit `boundary` events.
 *
 * `attach()` wraps `speechSynthesis.speak` non-destructively: it binds listeners
 * with `addEventListener` (never clobbering host handlers) and always calls the
 * original speak, even if our binding throws, so it can never block speech.
 */

export interface SpeechReactorOptions {
  synthesis?: SpeechSynthesis;
  onSpeakingStart?: () => void;
  onSpeakingEnd?: () => void;
  onBoundary?: () => void;
  /** Synthetic impulse interval (ms) used when no native boundaries arrive. */
  syntheticIntervalMs?: number;
}

type SpeakFn = (utterance: SpeechSynthesisUtterance) => void;

export class SpeechReactor {
  private readonly synthesis: SpeechSynthesis | undefined;
  private readonly onSpeakingStart?: () => void;
  private readonly onSpeakingEnd?: () => void;
  private readonly onBoundary?: () => void;
  private readonly syntheticIntervalMs: number;

  private originalSpeak: SpeakFn | null = null;
  private speaking = false;
  private nativeBoundarySeen = false;
  private syntheticTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SpeechReactorOptions = {}) {
    this.synthesis = options.synthesis ?? globalThis.speechSynthesis;
    this.onSpeakingStart = options.onSpeakingStart;
    this.onSpeakingEnd = options.onSpeakingEnd;
    this.onBoundary = options.onBoundary;
    this.syntheticIntervalMs = options.syntheticIntervalMs ?? 180;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  attach(): void {
    const synthesis = this.synthesis;
    if (this.originalSpeak || !synthesis) {
      return;
    }
    const original: SpeakFn = synthesis.speak.bind(synthesis);
    this.originalSpeak = original;
    synthesis.speak = (utterance: SpeechSynthesisUtterance): void => {
      try {
        this.bindUtterance(utterance);
      } catch {
        // Binding must never block speech.
      }
      original(utterance);
    };
  }

  detach(): void {
    this.stopSynthetic();
    if (this.originalSpeak && this.synthesis) {
      this.synthesis.speak = this.originalSpeak;
    }
    this.originalSpeak = null;
    this.speaking = false;
  }

  private bindUtterance(utterance: SpeechSynthesisUtterance): void {
    utterance.addEventListener('start', () => this.handleStart());
    utterance.addEventListener('boundary', (event) => {
      if (event.name === 'word') {
        this.handleBoundary();
      }
    });
    utterance.addEventListener('end', () => this.handleEnd());
    utterance.addEventListener('error', () => this.handleEnd());
  }

  private handleStart(): void {
    this.speaking = true;
    this.nativeBoundarySeen = false;
    this.onSpeakingStart?.();
    this.startSynthetic();
  }

  private handleBoundary(): void {
    this.nativeBoundarySeen = true;
    this.onBoundary?.();
  }

  private handleEnd(): void {
    if (!this.speaking) {
      return;
    }
    this.speaking = false;
    this.stopSynthetic();
    this.onSpeakingEnd?.();
  }

  private startSynthetic(): void {
    this.stopSynthetic();
    this.syntheticTimer = setInterval(() => {
      if (this.speaking && !this.nativeBoundarySeen) {
        this.onBoundary?.();
      }
    }, this.syntheticIntervalMs);
  }

  private stopSynthetic(): void {
    if (this.syntheticTimer !== null) {
      clearInterval(this.syntheticTimer);
      this.syntheticTimer = null;
    }
  }
}
