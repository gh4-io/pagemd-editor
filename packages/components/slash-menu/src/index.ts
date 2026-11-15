// @pagemd-editor/slash-menu: type "/" in a text block and a searchable list of everything that can be inserted opens
// under the cursor (P7). The list is `registry.actions({ surface: 'slash', search })`; picking an entry hands the
// Action to `run` with a `prepare` that removes the typed "/query" in the SAME transaction as the insert, so one undo
// step takes back both. It knows no syntax.
import { Plugin, PluginKey, type EditorState, type Selection, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Action, ActionContext, Registry, RunOptions } from '@pagemd-editor/core';

export interface SlashMenuOptions {
  registry: Registry;
  /** Runs an action (the action runner) with the options it needs to remove the typed text. */
  run(action: Action, options: RunOptions): void;
  context(): ActionContext | undefined;
  /** How many entries to show at most. */
  limit?: number;
}

/** The "/query" before the cursor, if the cursor is in a place the menu opens. */
export interface SlashQuery {
  /** Position of the "/". */
  from: number;
  /** The cursor. */
  to: number;
  query: string;
}

const TRIGGER = /(?:^|\s)\/([^\s/]{0,30})$/;

/** Where the slash menu is open: pure, so it can be tested without a DOM. Never inside code or a raw block. */
export function slashQuery(state: EditorState): SlashQuery | null {
  return slashQueryAt(state.selection);
}

/** The same, for a selection (a transaction's selection too, when the slash text has to be found again later). */
export function slashQueryAt(selection: Selection): SlashQuery | null {
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || !parent.inlineContent || parent.type.spec.code) return null;
  // Leaf nodes (an inline atom) count as one non-space character, so "[[x]]/" doesn't open the menu.
  const before = parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const match = TRIGGER.exec(before);
  if (!match) return null;
  const query = match[1]!;
  return { from: $from.pos - query.length - 1, to: $from.pos, query };
}

/** The entry to highlight after an arrow key (wraps around). */
export const moveHighlight = (current: number, step: number, count: number): number => (count === 0 ? 0 : (((current + step) % count) + count) % count);

/** What a gated entry says next to its label, or undefined. */
export const gateHint = (action: Action): string | undefined => (action.gate && !action.gate.satisfied ? `needs ${action.gate.field}` : undefined);

const key = new PluginKey('pmd-slash-menu');

export class SlashMenu {
  /** Add this to the canvas's `pmPlugins`. */
  readonly plugin: Plugin;
  readonly #options: SlashMenuOptions;
  #active = true;
  #highlight = 0;
  #entries: Action[] = [];
  /** After Escape: the "/" position the menu stays closed for. */
  #dismissed: number | undefined;
  #popup: HTMLElement | undefined;
  #view: EditorView | undefined;
  #pending: number | undefined;
  #lastState: EditorState | undefined;
  /** The editing area's role before the list opened. */
  #roleBefore: string | null = null;

