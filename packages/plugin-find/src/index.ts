// @pagemd-editor/plugin-find: find and replace on the canvas (P11, R-175). Ctrl/Cmd+F opens the bar, Ctrl/Cmd+H opens it
// with the replace row; Enter / Shift+Enter step through the matches, Esc closes it. Matches are the document's visible text
// (search.ts), drawn as highlights (ProseMirror decorations: nothing is written to the document); a replacement is an
// ordinary edit of the text it replaces, so it takes the same save path as typing (only the blocks that changed are written,
// R-85) and "Replace all" is one edit and one undo step. Code view keeps VS Code's own find (the key is not ours there).
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';
import { findRanges, indexFrom, replaceInto, type FindOptions, type Range } from './search.ts';

export { findRanges, indexFrom, queryExpression, replaceInto, MAX_MATCHES, type FindOptions, type Matches, type Range } from './search.ts';

/** What the plugin knows: the query, its matches and which one is current. */
export interface FindState {
  query: string;
  options: FindOptions;
  ranges: Range[];
  capped: boolean;
  /** Index into `ranges`; -1 for none. */
  current: number;
  /** Whether the matches are drawn (the bar is open). */
  active: boolean;
  decorations: DecorationSet;
}

type FindMeta = { query: string; options: FindOptions; active: boolean; current?: 'selection' | number } | { recompute: true };

export const findKey = new PluginKey<FindState>('pmd-find');

const empty = (): FindState => ({ query: '', options: { matchCase: false, wholeWord: false }, ranges: [], capped: false, current: -1, active: false, decorations: DecorationSet.empty });

export interface FindPluginOptions {
  /** Whether a node's text is searched (a drawn diagram's source is not visible, so not searched). */
  searchable?(node: Node): boolean;
  /** Ctrl/Cmd+F (`replace` false) or Ctrl/Cmd+H pressed in the canvas, or Esc with the bar open. */
  onKey(key: 'find' | 'replace' | 'escape', view: EditorView): boolean;
  /** Whether the bar is open (Esc is only ours then). */
  isOpen(): boolean;
}

/** Which of our keys `event` is: Ctrl/Cmd+F, Ctrl/Cmd+H, or Esc while the bar is open. */
export function findKeyOf(event: KeyboardEvent, open: boolean): 'find' | 'replace' | 'escape' | null {
  const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  const key = event.key.toLowerCase();
  if (mod && key === 'f') return 'find';
  if (mod && key === 'h') return 'replace';
  return event.key === 'Escape' && open ? 'escape' : null;
}

/** The ProseMirror plugin: the matches for the query the bar holds, drawn as highlights. */
export function findPlugin(options: FindPluginOptions): Plugin<FindState> {
  const compute = (doc: Node, query: string, opts: FindOptions, active: boolean, pick: (ranges: Range[]) => number): FindState => {
    if (!active || query === '') return { query, options: opts, ranges: [], capped: false, current: -1, active, decorations: DecorationSet.empty };
    const { ranges, capped } = findRanges(doc, query, opts, options.searchable);
    const current = pick(ranges);
    const decorations = DecorationSet.create(
      doc,
      ranges.map((r, i) => Decoration.inline(r.from, r.to, { class: i === current ? 'pmd-find-match pmd-find-current' : 'pmd-find-match' })),
    );
    return { query, options: opts, ranges, capped, current, active, decorations };
  };
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: empty,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(findKey) as FindMeta | undefined;
        if (meta && 'query' in meta) {
          return compute(state.doc, meta.query, meta.options, meta.active, (ranges) => (typeof meta.current === 'number' ? Math.min(meta.current, ranges.length - 1) : indexFrom(ranges, state.selection.from)));
        }
        if (meta || tr.docChanged) {
          // The document (or what is searchable) changed: the same query again; the current match stays near where it was.
          const was = prev.ranges[prev.current];
          const at = was ? tr.mapping.map(was.from) : state.selection.from;
          return compute(state.doc, prev.query, prev.options, prev.active, (ranges) => indexFrom(ranges, at));
        }
        return prev;
      },
    },
    props: {
      decorations: (state) => findKey.getState(state)?.decorations ?? null,
      // A DOM handler rather than `handleKeyDown`: ProseMirror runs handleKeyDown only for an editable view, and Read finds too.
      handleDOMEvents: {
        keydown: (view, event) => keydown(view, event),
      },
    },
  });

  function keydown(view: EditorView, event: KeyboardEvent): boolean {
    const which = findKeyOf(event, options.isOpen());
    if (!which) return false;
    const handled = options.onKey(which, view);
    // VS Code's webview forwards every key the page sees to the workbench (R-158): a key that is ours must not also open
    // VS Code's own find.
    if (handled) event.stopPropagation();
    return handled;
  }
}

