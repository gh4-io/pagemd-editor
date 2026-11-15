// @pagemd-editor/selection-toolbar: the small bar that floats over selected text (P7): bold, italic, link, heading,
// quote, list and the other commands marked `toolbar: true`. It draws `registry.actions({ surface: 'toolbar' })`
// and hands a clicked Action to `run`. It knows no syntax.
import { TextSelection, Plugin, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { formatKeybinding, type Action, type ActionContext, type Registry } from '@pagemd-editor/core';

export interface SelectionToolbarOptions {
  registry: Registry;
  run(action: Action): void;
  context(): ActionContext | undefined;
  mac?: boolean;
}

/** Whether the bar shows for this state: some text is selected, outside code. Pure, so it can be tested without a DOM. */
export function toolbarVisible(state: EditorState, editable: boolean): boolean {
  const { selection } = state;
  if (!editable || selection.empty || !(selection instanceof TextSelection)) return false;
  return !selection.$from.parent.type.spec.code && !selection.$to.parent.type.spec.code;
}

export class SelectionToolbar {
  /** Add this to the canvas's `pmPlugins`. */
  readonly plugin: Plugin;
  readonly #options: SelectionToolbarOptions;
  #active = true;
  #bar: HTMLElement | undefined;
  #view: EditorView | undefined;
  #pending: number | undefined;
  readonly #buttons = new Map<string, HTMLElement>();
  #shownFor = '';
  readonly #onScroll = (): void => this.#schedule();

  constructor(options: SelectionToolbarOptions) {
    this.#options = options;
    this.plugin = new Plugin({
      view: (view) => {
        this.#view = view;
        const doc = view.dom.ownerDocument;
        const bar = doc.createElement('div');
        bar.className = 'pmd-selection-toolbar';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Text formatting');
        bar.hidden = true;
        // Keep the editor's selection while a button is pressed.
        bar.addEventListener('mousedown', (event) => event.preventDefault());
        bar.addEventListener('keydown', (event) => this.#onKey(event));
        doc.body.append(bar);
        this.#bar = bar;
        doc.addEventListener('scroll', this.#onScroll, true);
        this.#schedule(); // a new editor state (a document re-read) builds this again
        return {
          update: (v, previous) => {
            if (previous.doc.eq(v.state.doc) && previous.selection.eq(v.state.selection) && previous.storedMarks === v.state.storedMarks) return;
            this.#schedule();
          },
          destroy: () => {
            doc.removeEventListener('scroll', this.#onScroll, true);
            bar.remove();
            this.#bar = undefined;
            this.#view = undefined;
          },
        };
      },
    });
  }

  /** The view recipe switches the bar off (Read); a bar that is showing hides. */
  setActive(active: boolean): void {
    this.#active = active;
    if (!active && this.#bar) this.#bar.hidden = true;
  }

  get visible(): boolean {
    return !!this.#bar && !this.#bar.hidden;
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

  #sync(): void {
    const view = this.#view;
    const bar = this.#bar;
    if (!view || !bar) return;
    if (!this.#active || !toolbarVisible(view.state, view.editable)) {
      bar.hidden = true;
      return;
    }
    const context = this.#options.context();
    const actions = this.#options.registry.actions({ surface: 'toolbar', ...(context ? { context } : {}) });
    if (actions.length === 0) {
      bar.hidden = true;
      return;
    }
    const signature = actions.map((a) => a.id).join('|');
    if (signature !== this.#shownFor) {
      this.#shownFor = signature;
      this.#buttons.clear();
      // Icons only (P8, R-162), unless several buttons share an icon (the headings): then the short label goes with it.
      const shared = new Set(actions.map((a) => a.icon).filter((icon, i, all) => icon !== undefined && all.indexOf(icon) !== i));
      bar.replaceChildren(...actions.map((action, index) => this.#button(action, index === 0, !action.icon || shared.has(action.icon))));
    }
    for (const action of actions) {
      const button = this.#buttons.get(action.id);
      if (!button) continue;
      button.setAttribute('aria-disabled', String(!action.enabled));
      if (action.toggle) button.setAttribute('aria-pressed', String(action.active));
      else button.removeAttribute('aria-pressed');
    }
    bar.hidden = false;
    this.#position(view, bar);
  }

  #position(view: EditorView, bar: HTMLElement): void {
    const { from, to } = view.state.selection;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const win = bar.ownerDocument.defaultView;
    const centre = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
    const left = Math.max(4, Math.min(centre - width / 2, (win?.innerWidth ?? centre + width) - width - 4));
    const above = Math.min(start.top, end.top) - height - 6;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(above >= 4 ? above : Math.max(start.bottom, end.bottom) + 6)}px`;
  }

  #button(action: Action, first: boolean, withText: boolean): HTMLElement {
    const doc = this.#bar!.ownerDocument;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'pmd-selection-toolbar-button';
    button.dataset['command'] = action.id;
    button.replaceChildren(...(action.icon ? [codicon(doc, action.icon)] : []), ...(withText ? [doc.createTextNode(shortLabel(action))] : []));
    button.title = action.keybinding ? `${action.label} (${formatKeybinding(action.keybinding, this.#options.mac ?? false)})` : action.label;
    // The name starts with the visible text ("H2 (Heading 2)"): WCAG 2.5.3, so voice control and screen readers agree.
    button.setAttribute('aria-label', withText && shortLabel(action) !== action.label ? `${shortLabel(action)} (${action.label})` : action.label);
    if (action.toggle) button.setAttribute('aria-pressed', 'false');
    button.tabIndex = first ? 0 : -1; // one tab stop; the arrow keys move inside the bar
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      this.#options.run(action);
    });
    this.#buttons.set(action.id, button);
    return button;
  }

  #onKey(event: KeyboardEvent): void {
    const bar = this.#bar;
    if (!bar) return;
    const buttons = [...bar.querySelectorAll<HTMLElement>('button')];
    const at = buttons.indexOf(bar.ownerDocument.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowRight') next = (at + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (at - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'Escape') {
      this.#view?.focus();
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    buttons.forEach((b, i) => (b.tabIndex = i === next ? 0 : -1));
    buttons[next]!.focus();
  }
}

/** VS Code's own icon (codicons, R-162; the app loads the font). Hidden from screen readers: the text says it. */
function codicon(doc: Document, name: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = `codicon codicon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/** A compact button label: "Heading 2" becomes "H2", "Bulleted list" stays as it is. */
export function shortLabel(action: Action): string {
  const heading = /^Heading (\d)$/.exec(action.label);
  return heading ? `H${heading[1]}` : action.label;
}

/** Editor UI, so it uses the VS Code theme variables. */
export const selectionToolbarCss = `
.pmd-selection-toolbar { position: fixed; font-family: var(--vscode-font-family); z-index: 30; display: flex; flex-wrap: wrap; gap: 2px; max-width: 90vw; padding: 3px; font-size: 12px;
  background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 4px; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.3)); }
.pmd-selection-toolbar[hidden] { display: none; }
.pmd-selection-toolbar-button { font: inherit; color: inherit; background: transparent; border: 1px solid transparent; border-radius: 3px; padding: 2px 5px; cursor: pointer; display: inline-flex; align-items: center; gap: 2px; }
.pmd-selection-toolbar .codicon { font-size: 14px; }
.pmd-selection-toolbar-button:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
.pmd-selection-toolbar-button[aria-pressed="true"] { background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); border-color: var(--vscode-focusBorder, transparent); }
.pmd-selection-toolbar-button[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.pmd-selection-toolbar-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
`;
