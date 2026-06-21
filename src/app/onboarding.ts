/**
 * One-time first-run overlay: explains the four orb states, how to connect a
 * project, and that the first tap-to-talk downloads the speech model once. Shown
 * when `onboarded` is false; dismissing it calls back so the flag can be saved.
 *
 * Built with a static innerHTML template (no host/user data, so injection-safe) and
 * inline styles, since it is single-use chrome that does not warrant its own stylesheet.
 */
export function showOnboarding(onDismiss: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  overlay.style.cssText = `position:fixed; inset:0; z-index:9999; display:flex;
    align-items:center; justify-content:center; background:rgba(2,6,12,0.82);
    backdrop-filter:blur(4px);`;

  const card = document.createElement('div');
  card.style.cssText = `max-width:560px; margin:24px; padding:24px 28px;
    background:rgba(8,16,26,0.96); border:1px solid var(--accent-soft, #2af);
    color:#cfe9f5; font-family:var(--mono, monospace); font-size:13px; line-height:1.6;
    box-shadow:0 0 40px rgba(0,160,255,0.18);`;
  card.innerHTML = `
    <h2 style="margin:0 0 12px; font-size:16px; letter-spacing:0.06em; color:var(--accent, #3cf);">Welcome to Q</h2>
    <p style="margin:0 0 10px;">Q is the voice and face of Claude Code. The orb shows four states:</p>
    <ul style="margin:0 0 12px; padding-left:18px;">
      <li><b>Idle</b> - waiting.</li>
      <li><b>Listening</b> - the orb tracks your mic; speak, and it auto-sends on a pause.</li>
      <li><b>Thinking</b> - Claude is working.</li>
      <li><b>Speaking</b> - Q reads the reply aloud.</li>
    </ul>
    <p style="margin:0 0 10px;">To start: open <b>settings</b>, <b>browse</b> to a project folder, and
      <b>connect claude</b>. A session panel opens with the live work; type into it or talk
      (Space or the mic). <b>Esc</b> interrupts a turn; <b>Alt+J</b> toggles the session panel.</p>
    <p style="margin:0 0 16px; opacity:0.8;">The first tap-to-talk downloads a ~140 MB speech model once. It stays on your machine.</p>
    <button class="onboarding-dismiss" style="appearance:none; cursor:pointer;
      background:rgba(0,160,255,0.14); border:1px solid var(--accent, #3cf);
      color:var(--accent, #3cf); font-family:inherit; font-size:13px; padding:8px 18px;
      border-radius:3px;">Got it</button>
  `;

  overlay.appendChild(card);
  const dismiss = (): void => {
    overlay.remove();
    onDismiss();
  };
  card.querySelector('.onboarding-dismiss')?.addEventListener('click', dismiss);
  document.body.appendChild(overlay);
}
