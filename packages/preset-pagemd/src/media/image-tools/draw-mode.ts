// Draw mode (FIX-S50, OQ-63; Word's behaviour: pick a shape, then drag it on the page). "Add arrow", "Add line", "Add box", "Add ellipse",
// "Add highlight" and Redact start it on the selected picture: the pointer becomes a crosshair over the picture, press where the shape
// starts and drag to where it ends (a thin outline follows), let go to place it. A click without a drag places the shape at its usual
// size around the point. Escape, or a click anywhere else, cancels and changes nothing. Placing the shape is one transaction (a plain
// picture becomes an annotated image inside it, as "Add shape" always did), so it is one undo step; the new shape is selected and the
// Inspector opens on it (SHAPE_ADDED_EVENT).
//
// Like crop mode, the layer is drawn over the page in the webview's own coordinates (position: fixed, from the picture's screen box), so it
// needs nothing from the picture's own DOM and works for every form of picture at any zoom.
import { NodeSelection, Plugin, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { boundsOf, KIND_OF, moveEntry, round2, SHAPE_NAME, type Entry, type ShapeList } from './geometry.ts';
import { drawModeKey, type DrawRequest } from './plugin.ts';
import { measure } from './crop-mode.ts';
import { addShapeTransaction, pictureTarget } from './target.ts';
import { FLUSH_EVENT } from './annotation-view.ts';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** A drag shorter than this many screen pixels is a click. */
const CLICK = 4;

/** The entry a drag from `a` to `b` (% of the whole displayed picture) makes; a click (`b` null) moves the usual one to `a`. */
export function drawnEntry(list: ShapeList, base: Entry, a: { x: number; y: number }, b: { x: number; y: number } | null): Entry {
  const kind = KIND_OF[list];
  if (!b) {
    const box = boundsOf(base, kind);
    return moveEntry(base, kind, a.x - (box.x + box.width / 2), a.y - (box.y + box.height / 2));
  }
  if (kind === 'segment') return { ...base, x1: round2(a.x), y1: round2(a.y), x2: round2(b.x), y2: round2(b.y) };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { ...base, x: round2(x), y: round2(y), width: round2(Math.max(Math.abs(b.x - a.x), 0.5)), height: round2(Math.max(Math.abs(b.y - a.y), 0.5)) };
}

class DrawMode {
  readonly #view: EditorView;
  readonly #doc: Document;
  readonly #layer: HTMLElement;
  readonly #catcher: HTMLElement;
  readonly #band: HTMLElement;
  readonly #status: HTMLElement;
  readonly #anchor: Element;
  readonly #list: ShapeList;
  readonly pos: number;
  #at: Box;
  #full: Box;
  #win: Box;
  #drag: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
  #done = false;
  readonly #onOutside = (event: PointerEvent): void => {
    if (event.target instanceof Node && this.#layer.contains(event.target)) return;
    this.finish(null); // a click away cancels
  };
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.finish(null);
    }
  };
  readonly #onScroll = (): void => this.#follow();
  readonly onEnd: () => void;

  constructor(view: EditorView, request: DrawRequest, full: Box, win: Box, anchor: Element, onEnd: () => void) {
    this.#view = view;
    this.#doc = view.dom.ownerDocument;
    this.#list = request.list;
    this.pos = request.pos;
    this.onEnd = onEnd;
    this.#anchor = anchor;
    this.#at = boxOf(anchor);
    this.#full = full;
    this.#win = win;
    const d = this.#doc;
    this.#layer = d.createElement('div');
    this.#layer.className = 'pmd-draw-mode';
    this.#layer.tabIndex = 0;
    this.#layer.setAttribute('role', 'application');
    this.#layer.setAttribute('aria-roledescription', 'draw');
    this.#layer.setAttribute('aria-label', `Draw ${SHAPE_NAME[request.list].toLowerCase()}. Press where it starts, drag to where it ends. Escape cancels.`);
    this.#catcher = d.createElement('div');
    this.#catcher.className = 'pmd-draw-catcher';
    this.#band = d.createElement('div');
    this.#band.className = 'pmd-draw-band';
    this.#band.hidden = true;
    this.#status = d.createElement('div');
    this.#status.className = 'pmd-draw-status';
    this.#status.setAttribute('role', 'status');
    this.#status.textContent = `Draw ${SHAPE_NAME[request.list].toLowerCase()}: press where it starts and drag. Escape cancels.`;
    this.#layer.append(this.#catcher, this.#band, this.#status);
    d.body.append(this.#layer);
    this.#place();
    this.#catcher.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    this.#catcher.addEventListener('pointermove', (e) => this.#pointerMove(e));
    this.#catcher.addEventListener('pointerup', (e) => this.#pointerUp(e));
    this.#catcher.addEventListener('pointercancel', () => this.finish(null));
    d.addEventListener('pointerdown', this.#onOutside, true);
    d.addEventListener('keydown', this.#onKey, true);
    d.addEventListener('scroll', this.#onScroll, true);
    d.defaultView?.addEventListener('resize', this.#onScroll);
    this.#layer.focus({ preventScroll: true });
    d.defaultView?.setTimeout(() => {
      if (!this.#done) this.#layer.focus({ preventScroll: true });
    }, 0);
  }

  #place(): void {
    const w = this.#win;
    Object.assign(this.#catcher.style, { left: `${w.x}px`, top: `${w.y}px`, width: `${w.w}px`, height: `${w.h}px` });
  }

  #follow(): void {
    if (this.#done) return;
    if (!this.#anchor.isConnected) return this.finish(null);
    const now = boxOf(this.#anchor);
    const scale = this.#at.w > 0 ? now.w / this.#at.w : 1;
    const move = (b: Box): Box => ({ x: now.x + (b.x - this.#at.x) * scale, y: now.y + (b.y - this.#at.y) * scale, w: b.w * scale, h: b.h * scale });
    this.#full = move(this.#full);
    this.#win = move(this.#win);
    this.#at = now;
    this.#place();
  }

  /** A screen point as % of the whole displayed picture, kept inside the visible window. */
  #percent(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const w = this.#win;
    const cx = Math.min(Math.max(event.clientX, w.x), w.x + w.w);
    const cy = Math.min(Math.max(event.clientY, w.y), w.y + w.h);
    return { x: ((cx - this.#full.x) / (this.#full.w || 1)) * 100, y: ((cy - this.#full.y) / (this.#full.h || 1)) * 100 };
  }

  #pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.#drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    this.#catcher.setPointerCapture?.(event.pointerId);
  }

  #pointerMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < CLICK) return;
    drag.moved = true;
    const w = this.#win;
    const x1 = Math.min(Math.max(drag.x, w.x), w.x + w.w);
    const y1 = Math.min(Math.max(drag.y, w.y), w.y + w.h);
    const x2 = Math.min(Math.max(event.clientX, w.x), w.x + w.w);
    const y2 = Math.min(Math.max(event.clientY, w.y), w.y + w.h);
    const segment = KIND_OF[this.#list] === 'segment';
    this.#band.hidden = false;
    this.#band.classList.toggle('pmd-draw-band-line', segment);
    if (segment) {
      const length = Math.hypot(x2 - x1, y2 - y1);
      Object.assign(this.#band.style, { left: `${x1}px`, top: `${y1}px`, width: `${length}px`, height: '0px', transform: `rotate(${Math.atan2(y2 - y1, x2 - x1)}rad)` });
    } else {
      Object.assign(this.#band.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px`, transform: 'none' });
    }
  }

  #pointerUp(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#drag = null;
    this.#catcher.releasePointerCapture?.(event.pointerId);
    const start = this.#percent({ clientX: drag.x, clientY: drag.y });
    this.finish(drag.moved ? { a: start, b: this.#percent(event) } : { a: start, b: null });
  }

  /** Ends draw mode: with `placed`, the shape is added (one transaction, sent to VS Code at once); null cancels. */
  finish(placed: { a: { x: number; y: number }; b: { x: number; y: number } | null } | null): void {
    if (this.#done) return;
    this.#done = true;
    this.#doc.removeEventListener('pointerdown', this.#onOutside, true);
    this.#doc.removeEventListener('keydown', this.#onKey, true);
    this.#doc.removeEventListener('scroll', this.#onScroll, true);
    this.#doc.defaultView?.removeEventListener('resize', this.#onScroll);
    this.#layer.remove();
    this.onEnd();
    const view = this.#view;
    let added = false;
    if (placed) {
      const state = view.state;
      const target = pictureTarget(state);
      if (target && target.pos === this.pos) {
        const tr = addShapeTransaction(state, this.#list, (entry) => drawnEntry(this.#list, entry, placed.a, placed.b));
        if (tr) {
          view.dispatch(tr);
          view.dom.dispatchEvent(new CustomEvent(FLUSH_EVENT, { bubbles: true }));
          added = true;
        }
      }
    }
    // A placed shape is selected for editing with the focus on the picture's overlay (the node view took it): Esc then ends editing.
    if (!added) view.focus();
  }
}

/**
 * Draw mode on the canvas (added by the app with the other pmPlugins): a `requestDraw` transaction starts it on that picture; a change of
 * the document or of the selection while it is on cancels it (the picture it measured may be gone).
 */
export function drawModePlugin(): Plugin<DrawRequest | null> {
  let active: DrawMode | null = null;
  let handled = 0;
  return new Plugin<DrawRequest | null>({
    key: drawModeKey,
    state: {
      init: () => null,
      apply: (tr, value) => (tr.getMeta(drawModeKey) as DrawRequest | undefined) ?? value,
    },
    view: () => ({
      update(view, previous: EditorState) {
        const request = drawModeKey.getState(view.state);
        if (active && (view.state.doc !== previous.doc || !(view.state.selection instanceof NodeSelection) || view.state.selection.from !== active.pos)) active.finish(null);
        if (!request || request.seq === handled) return;
        handled = request.seq;
        active?.finish(null);
        const target = pictureTarget(view.state);
        const dom = target && target.pos === request.pos && view.editable ? view.nodeDOM(request.pos) : null;
        const measured = dom instanceof Element && target ? measure(dom, target) : null;
        if (!target || !(dom instanceof Element) || !measured || measured.full.w <= 0) return;
        const anchor = measured.win.w > 0 ? (dom.querySelector('.image-frame')?.parentElement ?? measured.picture.closest('.image-turn') ?? measured.picture) : dom;
        const mode = new DrawMode(view, request, measured.full, measured.win, anchor, () => {
          if (active === mode) active = null;
        });
        active = mode;
      },
      destroy() {
        active?.finish(null);
      },
    }),
  });
}

/** Is draw mode on now (tests, the app's announcements)? */
export const drawModeOn = (doc: Document): boolean => doc.querySelector('.pmd-draw-mode') !== null;

/** Draw mode's look (editor UI: VS Code's colors). */
export const DRAW_MODE_CSS = `
.pmd-draw-mode { position: fixed; inset: 0; z-index: 60; pointer-events: none; outline: none; }
.pmd-draw-mode .pmd-draw-catcher { position: fixed; pointer-events: auto; touch-action: none; cursor: crosshair; box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.pmd-draw-mode .pmd-draw-band { position: fixed; box-sizing: border-box; border: 1px dashed var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent); pointer-events: none; transform-origin: 0 0; }
.pmd-draw-mode .pmd-draw-band-line { border: 0; border-top: 2px solid var(--vscode-focusBorder); background: none; }
.pmd-draw-mode .pmd-draw-status { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
