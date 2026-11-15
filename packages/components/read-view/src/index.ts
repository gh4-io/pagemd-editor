// @pagemd-editor/read-view (P6, amendment 10): Read view shows the paginated canvas read-only, one page or a two-page
// spread at a time. The pages are the pagination's, so this only decides which page(s) are in the window (pure
// functions), shows that window by moving and clipping the canvas, and turns keys and clicks into page flips. No
// animation (the plan's choice).

/** The pages in view, 0-based and inclusive: one page, or the spread (pages 1+2, 3+4, … when `spread`). */
export function windowOf(index: number, total: number, spread: boolean): { first: number; last: number } {
  const at = Math.min(Math.max(0, index), Math.max(0, total - 1));
  if (!spread) return { first: at, last: at };
  const first = at - (at % 2);
  return { first, last: Math.min(first + 1, Math.max(0, total - 1)) };
}

export type Flip = 'next' | 'previous' | 'first' | 'last';

/** The page to show after `flip` from the window `index` is in; a spread moves by two, and never past either end. */
export function flipped(index: number, flip: Flip, total: number, spread: boolean): number {
  const step = spread ? 2 : 1;
  const { first } = windowOf(index, total, spread);
  const last = windowOf(total - 1, total, spread).first;
  switch (flip) {
    case 'next':
      return Math.min(last, first + step);
    case 'previous':
      return Math.max(0, first - step);
    case 'first':
      return 0;
    case 'last':
      return last;
  }
}

/** The flip a key asks for (the window is a page, so the arrows, Page keys and Space all flip), or null. */
export function flipForKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): Flip | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      return 'next';
    case ' ':
      return event.shiftKey ? 'previous' : 'next';
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'Backspace':
      return 'previous';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

/** A click on the left half goes back, on the right half forward. */
export const flipForClick = (clientX: number, left: number, width: number): Flip => (clientX < left + width / 2 ? 'previous' : 'next');

export interface ReadViewOptions {
  /** The author asked to flip (key or click). */
  onFlip(flip: Flip): void;
}

/** The window onto the canvas: attach while Read is the view. */
export class ReadView {
  readonly #scroller: HTMLElement;
  readonly #canvas: HTMLElement;
  readonly #options: ReadViewOptions;
  #on = false;
  readonly #onKey = (event: KeyboardEvent): void => {
    const flip = flipForKey(event);
    if (!flip) return;
    event.preventDefault();
    this.#options.onFlip(flip);
  };
  readonly #onClick = (event: MouseEvent): void => {
    if ((event.target as Element | null)?.closest?.('a[href]')) return; // links keep their own click
    const selection = this.#scroller.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed) return; // the end of a text selection isn't a flip
    const rect = this.#scroller.getBoundingClientRect();
    this.#options.onFlip(flipForClick(event.clientX, rect.left, rect.width));
  };

  constructor(scroller: HTMLElement, canvas: HTMLElement, options: ReadViewOptions) {
    this.#scroller = scroller;
    this.#canvas = canvas;
    this.#options = options;
  }

  get active(): boolean {
    return this.#on;
  }

  enter(): void {
    if (this.#on) return;
    this.#on = true;
    this.#scroller.classList.add('pmd-reading');
    this.#scroller.ownerDocument.addEventListener('keydown', this.#onKey);
    this.#scroller.addEventListener('click', this.#onClick);
  }

  leave(): void {
    if (!this.#on) return;
    this.#on = false;
    this.#scroller.classList.remove('pmd-reading');
    this.#scroller.ownerDocument.removeEventListener('keydown', this.#onKey);
    this.#scroller.removeEventListener('click', this.#onClick);
    const style = this.#canvas.style;
    style.removeProperty('margin-top');
    style.removeProperty('clip-path');
    this.#scroller.scrollTop = 0;
  }

  /** Shows the part of the canvas from `top` for `height` px (canvas px, as laid out: not zoomed) and nothing else. */
  show(top: number, height: number): void {
    if (!this.#on) return;
    const style = this.#canvas.style;
    style.setProperty('margin-top', `${-top}px`);
    style.setProperty('clip-path', `inset(${top}px 0 calc(100% - ${top + height}px) 0)`);
    this.#scroller.scrollTop = 0;
  }
}

export const readViewCss = `
.pmd-scroll.pmd-reading { overflow: hidden; padding: 12px 0; box-sizing: border-box; cursor: pointer; }
.pmd-scroll.pmd-reading a[href] { cursor: pointer; }
`;
