/**
 * The FUI telemetry panels: turns the four HUD windows from static sci-fi props
 * into live data sinks fed by the voice loop.
 *
 *  - Transcript  : the conversation (you <-> Jarvis), from `onTranscript`.
 *  - Activity    : each tool Claude runs this turn, from `onActivity`.
 *  - Session     : accumulated token usage + cost + turns + uptime, from `onUsage`.
 *  - Waveform    : a live oscilloscope of the mic level, from `onBands`.
 *
 * DOM writes use `textContent` only (never innerHTML), so transcribed user/agent
 * text can never inject markup. The formatting helpers are pure and unit-tested;
 * the waveform draw is a separate method the rAF calls, so tests can drive it
 * deterministically without real animation timing.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Format a token count compactly: 942, 1.2k, 12.3k, 3.40M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : trimZero(k.toFixed(1))}k`;
  }
  return `${trimZero((n / 1_000_000).toFixed(2))}M`;
}

/** Format a USD cost: under $1 shows 4 decimals (sub-cent precision), else 2. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** Format a duration in seconds as m:ss or h:mm:ss. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function trimZero(s: string): string {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** Peak magnitude of a band array, clamped to [0, 1]. */
export function peakLevel(bands: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < bands.length; i += 1) {
    const v = bands[i];
    if (v > peak) peak = v;
  }
  return peak > 1 ? 1 : peak < 0 ? 0 : peak;
}

export interface UsageEvent {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}

export interface TelemetryRefs {
  transcript: HTMLElement | null;
  activity: HTMLElement | null;
  wave: SVGElement | null;
  tokensIn: HTMLElement | null;
  tokensOut: HTMLElement | null;
  cost: HTMLElement | null;
  turns: HTMLElement | null;
  uptime: HTMLElement | null;
}

export interface TelemetryOptions {
  /** Injectable clock (ms); defaults to performance.now. */
  now?: () => number;
  /** Max transcript lines retained. */
  maxTranscript?: number;
  /** Max activity lines retained. */
  maxActivity?: number;
  /** Waveform sample count (x-resolution). */
  waveSamples?: number;
}

const WAVE_W = 240;
const WAVE_H = 64;

export class TelemetryPanels {
  private readonly refs: TelemetryRefs;
  private readonly now: () => number;
  private readonly maxTranscript: number;
  private readonly maxActivity: number;

  private totalIn = 0;
  private totalOut = 0;
  private totalCost = 0;
  private turnCount = 0;
  private startMs: number | null = null;

  // Oscilloscope: a rolling history of the mic level, eased toward a decaying
  // target so it scrolls smoothly and settles flat when the mic is quiet.
  private readonly history: number[];
  private targetLevel = 0;
  private currentLevel = 0;
  private readonly waveLine: SVGElement | null;

  constructor(refs: TelemetryRefs, opts: TelemetryOptions = {}) {
    this.refs = refs;
    this.now = opts.now ?? (() => performance.now());
    this.maxTranscript = opts.maxTranscript ?? 40;
    this.maxActivity = opts.maxActivity ?? 30;
    this.history = new Array<number>(opts.waveSamples ?? 80).fill(0);

    // Build the oscilloscope polyline inside the provided <svg> wave ref.
    this.waveLine = refs.wave ? document.createElementNS(SVG_NS, 'polyline') : null;
    if (refs.wave && this.waveLine) {
      refs.wave.setAttribute('viewBox', `0 0 ${WAVE_W} ${WAVE_H}`);
      refs.wave.setAttribute('preserveAspectRatio', 'none');
      this.waveLine.setAttribute('class', 'wave-line');
      this.waveLine.setAttribute('fill', 'none');
      refs.wave.appendChild(this.waveLine);
    }
    this.renderUsage();
    this.drawWave();
  }

  /** Mark t=0 for uptime (call once the session is live). */
  startUptime(): void {
    this.startMs = this.now();
  }

  /** Append a transcript line (role-tagged, XSS-safe via textContent). */
  addTranscript(role: 'user' | 'jarvis', text: string): void {
    const host = this.refs.transcript;
    if (!host) return;
    host.querySelector('.t-empty')?.remove(); // drop the "awaiting input" placeholder
    const line = document.createElement('div');
    line.className = `t-line t-${role}`;
    const tag = document.createElement('span');
    tag.className = 't-role';
    tag.textContent = role === 'user' ? 'YOU' : 'JARVIS';
    const body = document.createElement('span');
    body.className = 't-text';
    body.textContent = text;
    line.append(tag, body);
    host.appendChild(line);
    this.cap(host, this.maxTranscript);
    host.scrollTop = host.scrollHeight;
  }

  /** Append a tool-activity line ("Read foo.ts"). */
  addActivity(name: string, target: string): void {
    const host = this.refs.activity;
    if (!host) return;
    host.querySelector('.a-empty')?.remove(); // drop the "idle" placeholder
    const line = document.createElement('div');
    line.className = 'a-line';
    const n = document.createElement('span');
    n.className = 'a-name';
    n.textContent = name;
    line.appendChild(n);
    if (target) {
      const t = document.createElement('span');
      t.className = 'a-target';
      t.textContent = target;
      line.appendChild(t);
    }
    host.appendChild(line);
    this.cap(host, this.maxActivity);
    host.scrollTop = host.scrollHeight;
  }

  /** Fold one turn's usage into the running session totals and re-render. */
  addUsage(u: UsageEvent): void {
    this.totalIn += Math.max(0, u.input_tokens) + Math.max(0, u.cache_read_tokens);
    this.totalOut += Math.max(0, u.output_tokens);
    this.totalCost += Math.max(0, u.cost_usd);
    this.turnCount += 1;
    this.renderUsage();
  }

  /** Feed the oscilloscope the latest mic spectrum (peak drives the deflection). */
  pushBands(bands: Float32Array): void {
    this.targetLevel = peakLevel(bands);
  }

  /** Advance + redraw the oscilloscope one frame (called by the host rAF). */
  tickWave(): void {
    this.currentLevel += (this.targetLevel - this.currentLevel) * 0.35;
    this.targetLevel *= 0.9; // decay so the trace falls flat when the mic is quiet
    this.history.push(this.currentLevel);
    this.history.shift();
    this.drawWave();
  }

  /** Refresh the uptime readout (called by the host rAF / a slow timer). */
  tickUptime(): void {
    if (this.startMs === null || !this.refs.uptime) return;
    this.refs.uptime.textContent = formatDuration((this.now() - this.startMs) / 1000);
  }

  private renderUsage(): void {
    if (this.refs.tokensIn) this.refs.tokensIn.textContent = formatTokens(this.totalIn);
    if (this.refs.tokensOut) this.refs.tokensOut.textContent = formatTokens(this.totalOut);
    if (this.refs.cost) this.refs.cost.textContent = formatCost(this.totalCost);
    if (this.refs.turns) this.refs.turns.textContent = String(this.turnCount);
  }

  private drawWave(): void {
    if (!this.waveLine) return;
    const n = this.history.length;
    const pts: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * WAVE_W;
      const y = WAVE_H - 3 - this.history[i] * (WAVE_H - 8);
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    this.waveLine.setAttribute('points', pts.join(' '));
  }

  private cap(host: HTMLElement, max: number): void {
    while (host.childElementCount > max && host.firstElementChild) {
      host.removeChild(host.firstElementChild);
    }
  }
}