  constructor(options: SlashMenuOptions) {
    this.#options = options;
    this.plugin = new Plugin({
      key,
      props: { handleKeyDown: (view, event) => this.#onKey(view, event) },
      view: (view) => {
        this.#view = view;
        const popup = view.dom.ownerDocument.createElement('div');
        popup.className = 'pmd-slash';
        popup.id = 'pmd-slash-list';
        popup.setAttribute('role', 'listbox');
        popup.setAttribute('aria-label', 'Insert');
        popup.hidden = true;
        view.dom.ownerDocument.body.append(popup);
        this.#popup = popup;
        this.#schedule(); // a new editor state (a document re-read) builds this again
        return {
          update: (v, previous) => {
            if (previous.doc.eq(v.state.doc) && previous.selection.eq(v.state.selection)) return;
            this.#schedule();
          },
          destroy: () => {
            this.#hide();
            popup.remove();
            this.#popup = undefined;
            this.#view = undefined;
          },
        };
      },
    });
  }

  /** The view recipe switches the menu off (Read, Code); a menu that is open closes. */
  setActive(active: boolean): void {
    this.#active = active;
    if (!active) this.#hide();
  }

  get open(): boolean {
    return !!this.#popup && !this.#popup.hidden;
  }

  #schedule(): void {
    if (this.#pending !== undefined) return;
    const win = this.#view?.dom.ownerDocument.defaultView;
    const go = (): void => {
      this.#pending = undefined;
      this.#sync();
    };
    this.#pending = win ? win.requestAnimationFrame(go) : (setTimeout(go, 0) as unknown as number);
  }

  /** Opens, updates or closes the list to match the editor's state. */
  #sync(): void {
    const view = this.#view;
    if (!view || !this.#popup) return;
    const found = this.#active && view.editable ? slashQuery(view.state) : null;
    if (!found || found.from === this.#dismissed) {
      if (!found) this.#dismissed = undefined;
      this.#hide();
      return;
    }
    const context = this.#options.context();
    const actions = this.#options.registry.actions({ surface: 'slash', search: found.query, ...(context ? { context } : {}) }).filter((a) => a.enabled);
    const entries = actions.slice(0, this.#options.limit ?? 12);
    if (entries.length === 0) {
      this.#hide();
      return;
    }
    const same = entries.length === this.#entries.length && entries.every((a, i) => a.id === this.#entries[i]!.id);
    // The highlighted entry stays highlighted while it is still listed (P18: an arrow key pressed before the list caught up with
    // the last typed letter used to be undone by that catch-up).
    const highlighted = this.open ? this.#entries[this.#highlight]?.id : undefined;
    this.#entries = entries;
    if (!this.open) this.#highlight = 0;
    else if (!same) this.#highlight = Math.max(0, highlighted === undefined ? 0 : entries.findIndex((a) => a.id === highlighted));
    this.#draw(view, found);
  }

  #draw(view: EditorView, found: SlashQuery): void {
    const popup = this.#popup!;
    const doc = popup.ownerDocument;
    popup.replaceChildren(
      ...this.#entries.map((action, index) => {
        const option = doc.createElement('div');
        option.className = 'pmd-slash-option';
        option.id = `pmd-slash-option-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === this.#highlight));
        const label = doc.createElement('span');
        label.className = 'pmd-slash-label';
        if (action.icon) label.append(codicon(doc, action.icon));
        label.append(doc.createTextNode(action.label));
        option.append(label);
        const hint = gateHint(action);
        if (hint) {
          const note = doc.createElement('span');
          note.className = 'pmd-slash-hint';
          note.textContent = hint;
          option.append(note);
        }
        option.addEventListener('mousedown', (event) => event.preventDefault());
        option.addEventListener('click', () => this.#accept(index));
        return option;
      }),
    );
    popup.hidden = false;
    const coords = view.coordsAtPos(found.to);
    popup.style.left = `${Math.round(coords.left)}px`;
    const below = coords.bottom + 4;
    const height = popup.offsetHeight;
    const win = doc.defaultView;
    popup.style.top = `${Math.round(win && below + height > win.innerHeight && coords.top - height - 4 > 0 ? coords.top - height - 4 : below)}px`;
    // The editing area is a combobox while the list is open (ARIA 1.2): it owns the list, says it is expanded, and
    // names the highlighted option; focus stays in the text.
    if (view.dom.getAttribute('role') !== 'combobox') this.#roleBefore = view.dom.getAttribute('role'); // the canvas's own "textbox" (P13b)
    view.dom.setAttribute('role', 'combobox');
    view.dom.removeAttribute('aria-multiline'); // a combobox has no such property; back with the text box (#hide)
    view.dom.setAttribute('aria-expanded', 'true');
    view.dom.setAttribute('aria-haspopup', 'listbox');
    view.dom.setAttribute('aria-autocomplete', 'list');
    view.dom.setAttribute('aria-controls', popup.id);
    view.dom.setAttribute('aria-activedescendant', `pmd-slash-option-${this.#highlight}`);
    popup.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }

  #hide(): void {
    this.#entries = [];
    if (this.#popup) this.#popup.hidden = true;
    const dom = this.#view?.dom;
    if (dom?.getAttribute('role') === 'combobox') {
      // the editing area is a text box again (P13b: the canvas names its role; it used to have none)
      if (this.#roleBefore) dom.setAttribute('role', this.#roleBefore);
      else dom.removeAttribute('role');
      if (this.#roleBefore === 'textbox') dom.setAttribute('aria-multiline', 'true');
    }
    for (const name of ['aria-expanded', 'aria-haspopup', 'aria-autocomplete', 'aria-controls', 'aria-activedescendant']) dom?.removeAttribute(name);
  }

  #onKey(view: EditorView, event: KeyboardEvent): boolean {
    if (!this.open || this.#entries.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      this.#highlight = moveHighlight(this.#highlight, event.key === 'ArrowDown' ? 1 : -1, this.#entries.length);
      const found = slashQuery(view.state);
      if (found) this.#draw(view, found);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      this.#accept(this.#highlight);
      return true;
    }
    if (event.key === 'Escape') {
      this.#dismissed = slashQuery(view.state)?.from;
      this.#hide();
      return true;
    }
    return false;
  }

  #accept(index: number): void {
    const view = this.#view;
    const action = this.#entries[index];
    const found = view && slashQuery(view.state);
    if (!view || !action || !found) return;
    this.#hide();
    // Picking may wait for a prompt (a gated item), and the document can change meanwhile: the "/query" is found again
    // in the transaction's own document, and if it is gone nothing is deleted and nothing is inserted.
    this.#options.run(action, {
      prepare: (tr: Transaction) => {
        const now = slashQueryAt(tr.selection);
        if (!now || now.query !== found.query) return false;
        tr.delete(now.from, now.to);
        return true;
      },
    });
  }
}

/** VS Code's own icon (codicons, R-162; the app loads the font). Hidden from screen readers: the text says it. */
function codicon(doc: Document, name: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = `codicon codicon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/** Editor UI, so it uses the VS Code theme variables. */
export const slashMenuCss = `
.pmd-slash { position: fixed; font-family: var(--vscode-font-family); z-index: 30; min-width: 16em; max-width: 24em; max-height: 18em; overflow: auto; padding: 4px; font-size: 13px;
  background: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background)); color: var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-widget-border, transparent)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.3)); }
.pmd-slash[hidden] { display: none; }
.pmd-slash-label { display: inline-flex; align-items: center; gap: 6px; }
.pmd-slash-option { display: flex; justify-content: space-between; gap: 1em; padding: 3px 8px; cursor: pointer; border-radius: 3px; }
.pmd-slash-option[aria-selected="true"] { background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground)); }
.pmd-slash-hint { color: var(--vscode-editorWarning-foreground); font-size: 11px; }
`;
