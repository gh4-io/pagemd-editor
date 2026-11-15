// @pagemd-editor/ruler (P6, amendment 9): a horizontal and a vertical ruler beside the page at the top of the window,
// with margin handles, and guides drawn on the papers (margins, header and footer areas). Dragging a margin handle
// ends in `onChange(page)` with the new geometry; the app decides what that does (create a layout file). Editor UI,
// so it uses the VS Code theme variables.
import type { PageGeometry } from '@pagemd-editor/core';

export type Side = 'top' | 'right' | 'bottom' | 'left';

/** CSS px per millimetre (96 px per inch). */
const PX_PER_MM = 96 / 25.4;
/** What a margin drag can't squeeze below: the text area keeps at least this much (mm) in each direction. */
export const MIN_BODY_MM = 30;
/** Margins snap to this many mm while dragging. */
export const SNAP_MM = 0.5;

export const snapMm = (mm: number, step = SNAP_MM): number => Math.round(mm / step) * step;

/** `page` with `side`'s margin set to about `mm` (snapped, never negative, leaving MIN_BODY_MM of text area). */
export function withMargin(page: PageGeometry, side: Side, mm: number): PageGeometry {
  const horizontal = side === 'left' || side === 'right';
  const opposite: Side = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[side] as Side;
  const total = horizontal ? page.width : page.height;
  const max = Math.max(0, total - page.margins[opposite] - MIN_BODY_MM);
  const value = Math.min(max, Math.max(0, snapMm(mm)));
  return { ...page, margins: { ...page.margins, [side]: value } };
}

export const sameMargins = (a: PageGeometry, b: PageGeometry): boolean =>
  (['top', 'right', 'bottom', 'left'] as const).every((s) => Math.abs(a.margins[s] - b.margins[s]) < 0.001);

/** Where the page is on screen: its paper's rectangle (client px, as zoomed) and the geometry it was drawn from. */
export interface RulerTarget {
  rect: { left: number; top: number; width: number; height: number };
  geometry: PageGeometry;
  /** False for a named page (LAYOUT): shown, not draggable, since a layout file changes the plain page only. */
  draggable: boolean;
}

export interface RulerOptions {
  /** A margin drag ended with these margins (a change from the page shown). */
  onChange(page: PageGeometry): void | Promise<void>;
}

const el = (doc: Document, tag: string, cls: string): HTMLElement => {
  const e = doc.createElement(tag);
  e.className = cls;
  return e;
};

export class Ruler {
  readonly horizontal: HTMLElement;
  readonly vertical: HTMLElement;
  readonly #body: HTMLElement;
  readonly #scroller: HTMLElement;
  readonly #line: HTMLElement;
  readonly #options: RulerOptions;
  #target: RulerTarget | null = null;
  #dragging = false;

