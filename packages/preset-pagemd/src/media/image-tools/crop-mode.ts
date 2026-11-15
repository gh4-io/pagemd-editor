// Crop mode (P27 amendment 2, R-249, R-252; ADR-0019): Word's crop on the canvas. Image ▸ Crop shows the whole picture with the
// part outside the crop dimmed, handles on the crop window's edges and corners; dragging a handle moves that edge, dragging the
// picture shifts it under the window (Word's "move the picture inside the crop"), Enter or a click away keeps the crop, Escape
// cancels. The result is written as `crop-x`/`crop-y`/`pos-x`/`pos-y` in % (cropTransaction: ONE transaction, one undo step, no
// file written); a plain picture becomes a FIGURE inside that step.
//
// The layer is drawn over the page in the webview's own coordinates (position: fixed, from the picture's screen box), so it works
// the same for every form of picture (an inline `![]()`, a FIGURE, an annotated image) and at any zoom, without touching the
// document's DOM. It follows the picture when the page scrolls. Keyboard: the arrow keys shift the picture (Shift: 10 px),
// Alt + the arrow keys move the window's right or bottom edge, Enter keeps, Escape cancels.
import { NodeSelection, Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { cropRectOf, readFlip, readRotate, round2, type Flip, type Rect, type Turn } from './geometry.ts';
import { cropTransaction, pictureTarget, sourceOf, type PictureTarget } from './target.ts';
import { FLUSH_EVENT } from './annotation-view.ts';

interface CropRequest {
  seq: number;
  pos: number;
}

export const cropModeKey = new PluginKey<CropRequest | null>('pmd-crop-mode');

let seq = 0;

/** `tr` plus a request to start crop mode on the picture at `pos` (in `tr.doc`). */
export function requestCrop(tr: Transaction, pos: number): Transaction {
  return tr.setMeta(cropModeKey, { seq: ++seq, pos } satisfies CropRequest);
}

/** A box on the screen, in CSS px of the webview (not of the zoomed page). */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The smallest crop window, in % of the picture (a handle never folds it away). */
const MIN_PERCENT = 1;

const data = (node: { attrs: Record<string, unknown> }): Record<string, unknown> => (node.attrs['data'] as Record<string, unknown> | undefined) ?? {};

/** The picture keys (rotate, flip, crop) of the target as written. */
function keysOf(target: PictureTarget): Record<string, unknown> {
  if (target.kind === 'figure') return (data(target.node)['attrs'] as Record<string, unknown> | undefined) ?? {};
  if (target.kind === 'annotated') return ((data(target.node)['data'] as Record<string, unknown> | undefined)?.['options'] as Record<string, unknown> | undefined) ?? {};
  return {};
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/**
 * Where the whole picture (as shown: turned and flipped) and the crop window are on the screen now. pagemd draws a crop in a
 * CSS length, and every crop on an annotated image or a turned picture, as a window (`.image-window`) around a frame the size of
 * the whole picture (`.image-frame`, C13): both are measured. A FIGURE's % crop is drawn with `object-view-box` (the `<img>` is the
 * window): the whole picture is worked out from the % keys. No crop: the picture is both.
 */
export function measure(dom: Element, target: PictureTarget): { full: Box; win: Box; picture: HTMLImageElement } | null {
  const picture = dom instanceof HTMLImageElement ? dom : dom.querySelector<HTMLImageElement>('img');
  if (!picture) return null;
  const frame = dom.querySelector('.image-frame');
  const win = frame?.parentElement;
  if (frame && win) return { full: boxOf(frame), win: boxOf(win), picture };
  const shown = picture.closest('.image-turn') ?? picture;
  const box = boxOf(shown);
  const rect = cropRectOf(keysOf(target));
  if (!rect || rect === 'unknown') return { full: box, win: box, picture };
  const w = (box.w * 100) / Math.max(rect.width, MIN_PERCENT);
  const h = (box.h * 100) / Math.max(rect.height, MIN_PERCENT);
  return { full: { x: box.x - (rect.x / 100) * w, y: box.y - (rect.y / 100) * h, w, h }, win: box, picture };
}

/** The crop that shows `win` of the whole picture `full`, in % of the picture (what cropTransaction writes). */
export function cropRect(full: Box, win: Box): Rect {
  return {
    x: round2(((win.x - full.x) / full.w) * 100),
    y: round2(((win.y - full.y) / full.h) * 100),
    width: round2((win.w / full.w) * 100),
    height: round2((win.h / full.h) * 100),
  };
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: readonly Edge[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const EDGE_NAME: Readonly<Record<Edge, string>> = {
  n: 'Top edge',
  s: 'Bottom edge',
  e: 'Right edge',
  w: 'Left edge',
  ne: 'Top-right corner',
  nw: 'Top-left corner',
  se: 'Bottom-right corner',
  sw: 'Bottom-left corner',
};

/** The window with `edge` dragged by (dx, dy) screen px, kept inside the whole picture and at least MIN_PERCENT of it. */
export function dragEdge(full: Box, win: Box, edge: Edge, dx: number, dy: number): Box {
  const minW = (full.w * MIN_PERCENT) / 100;
  const minH = (full.h * MIN_PERCENT) / 100;
  let left = win.x;
  let top = win.y;
  let right = win.x + win.w;
  let bottom = win.y + win.h;
  if (edge.includes('w')) left = Math.min(Math.max(left + dx, full.x), right - minW);
  if (edge.includes('e')) right = Math.max(Math.min(right + dx, full.x + full.w), left + minW);
  if (edge.includes('n')) top = Math.min(Math.max(top + dy, full.y), bottom - minH);
  if (edge.includes('s')) bottom = Math.max(Math.min(bottom + dy, full.y + full.h), top + minH);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The whole picture moved by (dx, dy) under the window, never so far that the window shows past its edge. */
export function shiftPicture(full: Box, win: Box, dx: number, dy: number): Box {
  return {
    ...full,
    x: Math.min(Math.max(full.x + dx, win.x + win.w - full.w), win.x),
    y: Math.min(Math.max(full.y + dy, win.y + win.h - full.h), win.y),
  };
}

/** The `transform` that turns and flips the picture as pagemd does (C13 `pictureTransform`: the turn first, then the flip). */
function transformOf(rotate: Turn, flip: Flip): string {
  const parts: string[] = [];
  if (flip === 'h') parts.push('scaleX(-1)');
  else if (flip === 'v') parts.push('scaleY(-1)');
  else if (flip === 'hv') parts.push('scale(-1, -1)');
  if (rotate) parts.push(`rotate(${rotate}deg)`);
  return parts.join(' ');
}

/** One crop mode session on the screen. */
class CropMode {
  readonly #view: EditorView;
  readonly #pos: number;
  readonly #doc: Document;
  readonly #layer: HTMLElement;
  readonly #dim: HTMLElement;
  readonly #window: HTMLElement;
  readonly #bright: HTMLElement;
  readonly #status: HTMLElement;
  readonly #anchor: Element;
  readonly #src: string;
  readonly #rotate: Turn;
  readonly #flip: Flip;
  /** The anchor's box when the boxes below were taken (the page may scroll or zoom meanwhile). */
  #at: Box;
  #full: Box;
  #win: Box;
  #drag: { pointerId: number; edge: Edge | null; x: number; y: number; full: Box; win: Box } | null = null;
  #done = false;
  readonly #onOutside = (event: PointerEvent): void => {
    if (event.target instanceof Node && this.#layer.contains(event.target)) return;
    this.finish(true); // Word: a click away keeps the crop
  };
  readonly #onScroll = (): void => this.#follow();
  readonly onEnd: () => void;

  constructor(view: EditorView, pos: number, target: PictureTarget, measured: { full: Box; win: Box; picture: HTMLImageElement }, anchor: Element, onEnd: () => void) {
    this.#view = view;
    this.#pos = pos;
    this.onEnd = onEnd;
    this.#doc = view.dom.ownerDocument;
    this.#anchor = anchor;
    this.#at = boxOf(anchor);
    this.#full = measured.full;
    this.#win = measured.win;
    this.#src = measured.picture.currentSrc || measured.picture.src;
    const keys = keysOf(target);
    this.#rotate = readRotate(keys['rotate']);
    this.#flip = readFlip(keys['flip']);
    const d = this.#doc;
    this.#layer = d.createElement('div');
    this.#layer.className = 'pmd-crop-mode';
    this.#layer.tabIndex = 0;
    this.#layer.setAttribute('role', 'application');
    this.#layer.setAttribute('aria-roledescription', 'crop');
    this.#layer.setAttribute(
      'aria-label',
      'Crop the picture. Drag an edge or a corner to crop; drag the picture to move it under the crop. Arrow keys move the picture (Shift: 10 pixels), Alt and the arrow keys move the right or bottom edge, Enter keeps the crop, Escape cancels.',
    );
    this.#dim = d.createElement('div');
    this.#dim.className = 'pmd-crop-full';
    this.#window = d.createElement('div');
    this.#window.className = 'pmd-crop-window';
    this.#bright = d.createElement('div');
    this.#bright.className = 'pmd-crop-full pmd-crop-bright';
    const clip = d.createElement('div');
    clip.className = 'pmd-crop-bright-clip';
    clip.append(this.#bright);
    this.#window.append(clip);
    for (const edge of EDGES) {
      const handle = d.createElement('div');
      handle.className = `pmd-crop-handle pmd-crop-${edge}`;
      handle.dataset['edge'] = edge;
      handle.setAttribute('aria-hidden', 'true');
      handle.title = EDGE_NAME[edge];
      this.#window.append(handle);
    }
    this.#status = d.createElement('div');
    this.#status.className = 'pmd-crop-status';
    this.#status.setAttribute('role', 'status');
    this.#layer.append(this.#dim, this.#window, this.#status);
    for (const box of [this.#dim, this.#bright]) box.append(this.#picture());
    d.body.append(this.#layer);
    this.#layer.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    this.#layer.addEventListener('pointermove', (e) => this.#pointerMove(e));
    this.#layer.addEventListener('pointerup', (e) => this.#pointerUp(e));
    this.#layer.addEventListener('pointercancel', (e) => this.#pointerUp(e));
    this.#layer.addEventListener('keydown', (e) => this.#keyDown(e));
    d.addEventListener('pointerdown', this.#onOutside, true);
    d.addEventListener('scroll', this.#onScroll, true);
    d.defaultView?.addEventListener('resize', this.#onScroll);
    this.#draw();
    this.#layer.focus({ preventScroll: true });
    // The command that started crop mode may give the page its focus back when it ends: take it again once that is done.
    const win = d.defaultView;
    win?.setTimeout(() => {
      if (!this.#done) this.#layer.focus({ preventScroll: true });
    }, 0);
    this.#say('Crop mode. Drag the handles or use Alt and the arrow keys; Enter keeps the crop, Escape cancels.');
  }

  get pos(): number {
    return this.#pos;
  }

  /** The picture as shown (turned and flipped), filling its box: drawn twice, dimmed (the whole) and bright (in the window). */
  #picture(): HTMLElement {
    const img = this.#doc.createElement('img');
    img.src = this.#src;
    img.alt = '';
    img.draggable = false;
    img.className = 'pmd-crop-img';
    img.style.transform = transformOf(this.#rotate, this.#flip);
    return img;
  }

  #placeImages(): void {
    const turned = this.#rotate === 90 || this.#rotate === 270;
    const { w, h } = this.#full;
    for (const img of this.#layer.querySelectorAll<HTMLImageElement>('.pmd-crop-img')) {
      // A quarter turn: the file is drawn with its own shape (the shown box's sides swapped), centred, then turned.
      Object.assign(img.style, turned ? { width: `${h}px`, height: `${w}px`, left: `${(w - h) / 2}px`, top: `${(h - w) / 2}px` } : { width: `${w}px`, height: `${h}px`, left: '0px', top: '0px' });
    }
  }

  #draw(): void {
    const { full, win } = { full: this.#full, win: this.#win };
    Object.assign(this.#dim.style, { left: `${full.x}px`, top: `${full.y}px`, width: `${full.w}px`, height: `${full.h}px` });
    Object.assign(this.#window.style, { left: `${win.x}px`, top: `${win.y}px`, width: `${win.w}px`, height: `${win.h}px` });
    Object.assign(this.#bright.style, { left: `${full.x - win.x}px`, top: `${full.y - win.y}px`, width: `${full.w}px`, height: `${full.h}px` });
    this.#placeImages();
  }

  /** The page scrolled or the window changed size: the picture is somewhere else on the screen; everything follows it. */
  #follow(): void {
    if (this.#done) return;
    if (!this.#anchor.isConnected) return this.finish(false);
    const now = boxOf(this.#anchor);
    const scale = this.#at.w > 0 ? now.w / this.#at.w : 1;
    const move = (b: Box): Box => ({ x: now.x + (b.x - this.#at.x) * scale, y: now.y + (b.y - this.#at.y) * scale, w: b.w * scale, h: b.h * scale });
    this.#full = move(this.#full);
    this.#win = move(this.#win);
    this.#at = now;
    this.#draw();
  }

  #rect(): Rect {
    return cropRect(this.#full, this.#win);
  }

  #say(text: string): void {
    this.#status.textContent = text;
  }

  #describe(): void {
    const r = this.#rect();
    this.#say(`Showing ${round2(r.width)} % by ${round2(r.height)} % of the picture, from ${round2(r.x)} % left and ${round2(r.y)} % top.`);
  }

  // ── the pointer ──

  #pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.#layer.focus({ preventScroll: true });
    const handle = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-edge]') : null;
    const onPicture = event.target instanceof Element && !!event.target.closest('.pmd-crop-full, .pmd-crop-window');
    if (!handle && !onPicture) return this.finish(true); // the empty layer around: a click away keeps
    this.#drag = { pointerId: event.pointerId, edge: (handle?.dataset['edge'] as Edge | undefined) ?? null, x: event.clientX, y: event.clientY, full: this.#full, win: this.#win };
    this.#layer.setPointerCapture?.(event.pointerId);
  }

  #pointerMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.edge) this.#win = dragEdge(drag.full, drag.win, drag.edge, dx, dy);
    else this.#full = shiftPicture(drag.full, drag.win, dx, dy);
    this.#draw();
  }

  #pointerUp(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#drag = null;
    this.#layer.releasePointerCapture?.(event.pointerId);
    this.#describe();
  }

  // ── the keyboard ──

  #keyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      return this.finish(false);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      return this.finish(true);
    }
    const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    const dy = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!dx && !dy) {
      if (event.key === 'Tab') event.preventDefault(); // the focus stays in crop mode until Enter or Escape
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    if (event.altKey) this.#win = dragEdge(this.#full, this.#win, dx ? 'e' : 's', dx * step, dy * step);
    else this.#full = shiftPicture(this.#full, this.#win, dx * step, dy * step);
    this.#draw();
    this.#describe();
  }

  /** Ends crop mode: `keep` writes the crop (one transaction, sent to VS Code at once), else nothing changes. */
  finish(keep: boolean): void {
    if (this.#done) return;
    this.#done = true;
    const rect = this.#rect();
    this.#doc.removeEventListener('pointerdown', this.#onOutside, true);
    this.#doc.removeEventListener('scroll', this.#onScroll, true);
    this.#doc.defaultView?.removeEventListener('resize', this.#onScroll);
    this.#layer.remove();
    this.onEnd();
    const view = this.#view;
    if (keep) {
      const state = view.state;
      const target = pictureTarget(state);
      if (target && target.pos === this.#pos) {
        const change = cropTransaction(state, target, rect);
        if (change) {
          view.dispatch(change.tr);
          view.dom.dispatchEvent(new CustomEvent(FLUSH_EVENT, { bubbles: true }));
        }
      }
    }
    view.focus();
  }
}

/** Is a picture of this target's kind drawn (and measurable) at `pos`? Returns the element to measure. */
function pictureDom(view: EditorView, pos: number): Element | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof Element ? dom : null;
}

/**
 * Crop mode on the canvas (added by the app with the other pmPlugins): a `requestCrop` transaction starts it on that picture; a
 * change of the document or of the selection while it is on cancels it (the picture it measured may be gone).
 */
export function cropModePlugin(): Plugin<CropRequest | null> {
  let active: CropMode | null = null;
  let handled = 0;
  return new Plugin<CropRequest | null>({
    key: cropModeKey,
    state: {
      init: () => null,
      apply: (tr, value) => (tr.getMeta(cropModeKey) as CropRequest | undefined) ?? value,
    },
    view: () => ({
      update(view, previous: EditorState) {
        const request = cropModeKey.getState(view.state);
        if (active && (view.state.doc !== previous.doc || !(view.state.selection instanceof NodeSelection) || view.state.selection.from !== active.pos)) active.finish(false);
        if (!request || request.seq === handled) return;
        handled = request.seq;
        active?.finish(false);
        const target = pictureTarget(view.state);
        const dom = target && target.pos === request.pos && view.editable ? pictureDom(view, request.pos) : null;
        const measured = dom && target ? measure(dom, target) : null;
        if (!target || !dom || !measured || !sourceOf(target.node) || measured.full.w <= 0) return;
        const anchor = measured.win.w > 0 ? (dom.querySelector('.image-frame')?.parentElement ?? measured.picture.closest('.image-turn') ?? measured.picture) : dom;
        const mode = new CropMode(view, request.pos, target, measured, anchor, () => {
          if (active === mode) active = null;
        });
        active = mode;
      },
      destroy() {
        active?.finish(false);
      },
    }),
  });
}

/** Is crop mode on now (tests, the app's announcements)? */
export const cropModeOn = (doc: Document): boolean => doc.querySelector('.pmd-crop-mode') !== null;

/** Crop mode's look (editor UI: VS Code's colors). */
export const CROP_MODE_CSS = `
.pmd-crop-mode { position: fixed; inset: 0; z-index: 60; pointer-events: none; outline: none; }
.pmd-crop-mode .pmd-crop-full, .pmd-crop-mode .pmd-crop-window { position: fixed; pointer-events: auto; touch-action: none; }
.pmd-crop-mode .pmd-crop-full { overflow: hidden; cursor: move; }
.pmd-crop-mode > .pmd-crop-full { opacity: 0.45; filter: grayscale(0.3); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.pmd-crop-mode .pmd-crop-window { overflow: visible; box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 0 0 2px var(--vscode-editor-background); }
.pmd-crop-mode .pmd-crop-bright-clip > .pmd-crop-full { position: absolute; }
.pmd-crop-mode .pmd-crop-bright-clip { position: absolute; inset: 0; overflow: hidden; }
.pmd-crop-mode .pmd-crop-img { position: absolute; max-width: none; max-height: none; margin: 0; user-select: none; pointer-events: none; }
.pmd-crop-mode .pmd-crop-handle { position: absolute; width: 12px; height: 12px; box-sizing: border-box; background: var(--vscode-editor-background); border: 2px solid var(--vscode-focusBorder); transform: translate(-50%, -50%); }
.pmd-crop-mode .pmd-crop-n, .pmd-crop-mode .pmd-crop-s { left: 50%; width: 18px; height: 6px; cursor: ns-resize; }
.pmd-crop-mode .pmd-crop-e, .pmd-crop-mode .pmd-crop-w { top: 50%; width: 6px; height: 18px; cursor: ew-resize; }
.pmd-crop-mode .pmd-crop-n, .pmd-crop-mode .pmd-crop-nw, .pmd-crop-mode .pmd-crop-ne { top: 0; }
.pmd-crop-mode .pmd-crop-s, .pmd-crop-mode .pmd-crop-sw, .pmd-crop-mode .pmd-crop-se { top: 100%; }
.pmd-crop-mode .pmd-crop-w, .pmd-crop-mode .pmd-crop-nw, .pmd-crop-mode .pmd-crop-sw { left: 0; }
.pmd-crop-mode .pmd-crop-e, .pmd-crop-mode .pmd-crop-ne, .pmd-crop-mode .pmd-crop-se { left: 100%; }
.pmd-crop-mode .pmd-crop-nw, .pmd-crop-mode .pmd-crop-se { cursor: nwse-resize; }
.pmd-crop-mode .pmd-crop-ne, .pmd-crop-mode .pmd-crop-sw { cursor: nesw-resize; }
.pmd-crop-mode .pmd-crop-status { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
