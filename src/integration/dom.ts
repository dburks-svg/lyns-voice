/**
 * DOM helpers shared by the integration layer.
 *
 * Security: any host- or user-derived string is written with `textContent`,
 * never `innerHTML`, so transcript/state text can never inject markup or script.
 */

export function safeSetText(element: HTMLElement | null, text: string): void {
  if (element) {
    element.textContent = text;
  }
}
