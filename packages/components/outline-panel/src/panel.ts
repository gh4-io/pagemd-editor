// The Outline panel (P9, R-164): a panel on the left of the editor listing the document's structure from the registry's
// outline (headings, the title, figures with their numbers, tables, boxes, callouts, the TOC, includes). Clicking an
// entry goes there. A heading that starts a section can be dragged to another place, or moved with Move up / Move down
// (the keyboard route: Alt+Up / Alt+Down on the entry). It knows no syntax and never edits the canvas itself: the app
// turns a move into one text edit (see sections.ts) and sends it to VS Code.
import { topBlocks, type OutlineEntry } from '@pagemd-editor/core';
import { Plugin, type EditorState } from 'prosemirror-state';
import { dropTargets, moveDown, moveUp, sectionHeads, sectionOf, type SectionHead, type SectionMove } from './sections.ts';

export interface OutlinePanelOptions {
  /** The editor's state now; undefined before the canvas exists. */
  state(): EditorState | undefined;
  /** The outline of `state`'s document (the app gives the numbered one: preset-pagemd's `numberedOutline`). */
  entries(state: EditorState): OutlineEntry[];
  /** The words an entry shows (the app gives preset-pagemd's `outlineLabel`: "Figure 3: Caption"); default: its label. */
  label?(entry: OutlineEntry): string;
  /** False in Read: entries still go to their place, nothing moves. */
  editable(): boolean;
  /** Go to an entry (select it on the canvas, scroll it into view). */
  reveal(entry: OutlineEntry): void;
  /** Move a section (one text edit, made by the app). */
  move(move: SectionMove): void;
  /** The close button was pressed. */
  onClose(): void;
}

/** The codicon for each kind of entry (VS Code's own icons, R-162). */
export const OUTLINE_ICONS: Readonly<Record<string, string>> = {
  title: 'symbol-file',
  heading: 'symbol-key',
  figure: 'file-media',
  table: 'table',
  box: 'symbol-structure',
  callout: 'info',
  toc: 'list-tree',
  include: 'file-symlink-file',
  section: 'symbol-namespace',
  cover: 'book',
  index: 'symbol-key',
};


/**
 * How far an entry is indented: headings by their level; anything else one step under the heading above it (the title
 * and anything before the first heading: none).
 */
export function indents(entries: readonly OutlineEntry[]): number[] {
  let under = 0;
  return entries.map((entry) => {
    if (entry.kind === 'heading') {
      under = entry.level;
      return entry.level - 1;
    }
    return entry.kind === 'title' ? 0 : under;
  });
}

export class OutlinePanel {
  readonly element: HTMLElement;
  /** Add to the canvas's `pmPlugins`: the panel follows the document and the cursor. */
  readonly plugin: Plugin;
  readonly #o: OutlinePanelOptions;
  readonly #doc: Document;
  readonly #list: HTMLElement;
  readonly #up: HTMLButtonElement;
  readonly #down: HTMLButtonElement;
  #entries: OutlineEntry[] = [];
  #heads: SectionHead[] = [];
  #blockCount = 0;
  /** The entry the author picked (by position), else the one holding the cursor. */
  #chosen: number | undefined;
  #current: number | undefined;
  #key = '';
  #pending: number | undefined;
  #dragging: SectionHead | undefined;