  /** Wraps `scroller` (inside `app`) with the vertical ruler beside it and the horizontal one above. */
  constructor(app: HTMLElement, scroller: HTMLElement, options: RulerOptions) {
    const doc = app.ownerDocument;
    this.#options = options;
    this.#scroller = scroller;
    this.horizontal = el(doc, 'div', 'pmd-ruler pmd-ruler-h');
    this.vertical = el(doc, 'div', 'pmd-ruler pmd-ruler-v');
    this.#body = el(doc, 'div', 'pmd-body');
    this.#line = el(doc, 'div', 'pmd-ruler-line');
    this.#line.hidden = true;
    app.insertBefore(this.#body, scroller);
    this.#body.append(this.vertical, scroller, this.#line);
    app.insertBefore(this.horizontal, this.#body);
    this.show(false);
  }

  show(on: boolean): void {
    this.horizontal.hidden = !on;
    this.vertical.hidden = !on;
    this.#body.classList.toggle('pmd-with-ruler', on);
    if (on) this.#draw();
  }

  get shown(): boolean {
    return !this.horizontal.hidden;
  }

  /** The page the rulers describe (the one at the top of the window), or null to blank them. */
  update(target: RulerTarget | null): void {
    this.#target = target;
    if (this.shown && !this.#dragging) this.#draw();
  }

  destroy(): void {
    this.horizontal.remove();
    this.vertical.remove();
    this.#line.remove();
    this.#body.replaceWith(this.#scroller);
  }

  #draw(): void {
    this.horizontal.replaceChildren();
    this.vertical.replaceChildren();
    const t = this.#target;
    if (!t) return;
    const doc = this.horizontal.ownerDocument;
    const scroller = this.#scroller.getBoundingClientRect();
    const pxPerMm = t.rect.width / t.geometry.width;
    const { margins: m, width, height } = t.geometry;
    const draggable = t.draggable;

    // Horizontal: positions measured from the scroller's left (the ruler starts at the same x).
    const x0 = t.rect.left - scroller.left;
    this.#strip(doc, this.horizontal, 'h', x0, width, m.left, m.right, pxPerMm);
    this.#handle(doc, this.horizontal, 'h', 'left', x0 + m.left * pxPerMm, draggable, t);
    this.#handle(doc, this.horizontal, 'h', 'right', x0 + (width - m.right) * pxPerMm, draggable, t);

    // Vertical: from the scroller's top.
    const y0 = t.rect.top - scroller.top;
    this.#strip(doc, this.vertical, 'v', y0, height, m.top, m.bottom, pxPerMm);
    this.#handle(doc, this.vertical, 'v', 'top', y0 + m.top * pxPerMm, draggable, t);
    this.#handle(doc, this.vertical, 'v', 'bottom', y0 + (height - m.bottom) * pxPerMm, draggable, t);
  }

  /** The paper's extent on the ruler, its margin zones shaded (the header/footer areas on the vertical one), and ticks. */
  #strip(doc: Document, ruler: HTMLElement, axis: 'h' | 'v', start: number, length: number, before: number, after: number, pxPerMm: number): void {
    const place = (e: HTMLElement, from: number, size: number) => {
      e.style[axis === 'h' ? 'left' : 'top'] = `${from}px`;
      e.style[axis === 'h' ? 'width' : 'height'] = `${size}px`;
    };
    const paper = el(doc, 'div', 'pmd-ruler-paper');
    place(paper, start, length * pxPerMm);
    const zoneBefore = el(doc, 'div', 'pmd-ruler-zone');
    place(zoneBefore, start, before * pxPerMm);
    const zoneAfter = el(doc, 'div', 'pmd-ruler-zone');
    place(zoneAfter, start + (length - after) * pxPerMm, after * pxPerMm);
    if (axis === 'v') {
      zoneBefore.title = 'Header area';
      zoneAfter.title = 'Footer area';
    }
    ruler.append(paper, zoneBefore, zoneAfter);
    for (let mm = 0; mm <= length; mm += 5) {
      const tick = el(doc, 'div', mm % 10 === 0 ? 'pmd-ruler-tick pmd-ruler-tick-major' : 'pmd-ruler-tick');
      tick.style[axis === 'h' ? 'left' : 'top'] = `${start + mm * pxPerMm}px`;
      if (mm % 10 === 0 && mm > 0 && mm % 20 === 0) tick.dataset['label'] = String(mm / 10);
      ruler.append(tick);
    }
  }

  #handle(doc: Document, ruler: HTMLElement, axis: 'h' | 'v', side: Side, at: number, draggable: boolean, target: RulerTarget): void {
    const handle = el(doc, 'div', 'pmd-ruler-handle');
    handle.dataset['side'] = side;
    handle.style[axis === 'h' ? 'left' : 'top'] = `${at}px`;
    handle.title = `${side[0]!.toUpperCase()}${side.slice(1)} margin: ${Math.round(target.geometry.margins[side] * 10) / 10} mm${draggable ? ' (drag to change)' : ''}`;
    if (!draggable) handle.classList.add('pmd-ruler-handle-fixed');
    else handle.addEventListener('pointerdown', (event) => this.#drag(event, handle, axis, side, target));
    ruler.append(handle);
  }

  #drag(event: PointerEvent, handle: HTMLElement, axis: 'h' | 'v', side: Side, target: RulerTarget): void {
    event.preventDefault();
    this.#dragging = true;
    handle.setPointerCapture?.(event.pointerId);
    const pxPerMm = target.rect.width / target.geometry.width;
    const body = this.#body.getBoundingClientRect();
    let next = target.geometry;
    const compute = (e: PointerEvent): PageGeometry => {
      const r = target.rect;
      const mm =
        side === 'left' ? (e.clientX - r.left) / pxPerMm : side === 'right' ? (r.left + r.width - e.clientX) / pxPerMm : side === 'top' ? (e.clientY - r.top) / pxPerMm : (r.top + r.height - e.clientY) / pxPerMm;
      return withMargin(target.geometry, side, mm);
    };
    const move = (e: PointerEvent): void => {
      next = compute(e);
      const r = target.rect;
      const m = next.margins[side];
      const at = side === 'left' ? r.left + m * pxPerMm : side === 'right' ? r.left + r.width - m * pxPerMm : side === 'top' ? r.top + m * pxPerMm : r.top + r.height - m * pxPerMm;
      handle.style[axis === 'h' ? 'left' : 'top'] = `${at - (axis === 'h' ? this.#scroller.getBoundingClientRect().left : this.#scroller.getBoundingClientRect().top)}px`;
      this.#line.hidden = false;
      this.#line.dataset['axis'] = axis;
      if (axis === 'h') {
        this.#line.style.left = `${at - body.left}px`;
        this.#line.style.top = '0';
        this.#line.style.height = `${body.height}px`;
        this.#line.style.width = '0';
      } else {
        this.#line.style.top = `${at - body.top}px`;
        this.#line.style.left = '0';
        this.#line.style.width = `${body.width}px`;
        this.#line.style.height = '0';
      }
    };
    const end = (e: PointerEvent): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.releasePointerCapture?.(e.pointerId);
      this.#line.hidden = true;
      this.#dragging = false;
      // The handle goes back to where the page's margin really is once the change is done (or declined).
      if (e.type === 'pointerup' && !sameMargins(next, target.geometry)) void Promise.resolve(this.#options.onChange(next)).finally(() => this.#draw());
      else this.#draw();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

// ── guides on the papers ──

export const GUIDES_CLASS = 'pmd-guides';

/** Draws (or removes) each paper's margin guides and its header and footer areas. `papers[i]` is page `i + 1`'s paper. */
export function drawGuides(papers: readonly HTMLElement[], geometries: ReadonlyArray<PageGeometry | undefined>, on: boolean): void {
  papers.forEach((paper, i) => {
    let guides = paper.querySelector<HTMLElement>(`:scope > .${GUIDES_CLASS}`);
    const g = geometries[i];
    if (!on || !g) {
      guides?.remove();
      return;
    }
    const doc = paper.ownerDocument;
    if (!guides) {
      guides = el(doc, 'div', GUIDES_CLASS);
      guides.setAttribute('aria-hidden', 'true');
      for (const cls of ['header', 'footer', 'margins']) guides.append(el(doc, 'div', `pmd-guide pmd-guide-${cls}`));
      paper.prepend(guides);
    }
    const px = (mm: number) => `${mm * PX_PER_MM}px`;
    const set = (cls: string, style: Record<string, string>) => Object.assign((guides!.querySelector(`.pmd-guide-${cls}`) as HTMLElement).style, style);
    set('header', { left: '0', right: '0', top: '0', height: px(g.margins.top) });
    set('footer', { left: '0', right: '0', bottom: '0', height: px(g.margins.bottom) });
    set('margins', { left: px(g.margins.left), right: px(g.margins.right), top: px(g.margins.top), bottom: px(g.margins.bottom) });
  });
}

export const rulerCss = `
.pmd-body { display: flex; flex: 1; min-height: 0; position: relative; }
.pmd-body > .pmd-scroll { flex: 1; min-width: 0; }
.pmd-ruler { position: relative; overflow: hidden; flex: none; background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-descriptionForeground, #999); font-size: 9px; user-select: none; }
.pmd-ruler[hidden] { display: none; }
.pmd-ruler-h { height: 18px; margin-left: 18px; border-bottom: 1px solid var(--vscode-panel-border, #444); }
.pmd-ruler-v { width: 18px; border-right: 1px solid var(--vscode-panel-border, #444); }
.pmd-ruler-paper { position: absolute; background: var(--vscode-editor-background, #1e1e1e); }
.pmd-ruler-h .pmd-ruler-paper, .pmd-ruler-h .pmd-ruler-zone { top: 3px; bottom: 3px; }
.pmd-ruler-v .pmd-ruler-paper, .pmd-ruler-v .pmd-ruler-zone { left: 3px; right: 3px; }
.pmd-ruler-zone { position: absolute; background: var(--vscode-editorWidget-background, #252526); opacity: 0.85; }
.pmd-ruler-tick { position: absolute; background: var(--vscode-descriptionForeground, #999); }
.pmd-ruler-h .pmd-ruler-tick { bottom: 3px; width: 1px; height: 3px; }
.pmd-ruler-h .pmd-ruler-tick-major { height: 6px; }
.pmd-ruler-v .pmd-ruler-tick { right: 3px; height: 1px; width: 3px; }
.pmd-ruler-v .pmd-ruler-tick-major { width: 6px; }
.pmd-ruler-tick[data-label]::after { content: attr(data-label); position: absolute; font-size: 8px; }
.pmd-ruler-h .pmd-ruler-tick[data-label]::after { left: 2px; bottom: 6px; }
.pmd-ruler-v .pmd-ruler-tick[data-label]::after { right: 6px; top: 1px; }
.pmd-ruler-handle { position: absolute; background: var(--vscode-focusBorder, #07f); opacity: 0.9; }
.pmd-ruler-h .pmd-ruler-handle { top: 0; width: 5px; height: 18px; margin-left: -2px; cursor: ew-resize; }
.pmd-ruler-v .pmd-ruler-handle { left: 0; height: 5px; width: 18px; margin-top: -2px; cursor: ns-resize; }
.pmd-ruler-handle-fixed { opacity: 0.4; cursor: default !important; }
.pmd-ruler-line { position: absolute; z-index: 10; pointer-events: none; border: 0 dashed var(--vscode-focusBorder, #07f); }
.pmd-ruler-line[data-axis="h"] { border-left-width: 1px; }
.pmd-ruler-line[data-axis="v"] { border-top-width: 1px; }
.pmd-canvas .${GUIDES_CLASS} { position: absolute; inset: 0; pointer-events: none; }
.pmd-canvas .pmd-guide { position: absolute; }
.pmd-canvas .pmd-guide-header, .pmd-canvas .pmd-guide-footer { background: rgba(0, 120, 215, 0.05); }
.pmd-canvas .pmd-guide-header { border-bottom: 1px dotted rgba(0, 120, 215, 0.45); }
.pmd-canvas .pmd-guide-footer { border-top: 1px dotted rgba(0, 120, 215, 0.45); }
.pmd-canvas .pmd-guide-margins { border: 1px dashed rgba(0, 120, 215, 0.25); }
`;
