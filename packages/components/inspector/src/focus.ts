// A form that is drawn again must not drop the keyboard's place (P13b, found by the keyboard-only journey): Enter in a box
// commits the change, the change redraws the form, and the box that had the focus is gone, so the focus fell to the page
// (`document.activeElement` was `body`). `keepFocus` notes which control had it (its field, and which control of that field) and
// gives it to the same control in the new drawing; when that is gone too, to `fallback`, never to nothing.

const CONTROLS = 'input, select, textarea, button, [tabindex]';

/** The control of the redrawn form that matches what was focused before, or null. */
function find(root: HTMLElement, before: { scope: string; nth: number } | { cls: string }): HTMLElement | null {
  if ('cls' in before) return root.querySelector<HTMLElement>(`.${CSS.escape(before.cls)}`);
  const scope = root.querySelector<HTMLElement>(before.scope);
  return scope ? ([...scope.querySelectorAll<HTMLElement>(CONTROLS)][before.nth] ?? null) : null;
}

/** Runs `redraw`, then puts the focus back where it was inside `root` if the redraw took it away. */
export function keepFocus(root: HTMLElement, redraw: () => void, fallback?: () => HTMLElement | null): void {
  const doc = root.ownerDocument;
  const active = doc.activeElement as HTMLElement | null;
  let before: { scope: string; nth: number } | { cls: string } | null = null;
  if (active && root.contains(active)) {
    // A property row is named by its key; the one field inside it is always called "value" (so `[data-field="value"]` would find the FIRST
    // property's box after every redraw: the focus jumped to Title, and Tab then started again from there).
    const scope = active.closest<HTMLElement>('[data-property]') ?? active.closest<HTMLElement>('[data-field]');
    if (scope) {
      const attr = scope.hasAttribute('data-field') ? 'data-field' : 'data-property';
      const target = scope.closest<HTMLElement>('[data-target]')?.dataset['target'];
      before = { scope: `${target ? `[data-target="${CSS.escape(target)}"] ` : ''}[${attr}="${CSS.escape(scope.getAttribute(attr)!)}"]`, nth: [...scope.querySelectorAll<HTMLElement>(CONTROLS)].indexOf(active) };
    } else if (active.classList.length > 0) before = { cls: active.classList[0]! };
  }
  redraw();
  if (!before) return;
  const now = doc.activeElement;
  if (now && now !== doc.body && root.contains(now)) return; // still has it (or something in the form does)
  (find(root, before) ?? fallback?.() ?? null)?.focus();
}
