/**
 * Pure drag-and-resize logic for floating FUI panels. Pointer-capture based,
 * no external dependencies. Reusable for any future panel type.
 */

export interface DragResizeOptions {
  el: HTMLElement;
  dragHandle: HTMLElement;
  minWidth?: number;
  minHeight?: number;
  onMoveStart?: () => void;
  onEnd?: () => void;
}

export function attachDragResize(opts: DragResizeOptions): () => void {
  const { el, dragHandle, minWidth = 300, minHeight = 200, onMoveStart, onEnd } = opts;
  const ac = new AbortController();
  const sig = ac.signal;

  // --- Drag by header ---
  let dragOriginX = 0;
  let dragOriginY = 0;
  let elStartX = 0;
  let elStartY = 0;

  function onDragDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.terminal-close, .tab-close, .tab-add, .tab')) return;
    e.preventDefault();
    onMoveStart?.();
    dragHandle.setPointerCapture(e.pointerId);
    dragOriginX = e.clientX;
    dragOriginY = e.clientY;
    elStartX = el.offsetLeft;
    elStartY = el.offsetTop;
    dragHandle.addEventListener('pointermove', onDragMove, { signal: sig });
    dragHandle.addEventListener('pointerup', onDragUp, { once: true, signal: sig });
  }

  function onDragMove(e: PointerEvent): void {
    const dx = e.clientX - dragOriginX;
    const dy = e.clientY - dragOriginY;
    el.style.left = `${clampX(elStartX + dx)}px`;
    el.style.top = `${clampY(elStartY + dy)}px`;
  }

  function onDragUp(): void {
    dragHandle.removeEventListener('pointermove', onDragMove);
    onEnd?.();
  }

  dragHandle.addEventListener('pointerdown', onDragDown, { signal: sig });

  // --- Resize by edge/corner handles ---
  const handles = el.querySelectorAll<HTMLElement>('.resize-handle');
  handles.forEach((h) => {
    h.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onMoveStart?.();
      h.setPointerCapture(e.pointerId);

      const dir = h.dataset.dir ?? '';
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = el.offsetWidth;
      const startH = el.offsetHeight;
      const startL = el.offsetLeft;
      const startT = el.offsetTop;

      function onResizeMove(ev: PointerEvent): void {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let w = startW;
        let h2 = startH;
        let l = startL;
        let t = startT;

        if (dir.includes('e')) w = Math.max(minWidth, startW + dx);
        if (dir.includes('s')) h2 = Math.max(minHeight, startH + dy);
        if (dir.includes('w')) {
          w = Math.max(minWidth, startW - dx);
          l = startL + (startW - w);
        }
        if (dir.includes('n')) {
          h2 = Math.max(minHeight, startH - dy);
          t = startT + (startH - h2);
        }

        el.style.width = `${w}px`;
        el.style.height = `${h2}px`;
        el.style.left = `${clampX(l)}px`;
        el.style.top = `${clampY(t)}px`;
      }

      function onResizeUp(): void {
        h.removeEventListener('pointermove', onResizeMove);
        onEnd?.();
      }

      h.addEventListener('pointermove', onResizeMove, { signal: sig });
      h.addEventListener('pointerup', onResizeUp, { once: true, signal: sig });
    }, { signal: sig });
  });

  function clampX(x: number): number {
    return Math.max(0, Math.min(x, window.innerWidth - 60));
  }
  function clampY(y: number): number {
    return Math.max(0, Math.min(y, window.innerHeight - 40));
  }

  return () => ac.abort();
}
