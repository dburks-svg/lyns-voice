/**
 * The propose-then-approve card. When Q proposes splitting work into parallel sessions
 * (a `<<propose:...>>` marker), the user approves or declines with a click: an
 * eyes-and-hands decision (a voice answer is optional, never required), gating any fan-out
 * before N sessions and N-times the spend happen. Approve tells Q to go ahead (he then
 * emits the spawn markers); decline tells him not to. Reuses the onboarding overlay look;
 * the proposal text is rendered with textContent (never innerHTML), so it is injection-safe.
 */
export interface ProposeCardOptions {
  summary: string;
  /** Card heading; defaults to the propose flow's "Parallelize this?". */
  heading?: string;
  onApprove: () => void;
  onDecline: () => void;
}

export function showProposeCard(opts: ProposeCardOptions): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'propose-overlay';
  overlay.style.cssText = `position:fixed; inset:0; z-index:9998; display:flex;
    align-items:center; justify-content:center; background:rgba(2,6,12,0.72);
    backdrop-filter:blur(3px);`;

  const card = document.createElement('div');
  card.style.cssText = `max-width:480px; margin:24px; padding:22px 26px;
    background:rgba(8,16,26,0.97); border:1px solid var(--accent-soft, #2af);
    color:#cfe9f5; font-family:var(--mono, monospace); font-size:13px; line-height:1.6;
    box-shadow:0 0 40px rgba(0,160,255,0.18);`;

  const heading = document.createElement('h2');
  heading.style.cssText = 'margin:0 0 10px; font-size:15px; letter-spacing:0.06em; color:var(--accent, #3cf);';
  heading.textContent = opts.heading ?? 'Parallelize this?';

  const body = document.createElement('p');
  body.style.cssText = 'margin:0 0 18px;';
  body.textContent = opts.summary; // textContent: the proposal is host text, never markup

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex; gap:10px; justify-content:flex-end;';
  const btnStyle = `appearance:none; cursor:pointer; font-family:inherit; font-size:13px;
    padding:7px 16px; border-radius:3px;`;

  const approve = document.createElement('button');
  approve.className = 'propose-approve';
  approve.textContent = 'Approve';
  approve.style.cssText = `${btnStyle} background:rgba(0,160,255,0.16);
    border:1px solid var(--accent, #3cf); color:var(--accent, #3cf);`;

  const decline = document.createElement('button');
  decline.className = 'propose-decline';
  decline.textContent = 'Decline';
  decline.style.cssText = `${btnStyle} background:transparent;
    border:1px solid rgba(160,180,200,0.4); color:#9fb4c8;`;

  const close = (): void => overlay.remove();
  approve.addEventListener('click', () => {
    close();
    opts.onApprove();
  });
  decline.addEventListener('click', () => {
    close();
    opts.onDecline();
  });

  buttons.append(decline, approve);
  card.append(heading, body, buttons);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  return overlay;
}
