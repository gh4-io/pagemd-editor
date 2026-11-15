// Dragging a table column's border on the canvas (P19). Near a cell's right border the pointer becomes a resize arrow;
// pressing and dragging moves the border between that column and the next (both change, the others stay). While the
// pointer moves only the table's `<col>` widths change on the page (the table's node view lets them, table.ts); on
// release ONE transaction writes the widths into the table's `{…}` line: one undo step, one change sent to the host
// (R-94, as P15's shapes). Escape during a drag puts the widths back. Own plugin, not prosemirror-tables'
// `columnResizing` (AD-P19-04): that keeps pixel widths in every cell's `colwidth`, draws its own table view with a
// pixel width and writes one change per cell; pagemd needs percentages on the table's `{…}` line.
// The plugin also measures the columns the canvas shows, for the width commands (a table without widths starts from
// what the author sees, AD-P19-06).
// Follow-up (session 37): while dragging, a small readout by the pointer shows the two widths ("32.5% | 17.5%"; the drag
// moves in half-percent steps, and the readout shows what will be written); the live region says the result once, on
// release or Escape. A press near a border that doesn't move is a click: the cursor goes where it was clicked (before, it
// was swallowed). A double-click on a border fits the column on its left to its content (like a spreadsheet).
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { TableMap, cellAround } from 'prosemirror-tables';
import { isPagemdTable } from './context.ts';
import { tableShape } from './shape.ts';
import { completeWidths, layoutOf, MIN_WIDTH, moveBorder, setLayout, tradeWidth, widenColumn } from './widths.ts';

/** How close to a border (in screen pixels) the pointer must be to grab it. */
export const HANDLE_PX = 5;
/** How far (screen pixels) the pointer must move before a press on a border is a drag, not a click. */
const CLICK_PX = 3;
/** A drag's step, in percent. */
export const DRAG_STEP = 0.5;
/**
 * The event the plugin sends (bubbling, from the editor's element) with a short sentence for the screen reader's live region:
 * `detail.message`. The app passes it to its announcer (no access to the app from a preset).
 */
export const ANNOUNCE_EVENT = 'pmd-announce';

const say = (view: EditorView, message: string): void => {
  view.dom.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { bubbles: true, detail: { message } }));
};
/** A width as the readout and the live region say it: at most one decimal. */
const shown = (w: number): string => `${Number(w.toFixed(1))}%`;

interface ResizeState {
  /** The pointer is over a border that can be dragged. */
  hover: boolean;
}

export const columnResizeKey = new PluginKey<ResizeState>('pmd-column-resize');

/** What the plugin shares with the width commands: the canvas it draws on (null in tests without one). */
interface Measurer {
  view: EditorView | null;
}

interface Border {
  /** Position of the table node. */
  pos: number;
  /** The border is on the right of column `col` (and on the left of `col + 1`). */
  col: number;
  table: HTMLTableElement;
}

const tableElementOf = (view: EditorView, pos: number): HTMLTableElement | null => {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? (dom.matches('table') ? (dom as HTMLTableElement) : dom.querySelector('table')) : null;
};

/**
 * The widths (in percent of the table's width) of the columns the canvas shows for the table at `pos`, measured from the
 * left edge of a cell starting in each column; null when the table isn't drawn or a column has no cell of its own.
 */
export function measureColumnsIn(view: EditorView, pos: number): number[] | null {
  const node = view.state.doc.nodeAt(pos);
  const table = tableElementOf(view, pos);
  if (!node || !table || !isPagemdTable(node)) return null;
  const map = TableMap.get(node);
  const box = table.getBoundingClientRect();
  if (box.width <= 0) return null;
  const lefts: number[] = [];
  for (let col = 0; col < map.width; col++) {
    let left: number | null = null;
    for (let row = 0; row < map.height && left === null; row++) {
      const offset = map.map[row * map.width + col]!;
      if (map.findCell(offset).left !== col) continue;
      const cell = view.nodeDOM(pos + 1 + offset);
      if (cell instanceof HTMLElement) left = cell.getBoundingClientRect().left;
    }
    if (left === null) return null;
    lefts.push(left);
  }
  lefts.push(box.right);
  return lefts.slice(0, -1).map((l, k) => ((lefts[k + 1]! - l) / box.width) * 100);
}

