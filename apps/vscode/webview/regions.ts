// F6 / Shift+F6 move the focus between the editor's regions: ribbon, the outline, the document (or the code, or the preview),
// the comments, the Inspector and the status bar (P13b, R-208, amendment 8d). It also gets a keyboard user out of a list or a
// table, where Tab belongs to the document. From the last region (and Shift+F6 from the first) the key is NOT handled, so VS Code
// moves on to its next part, as it does everywhere else. The webview forwards every key to VS Code, so a handled key stops here
// (R-158's rule).

export interface Region {
  /** What a screen reader hears when the focus arrives. */
  name: string;
  /** The region's element (the focus is "in" it when it holds the active element). */
  element(): HTMLElement | null;
  /** Shown right now (a closed panel or a hidden view is skipped). */
  shown(): boolean;
  /** Puts the focus in it; false when it could not (the next region is tried). */
  focus(): boolean;
}

/**
 * The region the key goes to: `count` shown regions in screen order, the focus in `current` (-1: none of them), `direction`
 * +1 for F6, -1 for Shift+F6. Null: hand the key back to VS Code (past the last region, or before the first).
 */
export function nextRegion(count: number, current: number, direction: 1 | -1): number | null {
  if (count === 0) return null;
  if (current < 0) return direction === 1 ? 0 : count - 1; // the focus is on none of them: start from the edge
  const next = current + direction;
  return next < 0 || next >= count ? null : next;
}

/** Whether `el` takes room on the page. */
export function isShown(el: HTMLElement | null): boolean {
  return !!el && !el.hidden && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
}

/** The first thing in `el` that takes the keyboard: the Tab stop of a roving group, a button, a field. */
export function firstFocusable(el: HTMLElement): HTMLElement | null {
  const found = [...el.querySelectorAll<HTMLElement>('[tabindex="0"], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]):not([tabindex="-1"]), a[href]')].find(isShown);
  return found ?? null;
}

export class RegionKeys {
  readonly #regions: () => Region[];
  readonly #say: (message: string) => void;
  readonly #listener = (event: KeyboardEvent): void => {
    if (event.key !== 'F6' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    if (this.move(event.shiftKey ? -1 : 1)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  readonly #doc: Document;
  /** The page whose active element says where the focus is (the outer page, for a listener inside a frame). */
  readonly #page: Document;

  constructor(doc: Document, regions: () => Region[], say: (message: string) => void, page: Document = doc) {
    this.#doc = doc;
    this.#page = page;
    this.#regions = regions;
    this.#say = say;
    doc.addEventListener('keydown', this.#listener, true);
  }

  /** Moves the focus; false when the key should go to VS Code. */
  move(direction: 1 | -1): boolean {
    const shown = this.#regions().filter((region) => region.shown());
    const active = this.#page.activeElement;
    if (active?.closest('[aria-modal="true"]')) return false; // a modal dialog keeps the focus in itself (the image dialog)
    let current = shown.findIndex((region) => {
      const el = region.element();
      return !!el && !!active && el.contains(active);
    });
    for (;;) {
      const to = nextRegion(shown.length, current, direction);
      if (to === null) return false;
      const region = shown[to]!;
      if (region.focus()) {
        this.#say(region.name);
        return true;
      }
      current = to; // that one could not take the focus: on to the next
    }
  }

  destroy(): void {
    this.#doc.removeEventListener('keydown', this.#listener, true);
  }
}