export interface FindBarOptions {
  /** The canvas's view (the bar is built before the canvas exists). */
  view(): EditorView | undefined;
  /** Whether text may be replaced (not in Read). */
  editable(): boolean;
  /** Whether a node's text is searched. */
  searchable?(node: Node): boolean;
  /** The bar was opened or closed. */
  onToggle?(open: boolean): void;
}

/** The bar: a find row, and (Ctrl/Cmd+H, or the chevron) a replace row. */
export class FindBar {
  readonly element: HTMLElement;
  readonly plugin: Plugin<FindState>;
  readonly #options: FindBarOptions;
  readonly #find: HTMLInputElement;
  readonly #replace: HTMLInputElement;
  readonly #count: HTMLElement;
  readonly #replaceRow: HTMLElement;
  readonly #expand: HTMLButtonElement;
  readonly #toggles: { matchCase: HTMLButtonElement; wholeWord: HTMLButtonElement };
  readonly #replaceOne: HTMLButtonElement;
  readonly #replaceAll: HTMLButtonElement;
  #open = false;
  #replacing = false;
  #flags: FindOptions = { matchCase: false, wholeWord: false };

  constructor(parent: HTMLElement, options: FindBarOptions) {
    this.#options = options;
    const doc = parent.ownerDocument;
    this.plugin = findPlugin({
      ...(options.searchable ? { searchable: options.searchable } : {}),
      isOpen: () => this.#open,
      onKey: (key, view) => {
        if (key === 'escape') return this.close(true), true;
        this.open({ replace: key === 'replace', view });
        return true;
      },
    });
    this.element = doc.createElement('div');
    this.element.className = 'pmd-find';
    parent.classList.add('pmd-find-host');
    this.element.setAttribute('role', 'search');
    this.element.setAttribute('aria-label', 'Find and replace');
    this.element.hidden = true;
    const button = (label: string, icon: string, onClick: () => void, pressed?: boolean): HTMLButtonElement => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
      const glyph = doc.createElement('span');
      glyph.className = `codicon codicon-${icon}`;
      glyph.setAttribute('aria-hidden', 'true');
      b.append(glyph);
      b.addEventListener('click', onClick);
      return b;
    };
    const input = (label: string): HTMLInputElement => {
      const i = doc.createElement('input');
      i.type = 'text';
      i.placeholder = label;
      i.setAttribute('aria-label', label);
      i.spellcheck = false;
      i.autocomplete = 'off';
      return i;
    };
    const findRow = doc.createElement('div');
    findRow.className = 'pmd-find-row';
    this.#expand = button('Show replace', 'chevron-right', () => this.#setReplacing(!this.#replacing), false);
    this.#expand.classList.add('pmd-find-expand');
    this.#find = input('Find');
    this.#toggles = {
      matchCase: button('Match case', 'case-sensitive', () => this.#flip('matchCase'), false),
      wholeWord: button('Match whole word', 'whole-word', () => this.#flip('wholeWord'), false),
    };
    this.#count = doc.createElement('span');
    this.#count.className = 'pmd-find-count';
    this.#count.setAttribute('role', 'status');
    this.#count.setAttribute('aria-live', 'polite');
    findRow.append(this.#expand, this.#find, this.#toggles.matchCase, this.#toggles.wholeWord, this.#count, button('Previous match', 'arrow-up', () => this.step(-1)), button('Next match', 'arrow-down', () => this.step(1)), button('Close', 'close', () => this.close(true)));
    this.#replaceRow = doc.createElement('div');
    this.#replaceRow.className = 'pmd-find-row pmd-find-replace-row';
    this.#replaceRow.hidden = true;
    this.#replace = input('Replace');
    this.#replaceOne = button('Replace', 'replace', () => this.replaceCurrent());
    this.#replaceAll = button('Replace all', 'replace-all', () => this.replaceAll());
    this.#replaceRow.append(this.#replace, this.#replaceOne, this.#replaceAll);
    this.element.append(findRow, this.#replaceRow);
    parent.append(this.element);
    // A canvas that can't be edited (Read) takes no keyboard focus, so a click in it focuses this pane instead and the keys are
    // caught here. (An editable canvas has the focus itself: the plugin handles the keys, and they never reach this far.)
    parent.tabIndex = -1;
    parent.addEventListener('keydown', (event) => {
      const which = findKeyOf(event, this.#open);
      const view = this.#options.view();
      if (!which || !view || view.editable) return;
      event.preventDefault();
      event.stopPropagation();
      if (which === 'escape') this.close(true);
      else this.open({ replace: which === 'replace', view });
    });

    this.#find.addEventListener('input', () => this.#search());
    this.#find.addEventListener('keydown', (event) => this.#keydown(event, 'find'));
    this.#replace.addEventListener('keydown', (event) => this.#keydown(event, 'replace'));
    this.element.addEventListener('keydown', (event) => {
      // Esc anywhere in the bar closes it; the bar's own keys never reach VS Code.
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
      }
    });
  }

  get visible(): boolean {
    return this.#open;
  }

  /** The query box's text, the replace box's text (tests). */
  get values(): { find: string; replace: string } {
    return { find: this.#find.value, replace: this.#replace.value };
  }

  /** The matches as the plugin has them (tests, the status text). */
  get state(): FindState | undefined {
    const view = this.#options.view();
    return view ? findKey.getState(view.state) : undefined;
  }

  /** Opens the bar (with the replace row when asked and the document can be edited), the words selected in the box. */
  open(request: { replace?: boolean; view?: EditorView } = {}): void {
    const view = request.view ?? this.#options.view();
    this.#open = true;
    this.element.hidden = false;
    this.#setReplacing(this.#options.editable() && (request.replace === true || this.#replacing));
    const { from, to, empty: none } = view?.state.selection ?? { from: 0, to: 0, empty: true };
    if (view && !none && to - from <= 200) {
      const text = view.state.doc.textBetween(from, to, '\n', '￼');
      if (text !== '' && !/[\n￼]/.test(text)) this.#find.value = text;
    }
    this.#find.focus();
    this.#find.select();
    this.#search();
    this.#options.onToggle?.(true);
  }

  /** Closes the bar; the highlights go, the canvas takes the focus back (with the current match selected). */
  close(refocus = false): void {
    if (!this.#open) return;
    this.#open = false;
    this.element.hidden = true;
    const view = this.#options.view();
    if (view) this.#dispatch(view, view.state.tr.setMeta(findKey, { query: this.#find.value, options: this.#flags, active: false } satisfies FindMeta));
    if (refocus) view?.focus();
    this.#options.onToggle?.(false);
  }

  /** The text blocks that count as searchable changed (a diagram drawn or not), or the view became read-only. */
  refresh(): void {
    const view = this.#options.view();
    if (!this.#open) return;
    this.#setReplacing(this.#replacing && this.#options.editable());
    if (view) this.#dispatch(view, view.state.tr.setMeta(findKey, { recompute: true } satisfies FindMeta));
    this.#updateCount();
  }

  /** The next (1) or previous (-1) match, wrapping; selected and scrolled into view. */
  step(direction: 1 | -1): void {
    const view = this.#options.view();
    const state = view && findKey.getState(view.state);
    if (!view || !state || state.ranges.length === 0) return;
    const next = (state.current + direction + state.ranges.length) % state.ranges.length;
    this.#goto(view, state, next);
  }

  /** Replaces the current match (the first one from the cursor when none is current), then moves to the next. */
  replaceCurrent(): void {
    const view = this.#options.view();
    const state = view && findKey.getState(view.state);
    if (!view || !state || !this.#options.editable() || state.ranges.length === 0) return;
    if (state.current < 0) return this.step(1);
    const range = state.ranges[state.current]!;
    const text = this.#replace.value;
    this.#dispatch(view, replaceInto(view.state.tr, view.state, [range], text));
    // The matches were found again by the change; go to the first one past the replacement.
    const after = findKey.getState(view.state)!;
    const index = indexFrom(after.ranges, range.from + text.length);
    if (index >= 0) this.#goto(view, after, index);
    this.#updateCount();
  }

  /** Replaces every match, as one edit (one undo step). */
  replaceAll(): void {
    const view = this.#options.view();
    const state = view && findKey.getState(view.state);
    if (!view || !state || !this.#options.editable() || state.ranges.length === 0) return;
    this.#dispatch(view, replaceInto(view.state.tr, view.state, state.ranges, this.#replace.value));
    this.#updateCount();
  }

  #goto(view: EditorView, state: FindState, index: number): void {
    const range = state.ranges[index];
    if (!range) return;
    const tr = view.state.tr.setMeta(findKey, { query: state.query, options: state.options, active: true, current: index } satisfies FindMeta);
    tr.setSelection(TextSelection.create(tr.doc, range.from, range.to)).scrollIntoView();
    this.#dispatch(view, tr);
    this.#updateCount();
  }

  #dispatch(view: EditorView, tr: Transaction): void {
    view.dispatch(tr);
  }

  #search(): void {
    const view = this.#options.view();
    if (!view) return;
    this.#dispatch(view, view.state.tr.setMeta(findKey, { query: this.#find.value, options: this.#flags, active: this.#open } satisfies FindMeta));
    const state = findKey.getState(view.state);
    // Typing goes to the first match from the cursor, like VS Code's find.
    if (state && state.current >= 0) this.#goto(view, state, state.current);
    this.#updateCount();
  }

  #flip(flag: keyof FindOptions): void {
    this.#flags = { ...this.#flags, [flag]: !this.#flags[flag] };
    this.#toggles[flag].setAttribute('aria-pressed', String(this.#flags[flag]));
    this.#search();
    this.#find.focus();
  }

  #setReplacing(on: boolean): void {
    this.#replacing = on;
    this.#replaceRow.hidden = !on || !this.#options.editable();
    this.#expand.hidden = !this.#options.editable();
    this.#expand.setAttribute('aria-pressed', String(on));
    this.#expand.title = on ? 'Hide replace' : 'Show replace';
    this.#expand.firstElementChild?.setAttribute('class', `codicon codicon-chevron-${on ? 'down' : 'right'}`);
  }

  #updateCount(): void {
    const state = this.state;
    const text = !state || state.query === '' ? '' : state.ranges.length === 0 ? 'No results' : `${state.current >= 0 ? state.current + 1 : '?'} of ${state.ranges.length}${state.capped ? '+' : ''}`;
    this.#count.textContent = text;
    const none = !state || state.ranges.length === 0;
    this.#replaceOne.disabled = none || !this.#options.editable();
    this.#replaceAll.disabled = none || !this.#options.editable();
  }

  #keydown(event: KeyboardEvent, box: 'find' | 'replace'): void {
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    const key = event.key.toLowerCase();
    if (mod && (key === 'f' || key === 'h')) {
      event.preventDefault();
      event.stopPropagation();
      if (key === 'h') {
        this.#setReplacing(this.#options.editable());
        if (this.#options.editable()) this.#replace.focus();
      } else {
        this.#find.focus();
        this.#find.select();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (box === 'replace') this.replaceCurrent();
      else this.step(event.shiftKey ? -1 : 1);
    }
  }
}

/** The bar's look: VS Code's own colors (editor UI). */
export const findBarCss = `
.pmd-find-host:focus { outline: none; }
.pmd-find { position: absolute; top: 4px; right: 24px; z-index: 20; display: flex; flex-direction: column; gap: 4px; padding: 6px; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.3)); font: 13px var(--vscode-font-family, sans-serif); }
.pmd-find[hidden], .pmd-find [hidden] { display: none; }
.pmd-find-row { display: flex; align-items: center; gap: 4px; }
.pmd-find input { width: 200px; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; font: inherit; }
.pmd-find input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pmd-find button { background: transparent; color: inherit; border: 1px solid transparent; border-radius: 3px; padding: 2px 4px; cursor: pointer; line-height: 1; }
.pmd-find button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
.pmd-find button:disabled { opacity: .4; cursor: default; }
.pmd-find button[aria-pressed="true"]:not(.pmd-find-expand) { background: var(--vscode-inputOption-activeBackground); border-color: var(--vscode-inputOption-activeBorder, transparent); color: var(--vscode-inputOption-activeForeground, inherit); }
.pmd-find :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pmd-find-count { min-width: 64px; text-align: center; opacity: .85; }
.pmd-find-replace-row { padding-left: 24px; }
.pmd-canvas .pmd-find-match { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, .33)); }
.pmd-canvas .pmd-find-current { background: var(--vscode-editor-findMatchBackground, rgba(162, 98, 6, .6)); outline: 1px solid var(--vscode-editor-findMatchBorder, transparent); }
`;
