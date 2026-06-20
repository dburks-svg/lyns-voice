import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  formatCost,
  formatDuration,
  peakLevel,
  TelemetryPanels,
  type TelemetryRefs,
} from '../src/integration/telemetry';

describe('telemetry formatters', () => {
  it('formatTokens is compact and rounded', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(942)).toBe('942');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(12345)).toBe('12.3k');
    expect(formatTokens(100000)).toBe('100k');
    expect(formatTokens(3_400_000)).toBe('3.4M');
  });

  it('formatCost shows sub-cent precision under $1', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0123)).toBe('$0.0123');
    expect(formatCost(1.5)).toBe('$1.50');
  });

  it('formatDuration is m:ss or h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('peakLevel returns the clamped peak of the bands', () => {
    expect(peakLevel(new Float32Array([0.1, 0.7, 0.3]))).toBeCloseTo(0.7);
    expect(peakLevel(new Float32Array([2, -1]))).toBe(1);
    expect(peakLevel(new Float32Array([]))).toBe(0);
  });
});

function makeRefs(): { refs: TelemetryRefs; svg: SVGElement } {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const el = (): HTMLElement => document.createElement('div');
  return {
    svg,
    refs: {
      transcript: el(),
      activity: el(),
      wave: svg,
      tokensIn: el(),
      tokensOut: el(),
      cost: el(),
      turns: el(),
      uptime: el(),
    },
  };
}

describe('TelemetryPanels', () => {
  it('appends transcript lines with role + text and clears the placeholder', () => {
    const { refs } = makeRefs();
    const placeholder = document.createElement('div');
    placeholder.className = 't-empty';
    refs.transcript?.appendChild(placeholder);

    const panels = new TelemetryPanels(refs);
    panels.addTranscript('user', 'hello there');
    panels.addTranscript('q', 'hi');

    expect(refs.transcript?.querySelector('.t-empty')).toBeNull();
    const lines = refs.transcript?.querySelectorAll('.t-line');
    expect(lines?.length).toBe(2);
    expect(lines?.[0].querySelector('.t-role')?.textContent).toBe('YOU');
    expect(lines?.[0].querySelector('.t-text')?.textContent).toBe('hello there');
    expect(lines?.[1].querySelector('.t-role')?.textContent).toBe('Q');
  });

  it('renders transcript text via textContent (no markup injection)', () => {
    const { refs } = makeRefs();
    const panels = new TelemetryPanels(refs);
    panels.addTranscript('user', '<img src=x onerror=alert(1)>');
    expect(refs.transcript?.querySelector('img')).toBeNull();
    expect(refs.transcript?.querySelector('.t-text')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('caps transcript history at the configured max', () => {
    const { refs } = makeRefs();
    const panels = new TelemetryPanels(refs, { maxTranscript: 3 });
    for (let i = 0; i < 6; i += 1) panels.addTranscript('user', `line ${i}`);
    const lines = refs.transcript?.querySelectorAll('.t-line');
    expect(lines?.length).toBe(3);
    expect(lines?.[0].querySelector('.t-text')?.textContent).toBe('line 3');
  });

  it('appends activity lines with name + target', () => {
    const { refs } = makeRefs();
    const panels = new TelemetryPanels(refs);
    panels.addActivity('Read', 'src/foo.ts');
    const line = refs.activity?.querySelector('.a-line');
    expect(line?.querySelector('.a-name')?.textContent).toBe('Read');
    expect(line?.querySelector('.a-target')?.textContent).toBe('src/foo.ts');
  });

  it('accumulates usage across turns', () => {
    const { refs } = makeRefs();
    const panels = new TelemetryPanels(refs);
    panels.addUsage({
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 200,
      cache_creation_tokens: 0,
      cost_usd: 0.01,
    });
    panels.addUsage({
      input_tokens: 500,
      output_tokens: 300,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.02,
    });
    // in = 1000+200 + 500 = 1.7k ; out = 200+300 = 500 ; cost = $0.0300 ; turns = 2
    expect(refs.tokensIn?.textContent).toBe('1.7k');
    expect(refs.tokensOut?.textContent).toBe('500');
    expect(refs.cost?.textContent).toBe('$0.0300');
    expect(refs.turns?.textContent).toBe('2');
  });

  it('draws an oscilloscope polyline that responds to band input', () => {
    const { refs, svg } = makeRefs();
    const panels = new TelemetryPanels(refs, { waveSamples: 16 });
    const line = svg.querySelector('polyline');
    expect(line).not.toBeNull();

    // Quiet: with no input the trace sits at the baseline (all points equal y).
    panels.tickWave();
    const quiet = line?.getAttribute('points') ?? '';
    expect(quiet.length).toBeGreaterThan(0);

    // Loud: push a high peak and advance; the most recent sample deflects up.
    panels.pushBands(new Float32Array([1, 1, 1]));
    panels.tickWave();
    const loud = line?.getAttribute('points') ?? '';
    expect(loud).not.toBe(quiet);
  });

  it('updates uptime from the injected clock', () => {
    const { refs } = makeRefs();
    let t = 0;
    const panels = new TelemetryPanels(refs, { now: () => t });
    panels.startUptime();
    t = 65_000;
    panels.tickUptime();
    expect(refs.uptime?.textContent).toBe('1:05');
  });
});