  constructor(parent: HTMLElement, options: OutlinePanelOptions) {
    this.#o = options;
    const d = (this.#doc = parent.ownerDocument);
    this.element = d.createElement('aside');
    this.element.className = 'pmd-outline';
    this.element.setAttribute('aria-label', 'Outline');
    const head = d.createElement('div');
    head.className = 'pmd-outline-head';
    const title = d.createElement('span');
    title.className = 'pmd-outline-title';
    title.textContent = 'Outline';
    const tools = d.createElement('div');
    tools.className = 'pmd-outline-tools';
    this.#up = button(d, 'arrow-up', 'Move up', () => this.moveChosen(-1));
    this.#down = button(d, 'arrow-down', 'Move down', () => this.moveChosen(1));
    tools.append(this.#up, this.#down, button(d, 'close', 'Close the Outline', () => options.onClose()));
    head.append(title, tools);
    this.#list = d.createElement('div');
    this.#list.className = 'pmd-outline-list';
    this.#list.setAttribute('role', 'tree');
    this.#list.setAttribute('aria-label', 'Outline');
    // The end of the document is a drop place too (below the last entry).
    this.#list.addEventListener('dragover', (event) => this.#dragOver(event, this.#blockCount));
    this.#list.addEventListener('drop', (event) => this.#drop(event, this.#blockCount));
    this.#list.addEventListener('dragleave', (event) => {
      if (event.target === this.#list) this.#list.classList.remove('pmd-outline-drop-end');
    });
    this.element.append(head, this.#list);
    parent.prepend(this.element);
    this.plugin = new Plugin({
      view: () => {
        this.update();
        return {
          update: (view, previous) => {
            if (previous.doc.eq(view.state.doc) && previous.selection.eq(view.state.selection)) return;
            if (!previous.doc.eq(view.state.doc)) this.#chosen = undefined;
            this.update();
          },
        };
      },
    });
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** The entries drawn now. */
  get entries(): readonly OutlineEntry[] {
    return this.#entries;
  }

  show(): void {
    this.element.hidden = false;
    this.refresh();
  }

  hide(): void {
    this.element.hidden = true;
  }

  /** Redraws now. */
  refresh(): void {
    this.#key = '';
    this.#draw();
  }

  /** Redraws on the next frame (the document or the cursor changed), at most once per frame. */
  update(): void {
    if (this.#pending !== undefined || this.element.hidden) return;
    const win = this.#doc.defaultView;
    const run = (): void => {
      this.#pending = undefined;
      this.#draw();
    };
    this.#pending = win ? win.requestAnimationFrame(run) : (setTimeout(run, 0) as unknown as number);
  }

  /** Move up (-1) or down (1) the section of the chosen heading (or the one the cursor is in). */
  moveChosen(direction: -1 | 1): boolean {
    const move = this.#moveFor(direction);
    if (!move) return false;
    this.#o.move(move);
    return true;
  }

  destroy(): void {
    if (this.#pending !== undefined) this.#doc.defaultView?.cancelAnimationFrame(this.#pending);
    this.element.remove();
  }

  /** The heading whose section Move up / Move down acts on: the chosen entry's, else the cursor's section. */
  #headFor(): SectionHead | undefined {
    const at = this.#chosen ?? this.#current;
    if (at === undefined) return undefined;
    const entry = this.#entries[at];
    if (!entry) return undefined;
    const exact = this.#heads.find((h) => h.entry.pos === entry.pos);
    if (exact) return exact;
    // A non-heading entry: the section it sits in.
    return [...this.#heads].reverse().find((h) => h.entry.pos <= entry.pos);
  }

  #moveFor(direction: -1 | 1): SectionMove | null {
    if (!this.#o.editable()) return null;
    const head = this.#headFor();
    if (!head) return null;
    return direction < 0 ? moveUp(this.#heads, head, this.#blockCount) : moveDown(this.#heads, head, this.#blockCount);
  }

  #draw(): void {
    const state = this.#o.state();
    if (!state || this.element.hidden) return;
    const entries = this.#o.entries(state);
    const cursor = state.selection.head;
    let current: number | undefined;
    entries.forEach((e, i) => {
      if (e.pos <= cursor) current = i;
    });
    this.#current = current;
    const key = JSON.stringify([entries, current, this.#chosen, this.#o.editable()]);
    if (key === this.#key) return;
    this.#key = key;
    this.#entries = entries;
    this.#heads = sectionHeads(state.doc, entries);
    this.#blockCount = topBlocks(state.doc).length;
    const focused = this.#list.contains(this.#doc.activeElement) ? (this.#doc.activeElement as HTMLElement).dataset['index'] : undefined;
    this.#list.replaceChildren();
    if (entries.length === 0) {
      const empty = this.#doc.createElement('div');
      empty.className = 'pmd-outline-empty';
      empty.textContent = 'No headings, figures or tables yet.';
      this.#list.append(empty);
    }
    const depth = indents(entries);
    const editable = this.#o.editable();
    entries.forEach((entry, i) => this.#list.append(this.#row(entry, i, depth[i]!, i === (this.#chosen ?? current), editable)));
    if (focused !== undefined) this.#list.querySelector<HTMLElement>(`[data-index="${focused}"]`)?.focus();
    this.#up.disabled = !this.#moveFor(-1);
    this.#down.disabled = !this.#moveFor(1);
  }

  #row(entry: OutlineEntry, index: number, depth: number, selected: boolean, editable: boolean): HTMLElement {
    const d = this.#doc;
    const row = d.createElement('div');
    row.className = 'pmd-outline-entry';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(selected));
    row.tabIndex = selected ? 0 : -1;
    row.dataset['index'] = String(index);
    row.dataset['kind'] = entry.kind;
    row.style.paddingLeft = `${6 + depth * 12}px`;
    const icon = d.createElement('span');
    icon.className = `codicon codicon-${OUTLINE_ICONS[entry.kind] ?? 'symbol-misc'}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = d.createElement('span');
    label.className = 'pmd-outline-label';
    label.textContent = this.#label(entry);
    row.title = this.#label(entry);
    row.append(icon, label);
    row.addEventListener('click', () => this.#go(index));
    row.addEventListener('keydown', (event) => this.#key_(event, index));
    const head = this.#heads.find((h) => h.entry.pos === entry.pos);
    if (head && editable) {
      row.draggable = true;
      row.dataset['section'] = 'true';
      row.addEventListener('dragstart', (event) => {
        this.#dragging = head;
        event.dataTransfer?.setData('text/plain', this.#label(entry));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        row.classList.add('pmd-outline-dragging');
      });
      row.addEventListener('dragend', () => {
        this.#dragging = undefined;
        row.classList.remove('pmd-outline-dragging');
        this.#clearDrop();
      });
    }
    if (head) {
      row.addEventListener('dragover', (event) => this.#dragOver(event, head.block, row));
      row.addEventListener('drop', (event) => this.#drop(event, head.block));
    }
    return row;
  }

  #label(entry: OutlineEntry): string {
    return this.#o.label?.(entry) ?? (entry.label || entry.kind);
  }

  #go(index: number): void {
    this.#chosen = index;
    const entry = this.#entries[index];
    this.#key = '';
    if (entry) this.#o.reveal(entry);
    this.#draw();
    this.#list.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  }

  #key_(event: KeyboardEvent, index: number): void {
    const rows = [...this.#list.querySelectorAll<HTMLElement>('.pmd-outline-entry')];
    const focus = (i: number): void => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!row) return;
      for (const r of rows) r.tabIndex = -1;
      row.tabIndex = 0;
      row.focus();
      this.#chosen = Number(row.dataset['index']);
      this.#up.disabled = !this.#moveFor(-1);
      this.#down.disabled = !this.#moveFor(1);
    };
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.#chosen = index;
      this.moveChosen(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.key === 'ArrowDown') focus(index + 1);
    else if (event.key === 'ArrowUp') focus(index - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(rows.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') this.#go(index);
    else return;
    event.preventDefault();
  }

  #dragOver(event: DragEvent, before: number, row?: HTMLElement): void {
    const dragging = this.#dragging;
    if (!dragging) return;
    const section = sectionOf(this.#heads, dragging, this.#blockCount);
    if (!dropTargets(this.#heads, section, this.#blockCount).includes(before)) return;
    if (row) event.stopPropagation();
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.#clearDrop();
    if (row) row.classList.add('pmd-outline-drop-before');
    else this.#list.classList.add('pmd-outline-drop-end');
  }

  #drop(event: DragEvent, before: number): void {
    const dragging = this.#dragging;
    this.#clearDrop();
    if (!dragging) return;
    const section = sectionOf(this.#heads, dragging, this.#blockCount);
    if (!dropTargets(this.#heads, section, this.#blockCount).includes(before)) return;
    event.preventDefault();
    event.stopPropagation();
    this.#dragging = undefined;
    this.#o.move({ section, before });
  }

  #clearDrop(): void {
    this.#list.classList.remove('pmd-outline-drop-end');
    for (const row of this.#list.querySelectorAll('.pmd-outline-drop-before')) row.classList.remove('pmd-outline-drop-before');
  }
}

function button(d: Document, iconName: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = d.createElement('button');
  b.type = 'button';
  b.className = 'pmd-outline-button';
  b.title = label;
  b.setAttribute('aria-label', label);
  const icon = d.createElement('span');
  icon.className = `codicon codicon-${iconName}`;
  icon.setAttribute('aria-hidden', 'true');
  b.append(icon);
  b.addEventListener('click', onClick);
  return b;
}

/** Editor UI, so VS Code's theme variables only (no color of its own). */
export const outlinePanelCss = `
.pmd-outline { flex: none; width: 240px; display: flex; flex-direction: column; min-height: 0; font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-right: 1px solid var(--vscode-panel-border, transparent); }
.pmd-outline[hidden] { display: none; }
.pmd-outline-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 2px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.pmd-outline-title { font-weight: 600; text-transform: uppercase; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pmd-outline-tools { display: flex; }
.pmd-outline-button { font: inherit; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 0; border-radius: 3px; padding: 2px; cursor: pointer; display: inline-flex; }
.pmd-outline-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, transparent); }
.pmd-outline-button:disabled { opacity: 0.4; cursor: default; }
.pmd-outline-list { flex: 1; overflow: auto; padding: 4px 0 24px; }
.pmd-outline-list.pmd-outline-drop-end { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
.pmd-outline-empty { padding: 6px 8px; color: var(--vscode-descriptionForeground); }
.pmd-outline-entry { display: flex; align-items: center; gap: 4px; padding: 2px 6px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.pmd-outline-entry:hover { background: var(--vscode-list-hoverBackground, transparent); }
.pmd-outline-entry[aria-selected="true"] { background: var(--vscode-list-inactiveSelectionBackground, transparent); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
.pmd-outline-entry:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pmd-outline-entry[data-section="true"] { cursor: grab; }
.pmd-outline-entry.pmd-outline-dragging { opacity: 0.5; }
.pmd-outline-entry.pmd-outline-drop-before { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
.pmd-outline-label { overflow: hidden; text-overflow: ellipsis; }
.pmd-outline-entry .codicon { flex: none; color: var(--vscode-symbolIcon-fieldForeground, var(--vscode-icon-foreground, inherit)); }
`;