/** The canvas showing `state` (null in tests without one, or when it shows another document). */
function canvasOf(state: EditorState): EditorView | null {
  const view = (columnResizeKey.get(state)?.spec as { measurer?: Measurer } | undefined)?.measurer?.view;
  return view && view.state.doc === state.doc ? view : null;
}

/** The columns the canvas shows for the table at `pos` (null without a canvas): the width commands' starting point. */
export function measureColumns(state: EditorState, pos: number): number[] | null {
  const view = canvasOf(state);
  return view ? measureColumnsIn(view, pos) : null;
}

/** An editable canvas shows `state`: the commands that measure the text can run. */
export const hasCanvas = (state: EditorState): boolean => !!canvasOf(state)?.editable;

/**
 * How wide (screen pixels) the content of `cell` is on one line: its text drawn in a hidden copy with the cell's own font,
 * plus the cell's padding and borders. The copy goes next to the table, outside the rows (the table's node view lets that
 * change happen without ProseMirror reading the table back), so it is zoomed and styled like the page.
 */
function contentWidth(cell: HTMLElement, beside: HTMLElement): number {
  const style = getComputedStyle(cell);
  const probe = cell.ownerDocument.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing};word-spacing:${style.wordSpacing};text-transform:${style.textTransform}`;
  probe.append(...[...cell.childNodes].map((n) => n.cloneNode(true)));
  beside.append(probe);
  const scale = cell.offsetWidth > 0 ? cell.getBoundingClientRect().width / cell.offsetWidth : 1;
  const text = probe.getBoundingClientRect().width;
  probe.remove();
  const extra = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, k) => sum + (parseFloat(style[k as 'paddingLeft']) || 0), 0);
  return text + (extra + 1) * scale;
}

/**
 * The table's widths with column `col` fitted to its content (the widest cell that is in that column only, on one line),
 * traded with its neighbour as Wider does (AD-P19-05): never under 5 % for either, in half-percent steps. Null without a
 * canvas or a cell to measure.
 */
export function fitColumnWidthsIn(view: EditorView, pos: number, col: number, other?: number): number[] | null {
  const node = view.state.doc.nodeAt(pos);
  const table = tableElementOf(view, pos);
  if (!node || !table || !isPagemdTable(node)) return null;
  const map = TableMap.get(node);
  const box = table.getBoundingClientRect();
  const beside = table.parentElement;
  if (box.width <= 0 || !beside) return null;
  let needed = 0;
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row++) {
    const offset = map.map[row * map.width + col]!;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const rect = map.findCell(offset);
    if (rect.left !== col || rect.right !== col + 1) continue; // a cell spanning columns doesn't decide one column's width
    const cell = view.nodeDOM(pos + 1 + offset);
    if (cell instanceof HTMLElement) needed = Math.max(needed, contentWidth(cell, beside));
  }
  if (needed <= 0) return null;
  const start = completeWidths(layoutOf(node), measureColumnsIn(view, pos));
  const target = Math.max(MIN_WIDTH, Math.ceil(((needed / box.width) * 100) / DRAG_STEP) * DRAG_STEP);
  return other === undefined ? widenColumn(start, col, target - start[col]!) : tradeWidth(start, col, other, target - start[col]!);
}

/** The cursor's column fitted (the command "Fit column to content"); `other`: the column it trades with (FIX-PGF: a merged cell's). */
export function fitColumnWidths(state: EditorState, pos: number, col: number, other?: number): number[] | null {
  const view = canvasOf(state);
  return view ? fitColumnWidthsIn(view, pos, col, other) : null;
}

/** The draggable border under the pointer, if any (not the table's own right edge: the table is as wide as the page). */
function borderAt(view: EditorView, event: MouseEvent): Border | null {
  const target = event.target instanceof Element ? event.target.closest('td, th') : null;
  if (!target || !view.dom.contains(target)) return null;
  const box = target.getBoundingClientRect();
  const nearRight = Math.abs(event.clientX - box.right) <= HANDLE_PX;
  const nearLeft = Math.abs(event.clientX - box.left) <= HANDLE_PX;
  if (!nearRight && !nearLeft) return null;
  let inside: number;
  try {
    inside = view.posAtDOM(target, 0);
  } catch {
    return null;
  }
  const $cell = cellAround(view.state.doc.resolve(inside));
  if (!$cell) return null;
  const node = $cell.node(-1);
  if (!isPagemdTable(node)) return null;
  const map = TableMap.get(node);
  // Cells that overlap: the tools are off (AD-P16-04). Short rows only: the drag's change evens the table out (AD-FIX-FT-05).
  if (map.problems && tableShape(node).kind === 'broken') return null;
  const rect = map.findCell($cell.pos - $cell.start(-1));
  const col = nearRight ? rect.right - 1 : rect.left - 1;
  if (col < 0 || col + 1 >= map.width) return null;
  const table = target.closest('table') as HTMLTableElement | null;
  return table ? { pos: $cell.start(-1) - 1, col, table } : null;
}

/** The table's `<col>` elements, made for the preview when the table has none yet. */
function previewCols(table: HTMLTableElement, count: number): HTMLTableColElement[] {
  let group = table.querySelector(':scope > colgroup');
  if (!group) {
    group = table.ownerDocument.createElement('colgroup');
    table.insertBefore(group, table.querySelector(':scope > tbody, :scope > thead'));
  }
  while (group.children.length < count) group.append(table.ownerDocument.createElement('col'));
  return [...group.children].slice(0, count) as HTMLTableColElement[];
}

/** A drag in progress: the preview on the page, the readout by the pointer, and how to put both back. */
class Drag {
  readonly #view: EditorView;
  readonly #border: Border;
  readonly #start: number[];
  readonly #startX: number;
  readonly #startY: number;
  readonly #width: number;
  readonly #layoutBefore: string;
  readonly #groupBefore: Node | null;
  #widths: number[];
  #moved = false;
  #readout: HTMLElement | null = null;
  #done = false;

  constructor(view: EditorView, border: Border, event: MouseEvent) {
    this.#view = view;
    this.#border = border;
    const node = view.state.doc.nodeAt(border.pos)!;
    this.#start = completeWidths(layoutOf(node), measureColumnsIn(view, border.pos));
    this.#widths = this.#start;
    this.#startX = event.clientX;
    this.#startY = event.clientY;
    this.#width = border.table.getBoundingClientRect().width;
    this.#layoutBefore = border.table.style.tableLayout;
    const group = border.table.querySelector(':scope > colgroup');
    this.#groupBefore = group ? group.cloneNode(true) : null;
  }

  move(event: MouseEvent): void {
    if (this.#done || this.#width <= 0) return;
    if (!this.#moved && Math.abs(event.clientX - this.#startX) < CLICK_PX && Math.abs(event.clientY - this.#startY) < CLICK_PX) return;
    if (!this.#moved) this.#border.table.classList.add('pmd-col-dragging');
    this.#moved = true;
    this.#widths = this.#snapped(((event.clientX - this.#startX) / this.#width) * 100);
    const table = this.#border.table;
    table.style.tableLayout = 'fixed';
    previewCols(table, this.#widths.length).forEach((col, k) => (col.style.width = `${this.#widths[k]!}%`));
    this.#showReadout(event);
  }

  /** Release: a drag is one transaction with the widths; a press that didn't move is a click (the cursor goes there). */
  finish(event: MouseEvent): void {
    if (this.#done) return;
    this.#restore();
    const view = this.#view;
    if (!this.#moved) {
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
      view.focus();
      return;
    }
    const k = this.#border.col;
    if (this.#widths.every((w, i) => w === this.#start[i])) return say(view, 'Column widths unchanged');
    const tr = view.state.tr;
    if (setLayout(tr, this.#border.pos, { widths: this.#widths })) view.dispatch(tr);
    say(view, `Column widths ${shown(this.#widths[k]!)} and ${shown(this.#widths[k + 1]!)}`);
  }

  cancel(): void {
    if (this.#done) return;
    this.#restore();
    if (this.#moved) say(this.#view, 'Column widths unchanged');
  }

  /** The start widths with the border moved by `delta` points, in half-percent steps (the two columns keep their sum). */
  #snapped(delta: number): number[] {
    const k = this.#border.col;
    const out = moveBorder(this.#start, k, delta);
    const pair = this.#start[k]! + this.#start[k + 1]!;
    const left = Math.min(Math.max(Math.round(out[k]! / DRAG_STEP) * DRAG_STEP, MIN_WIDTH), pair - MIN_WIDTH);
    out[k] = left;
    out[k + 1] = Number((pair - left).toFixed(4));
    return out;
  }

  /** The two widths by the pointer (for the eye; the live region says the result once, on release). */
  #showReadout(event: MouseEvent): void {
    const doc = this.#view.dom.ownerDocument;
    if (!this.#readout) {
      this.#readout = doc.createElement('div');
      this.#readout.className = 'pmd-col-readout';
      this.#readout.setAttribute('aria-hidden', 'true');
      doc.body.append(this.#readout);
    }
    const k = this.#border.col;
    this.#readout.textContent = `${shown(this.#widths[k]!)} | ${shown(this.#widths[k + 1]!)}`;
    this.#readout.style.left = `${event.clientX + 14}px`;
    this.#readout.style.top = `${event.clientY + 18}px`;
  }

  #restore(): void {
    this.#done = true;
    this.#readout?.remove();
    this.#readout = null;
    const table = this.#border.table;
    table.classList.remove('pmd-col-dragging');
    table.style.tableLayout = this.#layoutBefore;
    if (!table.getAttribute('style')) table.removeAttribute('style');
    table.querySelector(':scope > colgroup')?.remove();
    if (this.#groupBefore) table.insertBefore(this.#groupBefore, table.querySelector(':scope > tbody, :scope > thead'));
  }
}

/** The column-border drag and double-click (part of `tableEditingPlugins()`). */
export function columnResizePlugin(): Plugin<ResizeState> {
  const measurer: Measurer = { view: null };
  let drag: Drag | null = null;
  const setHover = (view: EditorView, hover: boolean): void => {
    if (columnResizeKey.getState(view.state)?.hover !== hover) view.dispatch(view.state.tr.setMeta(columnResizeKey, { hover }).setMeta('addToHistory', false));
  };
  return new Plugin<ResizeState>({
    key: columnResizeKey,
    measurer,
    state: {
      init: () => ({ hover: false }),
      apply: (tr, value) => (tr.getMeta(columnResizeKey) as ResizeState | undefined) ?? value,
    },
    view(view) {
      measurer.view = view;
      return {
        destroy() {
          drag?.cancel();
          measurer.view = null;
        },
      };
    },
    props: {
      attributes: (state): Record<string, string> => (columnResizeKey.getState(state)?.hover ? { class: 'pmd-col-resize' } : {}),
      handleDOMEvents: {
        mousemove(view, event) {
          if (drag) return false;
          setHover(view, view.editable && borderAt(view, event) !== null);
          return false;
        },
        mouseleave(view) {
          if (!drag) setHover(view, false);
          return false;
        },
        mousedown(view, event) {
          if (event.button !== 0 || !view.editable || event.detail > 1) return event.detail > 1 && view.editable && borderAt(view, event) !== null;
          const border = borderAt(view, event);
          if (!border) return false;
          event.preventDefault();
          const current = new Drag(view, border, event);
          drag = current;
          const win = view.dom.ownerDocument.defaultView ?? window;
          const stop = (): void => {
            win.removeEventListener('mousemove', move);
            win.removeEventListener('mouseup', up);
            win.removeEventListener('keydown', key, true);
            drag = null;
            setHover(view, false);
          };
          const move = (e: MouseEvent): void => current.move(e);
          const up = (e: MouseEvent): void => {
            stop();
            current.finish(e);
          };
          const key = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            stop();
            current.cancel();
          };
          win.addEventListener('mousemove', move);
          win.addEventListener('mouseup', up);
          win.addEventListener('keydown', key, true);
          return true;
        },
        // A double-click on a border fits the column on its left to its content: one transaction, one undo step.
        dblclick(view, event) {
          if (!view.editable) return false;
          const border = borderAt(view, event);
          if (!border) return false;
          event.preventDefault();
          const widths = fitColumnWidthsIn(view, border.pos, border.col);
          if (!widths) return true;
          const tr = view.state.tr;
          if (setLayout(tr, border.pos, { widths })) view.dispatch(tr);
          say(view, `Column fitted to its content: ${shown(widths[border.col]!)}`);
          return true;
        },
      },
    },
  });
}
