/**
 * Fleet telemetry: the combined spend across every Claude session (the primary conductor
 * plus all workers). Each session emits a per-turn `cost_usd` delta (the same the session
 * strip accumulates), so the fleet total is just their running sum. The readout only shows
 * when 2+ sessions are live, since with one session it would duplicate the session strip.
 */

function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export interface FleetMeter {
  /** Fold one session's per-turn cost delta into the fleet total. */
  addCost(usd: number): void;
  /** Set the number of live sessions (primary + workers); hides the readout below 2. */
  setActive(sessions: number): void;
}

export function createFleetMeter(
  container: HTMLElement | null,
  value: HTMLElement | null,
): FleetMeter {
  let cost = 0;
  let active = 1;
  const render = (): void => {
    if (container) container.style.display = active >= 2 ? '' : 'none';
    if (value) value.textContent = `${formatCost(cost)} · ${active}`;
  };
  render();
  return {
    addCost(usd: number): void {
      if (usd > 0) cost += usd;
      render();
    },
    setActive(sessions: number): void {
      active = Math.max(0, sessions);
      render();
    },
  };
}
