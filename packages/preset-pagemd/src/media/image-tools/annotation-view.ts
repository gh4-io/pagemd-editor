// The annotated image on the canvas (P15, ADR-0018 decision 1, D3, D11, D12, D26): pagemd's own drawing (the renderer
// rule @pagemd/syntax registers, I3), and, while its shapes are being edited, an overlay of its own on top of the picture
// (pagemd's layers take no pointer events). The overlay finds shapes, shows the selected one's handles and turns a drag,
// a nudge or a Delete into ONE change of the node's data, sent to VS Code at once (one undo step, R-94); the item's write
// rule then rewrites only that entry's YAML (C3).
//
// Editing starts with a double-click on the picture, Enter on the selected picture, or a command (a new shape, the
// Inspector's row). In it: click or Tab selects a shape, drag moves it or a handle, the arrow keys nudge it by one screen
// pixel (Shift: 10), Delete removes it, Esc ends editing. It ends too when the picture is no longer selected.
import type { Node } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import { shapesHiddenByCrop } from '@pagemd/syntax';
import type { Decoration, EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import {
  boundsOf,
  dragHandle,
  entryOf,
  fieldOf,
  HANDLE_NAME,
  HANDLES,
  handlePoint,
  isPlaced,
  KIND_OF,
  listOf,
  moveEntry,
  placedShapes,
  round2,
  shapeLabel,
  tabOrder,
  withEntry,
  withoutEntry,
  type AnnotationData,
  type Entry,
  type Handle,
  type Point,
  type ShapeRef,
} from './geometry.ts';
import { SHAPE_REQUEST, type ShapeRequest } from './plugin.ts';
import { pictureEnv } from '../picture-sizes.ts';

/** What an annotated image's node carries (C2): the path, the YAML as written, and its value. */
export interface AnnotatedValue {
  imagePath: string;
  content?: string;
  data?: AnnotationData;
}

/** Sent (bubbling) when the selected shape changes: `detail.field` is the Inspector's path ("markers.2"), or null. */
export const SHAPE_SELECT_EVENT = 'pmd-shape-select';
/** Sent (bubbling) after a change was made: the app sends the document's edits to VS Code at once (one undo step). */
export const FLUSH_EVENT = 'pmd-flush';
/** Sent (bubbling) when a new shape was added to this picture (FIX-S50, issue 3): the app opens the Inspector on it. */
export const SHAPE_ADDED_EVENT = 'pmd-shape-added';

const SVG = 'http://www.w3.org/2000/svg';
let instances = 0;

const sameRef = (a: ShapeRef | null, b: ShapeRef | null): boolean => !!a && !!b && a.list === b.list && a.index === b.index;

interface Drag {
  pointerId: number;
  ref: ShapeRef;
  handle: Handle | null;
  start: Point;
  entry: Entry;
  moved: boolean;
}

class AnnotatedImageView implements NodeView {
  readonly dom: HTMLElement;
  readonly #content: HTMLElement;
  readonly #overlay: HTMLElement;
  readonly #status: HTMLElement;
  /** P27 amendment 4: "2 shapes hidden by the crop" (editor UI, not part of pagemd's drawing). */
  readonly #hidden: HTMLElement;
  readonly #env: Record<string, unknown>;
  readonly #view: EditorView;
  readonly #getPos: () => number | undefined;
  readonly #html: (value: AnnotatedValue, yamlError: unknown, env: Record<string, unknown>) => string;
  readonly #id = ++instances;
  readonly #resize: ResizeObserver | undefined;
  #node: Node;
  #editing = false;
  #selected: ShapeRef | null = null;
  /** The data shown while a drag or a nudge is under way (not yet in the document). */
  #preview: AnnotationData | null = null;
  #drag: Drag | null = null;
  #nudged = false;
  #lastRequest = 0;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[], html: (value: AnnotatedValue, yamlError: unknown, env: Record<string, unknown>) => string) {
    this.#node = node;
    this.#view = view;
    this.#getPos = getPos;
    this.#html = html;
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = 'pmd-media pmd-annotated-image';
    this.dom.contentEditable = 'false';
    this.#content = doc.createElement('div');
    this.#content.className = 'pmd-annotated-drawing';
    this.#overlay = doc.createElement('div');
    this.#overlay.className = 'pmd-shape-overlay';
    this.#overlay.hidden = true;
    this.#overlay.tabIndex = 0;
    this.#overlay.setAttribute('role', 'application');
    this.#overlay.setAttribute('aria-roledescription', 'picture annotations');
    this.#overlay.setAttribute('aria-label', 'Shapes on the picture. Tab moves between shapes, the arrow keys nudge the selected one (Shift: 10 pixels), Delete removes it, Escape ends editing.');
    this.#status = doc.createElement('div');
    this.#status.className = 'pmd-shape-status';
    this.#status.setAttribute('role', 'status');
    this.#hidden = doc.createElement('div');
    this.#hidden.className = 'pmd-hidden-shapes';
    this.#hidden.setAttribute('role', 'note');
    this.#hidden.hidden = true;
    // P27: a picture turned a quarter needs its size; the browser gives it once the picture has loaded, then it is drawn again.
    this.#env = pictureEnv(doc, () => this.#draw());
    this.dom.append(this.#content, this.#overlay, this.#status, this.#hidden);

    this.#overlay.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    this.#overlay.addEventListener('pointermove', (e) => this.#pointerMove(e));
    this.#overlay.addEventListener('pointerup', (e) => this.#pointerUp(e));
    this.#overlay.addEventListener('pointercancel', (e) => this.#pointerUp(e, true));
    this.#overlay.addEventListener('keydown', (e) => this.#keyDown(e));
    this.#overlay.addEventListener('keyup', (e) => this.#keyUp(e));
    this.dom.addEventListener('dblclick', (e) => this.#doubleClick(e));
    // The picture loads after it is drawn, and the page can be zoomed: the overlay follows the picture's box.
    this.#content.addEventListener('load', () => this.#layout(), true);
    const RO = doc.defaultView?.ResizeObserver;
    if (RO) {
      this.#resize = new RO(() => this.#layout());
      this.#resize.observe(this.#content);
    }
    this.#draw();
    this.#request(decorations);
  }

  // ── ProseMirror's side ──

  update(node: Node, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.#node.type) return false;
    const changed = node.attrs !== this.#node.attrs && JSON.stringify(node.attrs) !== JSON.stringify(this.#node.attrs);
    this.#node = node;
    if (changed) {
      this.#preview = null;
      if (this.#selected && !isPlaced(entryOf(this.#data(), this.#selected), KIND_OF[this.#selected.list])) this.#selected = null;
      this.#draw();
    }
    this.#request(decorations);
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
    // A change made here re-selects the picture in the same transaction; only a real move away ends editing.
    queueMicrotask(() => {
      if (this.#editing && !this.#isSelected()) this.#leave(false);
    });
  }

  /** Events inside the overlay are the overlay's own: ProseMirror must not start a selection or a drag of the figure. */
  stopEvent(event: Event): boolean {
    return this.#editing && event.target instanceof globalThis.Node && this.#overlay.contains(event.target);
  }

  /** The drawing and the overlay are made here; only selection changes are ProseMirror's (as for any view without editable content). */
  ignoreMutation(mutation: { type: string }): boolean {
    return mutation.type !== 'selection';
  }

  destroy(): void {
    this.#resize?.disconnect();
  }

  // ── data ──

  #value(): AnnotatedValue {
    return this.#node.attrs['data'] as AnnotatedValue;
  }

  #data(): AnnotationData {
    return this.#preview ?? this.#value().data ?? {};
  }

  #editable(): boolean {
    return this.#view.editable && !this.#node.attrs['yamlError'];
  }

  #isSelected(): boolean {
    const sel = this.#view.state.selection;
    return sel instanceof NodeSelection && sel.from === this.#getPos();
  }

  /** The node's data with `next` as its annotations: one transaction, the picture stays selected, sent at once. */
  #commit(next: AnnotationData): void {
    const pos = this.#getPos();
    this.#preview = null;
    if (pos === undefined) return;
    const value = this.#value();
    const tr = this.#view.state.tr.setNodeMarkup(pos, undefined, { ...this.#node.attrs, data: { ...value, data: next } });
    tr.setSelection(NodeSelection.create(tr.doc, pos));
    this.#view.dispatch(tr);
    this.dom.dispatchEvent(new CustomEvent(FLUSH_EVENT, { bubbles: true }));
  }

  // ── drawing ──

  #draw(): void {
    const value = this.#value();
    this.#content.innerHTML = this.#html(this.#preview ? { ...value, data: this.#preview } : value, this.#node.attrs['yamlError'], this.#env);
    // The number in "Figure N" is the canvas's counter (media.ts), not the one this block alone would get.
    for (const n of this.#content.querySelectorAll('.fig-num')) n.textContent = '';
    // Shapes a crop hides stay in the YAML, hidden by the window (R-249): said under the picture (P27 amendment 4).
    const hidden = this.#node.attrs['yamlError'] ? 0 : hiddenShapes(this.#data()).length;
    this.#hidden.hidden = hidden === 0;
    this.#hidden.textContent = hidden === 0 ? '' : `${hidden} shape${hidden === 1 ? '' : 's'} hidden by the crop`;
    this.#layout();
  }

  /**
   * The box of the frame pagemd places the badges and shapes in, inside `dom` (FIX-ADT; not the `<img>`), in CSS pixels before any
   * zoom (offsets, not screen rectangles): `.image-frame` when the picture is cropped (C13: the whole picture, shifted under the
   * window), else `.image-wrapper`.
   */
  #pictureBox(): { left: number; top: number; width: number; height: number } | null {
    const frame = this.#content.querySelector<HTMLElement>('.image-frame') ?? this.#content.querySelector<HTMLElement>('.image-wrapper');
    if (!frame || frame.offsetWidth === 0) return null;
    // FIX-S50 (AD-FIX-S50-06): measured on the screen, not by offsetLeft: pagemd moves a cropped picture's frame with `transform:
    // translate(pos-x, pos-y)`, which offsetLeft ignores, so the editing rings stayed where the uncropped picture was (the drift under a crop).
    // A zoom or a scale on the page is divided out by comparing the frame's screen size with its layout size.
    const fr = frame.getBoundingClientRect();
    const dr = this.dom.getBoundingClientRect();
    const kx = fr.width > 0 ? frame.offsetWidth / fr.width : 1;
    const ky = fr.height > 0 ? frame.offsetHeight / fr.height : 1;
    const left = (fr.left - dr.left) * kx;
    const top = (fr.top - dr.top) * ky;
    return { left, top, width: frame.offsetWidth, height: frame.offsetHeight };
  }

  #layout(): void {
    const box = this.#editing ? this.#pictureBox() : null;
    this.#overlay.hidden = !box;
    this.dom.classList.toggle('pmd-shape-editing', this.#editing);
    if (!box) return;
    Object.assign(this.#overlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    this.#drawOverlay();
  }

  #shapeId(ref: ShapeRef): string {
    return `pmd-shape-${this.#id}-${ref.list}-${ref.index}`;
  }

  #drawOverlay(): void {
    const doc = this.dom.ownerDocument;
    const data = this.#data();
    const svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'pmd-shape-hits');
    const html: HTMLElement[] = [];
    const label = (el: Element, ref: ShapeRef): void => {
      el.id = this.#shapeId(ref);
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', shapeLabel(ref, entryOf(data, ref)));
      el.setAttribute('aria-pressed', String(sameRef(ref, this.#selected)));
      el.setAttribute('data-list', ref.list);
      el.setAttribute('data-index', String(ref.index));
    };
    // Text notes are drawn by pagemd at a fixed size (OQ-27): their boxes are measured from its drawing when it drew them all.
    const textSpans = [...this.#content.querySelectorAll<HTMLElement>('.annotation-text')];
    const drawnTexts = listOf(data, 'text').map((e, i) => (isPlaced(e, 'point') && typeof e['text'] === 'string' ? i : -1)).filter((i) => i >= 0);
    const overlayBox = { width: this.#overlay.offsetWidth || 1, height: this.#overlay.offsetHeight || 1 };

    for (const ref of placedShapes(data)) {
      const entry = entryOf(data, ref)!;
      const kind = KIND_OF[ref.list];
      if (kind === 'segment') {
        const line = doc.createElementNS(SVG, 'line');
        for (const k of ['x1', 'y1', 'x2', 'y2']) line.setAttribute(k, String(entry[k]));
        line.setAttribute('class', 'pmd-shape-hit pmd-shape-hit-stroke');
        label(line, ref);
        svg.append(line);
      } else if (kind === 'rect') {
        const b = boundsOf(entry, kind);
        const filled = ref.list === 'highlights' || (typeof entry['fill'] === 'string' && entry['fill'] !== 'none' && entry['fill'] !== '');
        const shape = doc.createElementNS(SVG, ref.list === 'ellipses' ? 'ellipse' : 'rect');
        if (ref.list === 'ellipses') {
          shape.setAttribute('cx', String(b.x + b.width / 2));
          shape.setAttribute('cy', String(b.y + b.height / 2));
          shape.setAttribute('rx', String(b.width / 2));
          shape.setAttribute('ry', String(b.height / 2));
        } else {
          for (const [k, v] of Object.entries({ x: b.x, y: b.y, width: b.width, height: b.height })) shape.setAttribute(k, String(v));
        }
        shape.setAttribute('class', `pmd-shape-hit ${filled ? 'pmd-shape-hit-fill' : 'pmd-shape-hit-stroke'}`);
        label(shape, ref);
        svg.append(shape);
      } else {
        const el = doc.createElement('div');
        el.className = `pmd-shape-hit pmd-shape-hit-${ref.list === 'markers' ? 'marker' : 'text'}`;
        el.style.left = `${entry['x']}%`;
        el.style.top = `${entry['y']}%`;
        if (ref.list === 'text') {
          const span = textSpans.length === drawnTexts.length ? textSpans[drawnTexts.indexOf(ref.index)] : undefined;
          el.style.width = span ? `${(span.offsetWidth / overlayBox.width) * 100}%` : '6em';
          el.style.height = span ? `${(span.offsetHeight / overlayBox.height) * 100}%` : '1.5em';
        }
        label(el, ref);
        html.push(el);
      }
    }

    // The selected shape: its outline and handles.
    const handles: HTMLElement[] = [];
    const selected = this.#selected;
    const entry = selected ? entryOf(data, selected) : undefined;
    if (selected && entry && isPlaced(entry, KIND_OF[selected.list])) {
      const kind = KIND_OF[selected.list];
      const outline = doc.createElementNS(SVG, kind === 'segment' ? 'line' : 'rect');
      if (kind === 'segment') {
        for (const k of ['x1', 'y1', 'x2', 'y2']) outline.setAttribute(k, String(entry[k]));
      } else if (kind === 'rect') {
        const b = boundsOf(entry, kind);
        for (const [k, v] of Object.entries({ x: b.x, y: b.y, width: b.width, height: b.height })) outline.setAttribute(k, String(v));
      }
      if (kind !== 'point') {
        outline.setAttribute('class', 'pmd-shape-outline');
        svg.append(outline);
      } else {
        html.find((el) => el.id === this.#shapeId(selected))?.classList.add('pmd-shape-selected');
      }
      const name = shapeLabel(selected, entry);
      for (const handle of HANDLES[kind]) {
        const p = handlePoint(entry, kind, handle);
        const el = doc.createElement('div');
        el.className = 'pmd-shape-handle';
        el.dataset['handle'] = handle;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `${HANDLE_NAME[handle]} of ${name}`);
        el.style.left = `${p.x}%`;
        el.style.top = `${p.y}%`;
        handles.push(el);
      }
    }
    this.#overlay.replaceChildren(svg, ...html, ...handles);
    if (selected && entry) this.#overlay.setAttribute('aria-activedescendant', this.#shapeId(selected));
    else this.#overlay.removeAttribute('aria-activedescendant');
  }

  // ── editing on and off, selecting ──

  #enter(focus: boolean): void {
    if (!this.#editable()) return;
    if (!this.#editing) {
      this.#editing = true;
      this.#layout();
    }
    if (focus) this.#overlay.focus({ preventScroll: true });
  }

  #leave(focusView: boolean): void {
    if (!this.#editing) return;
    this.#editing = false;
    this.#drag = null;
    this.#preview = null;
    this.#select(null, false);
    this.#draw();
    if (focusView) this.#view.focus();
  }

  #select(ref: ShapeRef | null, draw = true): void {
    const changed = !sameRef(ref, this.#selected) && !(ref === null && this.#selected === null);
    this.#selected = ref;
    if (draw && this.#editing) this.#drawOverlay();
    if (!changed) return;
    const entry = ref ? entryOf(this.#data(), ref) : undefined;
    this.#status.textContent = ref && entry ? `${shapeLabel(ref, entry)} selected` : '';
    this.dom.dispatchEvent(new CustomEvent(SHAPE_SELECT_EVENT, { bubbles: true, detail: { field: ref ? fieldOf(ref) : null } }));
  }

  /** A command or the Inspector asked for a shape (plugin.ts): start editing with it selected. */
  #request(decorations: readonly Decoration[]): void {
    for (const deco of decorations) {
      const request = (deco.spec as Record<string, unknown>)[SHAPE_REQUEST] as ShapeRequest | undefined;
      if (!request || request.seq <= this.#lastRequest) continue;
      this.#lastRequest = request.seq;
      if (request.stop) {
        this.#leave(false);
        continue;
      }
      if (!this.#editable()) return;
      this.#enter(request.focus);
      this.#select(request.ref ?? tabOrder(this.#data())[0] ?? null);
      if (request.created) this.dom.dispatchEvent(new CustomEvent(SHAPE_ADDED_EVENT, { bubbles: true }));
    }
  }

  // ── the pointer ──

  #toPercent(event: { clientX: number; clientY: number }): Point {
    const r = this.#overlay.getBoundingClientRect();
    return { x: ((event.clientX - r.left) / (r.width || 1)) * 100, y: ((event.clientY - r.top) / (r.height || 1)) * 100 };
  }

  #refAt(target: EventTarget | null): ShapeRef | null {
    const el = target instanceof Element ? target.closest('[data-list]') : null;
    if (!el || !this.#overlay.contains(el)) return null;
    return { list: el.getAttribute('data-list') as ShapeRef['list'], index: Number(el.getAttribute('data-index')) };
  }

  #doubleClick(event: MouseEvent): void {
    if (this.#editing || !this.#editable()) return;
    const pos = this.#getPos();
    if (pos === undefined) return;
    event.preventDefault();
    if (!this.#isSelected()) this.#view.dispatch(this.#view.state.tr.setSelection(NodeSelection.create(this.#view.state.doc, pos)));
    this.#enter(true);
    const hit = this.dom.ownerDocument.elementsFromPoint(event.clientX, event.clientY).map((el) => this.#refAt(el)).find((r) => r !== null);
    this.#select(hit ?? null);
  }

  #pointerDown(event: PointerEvent): void {
    if (!this.#editing || event.button !== 0) return;
    event.preventDefault();
    this.#overlay.focus({ preventScroll: true });
    const handleEl = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-handle]') : null;
    const selected = this.#selected;
    let ref: ShapeRef | null;
    let handle: Handle | null = null;
    if (handleEl && selected) {
      ref = selected;
      handle = handleEl.dataset['handle'] as Handle;
    } else {
      ref = this.#refAt(event.target);
      this.#select(ref);
    }
    const entry = ref ? entryOf(this.#data(), ref) : undefined;
    if (!ref || !entry || !this.#editable()) return;
    this.#drag = { pointerId: event.pointerId, ref, handle, start: this.#toPercent(event), entry, moved: false };
    this.#overlay.setPointerCapture?.(event.pointerId);
  }

  #pointerMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const p = this.#toPercent(event);
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 0.2) return;
    drag.moved = true;
    const kind = KIND_OF[drag.ref.list];
    const next = drag.handle ? dragHandle(drag.entry, kind, drag.handle, p.x, p.y) : moveEntry(drag.entry, kind, p.x - drag.start.x, p.y - drag.start.y);
    this.#preview = withEntry(this.#value().data ?? {}, drag.ref, next);
    this.#draw();
  }

  #pointerUp(event: PointerEvent, cancelled = false): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#drag = null;
    this.#overlay.releasePointerCapture?.(event.pointerId);
    if (!drag.moved) return;
    if (cancelled || !this.#preview) {
      this.#preview = null;
      this.#draw();
      return;
    }
    this.#commit(this.#preview);
  }

  // ── the keyboard ──

  #keyDown(event: KeyboardEvent): void {
    if (!this.#editing) return;
    const data = this.#data();
    const selected = this.#selected;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        if (this.#preview) this.#preview = null;
        this.#leave(true);
        return;
      case 'Tab': {
        const order = tabOrder(data);
        if (order.length === 0) return;
        event.preventDefault();
        const at = selected ? order.findIndex((r) => sameRef(r, selected)) : -1;
        const next = event.shiftKey ? (at <= 0 ? order.length - 1 : at - 1) : (at + 1) % order.length;
        this.#select(order[next]!);
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const entry = selected ? entryOf(data, selected) : undefined;
        if (!selected || !entry || !this.#editable()) return;
        // One screen pixel (Shift: 10) of the picture as drawn now, in % of its width or height.
        const r = this.#overlay.getBoundingClientRect();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        const next = moveEntry(entry, KIND_OF[selected.list], (dx / (r.width || 1)) * 100, (dy / (r.height || 1)) * 100);
        this.#preview = withEntry(data, selected, next);
        this.#nudged = true;
        this.#draw();
        this.#status.textContent = `${shapeLabel(selected, next)} at ${describe(next)}`;
        return;
      }
      case 'Delete':
      case 'Backspace': {
        event.preventDefault();
        if (!selected || !entryOf(data, selected) || !this.#editable()) return;
        const next = withoutEntry(data, selected);
        const left = listOf(next, selected.list).length;
        this.#select(left > 0 ? { list: selected.list, index: Math.min(selected.index, left - 1) } : (tabOrder(next)[0] ?? null), false);
        this.#commit(next);
        return;
      }
      case 'Enter':
        event.preventDefault();
        return;
    }
  }

  /** A nudge is committed when the arrow key is let go: holding it down is one change, one undo step. */
  #keyUp(event: KeyboardEvent): void {
    if (!this.#nudged || !event.key.startsWith('Arrow')) return;
    this.#nudged = false;
    if (this.#preview) this.#commit(this.#preview);
  }
}

/** The shapes a % crop hides (pagemd's own test, C13 `shapesHiddenByCrop`); none when there is no crop or it is not in %. */
export function hiddenShapes(data: AnnotationData): ShapeRef[] {
  return (shapesHiddenByCrop(data) ?? []) as ShapeRef[];
}

/** "x 40, y 30" for a point; the first corner or end point otherwise. */
function describe(entry: Entry): string {
  const x = entry['x'] ?? entry['x1'];
  const y = entry['y'] ?? entry['y1'];
  return `x ${round2(Number(x))}, y ${round2(Number(y))}`;
}

/** The node view constructor, drawing with `html` (media.ts: pagemd's renderer rule, from the node's data). */
export function annotatedImageView(html: (value: AnnotatedValue, yamlError: unknown, env: Record<string, unknown>) => string): NodeViewConstructor {
  return (node, view, getPos, decorations) => new AnnotatedImageView(node, view, getPos, decorations, html);
}

/** The overlay's look (editor UI: VS Code's colors). */
export const SHAPE_EDITING_CSS = `
.pmd-canvas .pmd-annotated-image { position: relative; }
.pmd-canvas .pmd-annotated-drawing { white-space: normal; }
.pmd-canvas .pmd-shape-overlay { position: absolute; z-index: 20; outline: none; touch-action: none; }
.pmd-canvas .pmd-shape-overlay:focus-visible, .pmd-canvas .pmd-shape-overlay:focus { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.pmd-canvas .pmd-shape-editing .pmd-annotated-drawing { cursor: default; }
.pmd-canvas .pmd-shape-hits { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.pmd-canvas .pmd-shape-hit { cursor: move; }
.pmd-canvas svg .pmd-shape-hit { fill: transparent; stroke: transparent; stroke-width: 12px; vector-effect: non-scaling-stroke; }
.pmd-canvas svg .pmd-shape-hit-stroke { pointer-events: stroke; }
.pmd-canvas svg .pmd-shape-hit-fill { pointer-events: all; }
.pmd-canvas svg .pmd-shape-hit:hover { stroke: color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent); }
.pmd-canvas .pmd-shape-hit-marker { position: absolute; width: 1.6rem; height: 1.6rem; border-radius: 50%; transform: translate(-50%, -50%); }
.pmd-canvas .pmd-shape-hit-text { position: absolute; }
.pmd-canvas .pmd-shape-hit-marker:hover, .pmd-canvas .pmd-shape-hit-text:hover { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.pmd-canvas .pmd-shape-selected { box-shadow: 0 0 0 2px var(--vscode-focusBorder); }
.pmd-canvas .pmd-shape-outline { fill: none; stroke: var(--vscode-focusBorder); stroke-width: 1px; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; pointer-events: none; }
.pmd-canvas .pmd-shape-handle { position: absolute; width: 10px; height: 10px; transform: translate(-50%, -50%); box-sizing: border-box; background: var(--vscode-editor-background); border: 2px solid var(--vscode-focusBorder); cursor: crosshair; }
.pmd-canvas .pmd-hidden-shapes { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); margin: 2px 0 0; }
.pmd-canvas .pmd-hidden-shapes[hidden] { display: none; }
.pmd-canvas .pmd-shape-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
