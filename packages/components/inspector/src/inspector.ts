// The Inspector (P8, R-3): a panel on the right of the editor with two tabs. Element: the settings of what is selected
// (the registry's `fieldsFor`: a link, the selected item, then the items around it). Document: the document's
// properties (the frontmatter, ADR-0016). It knows no syntax: fields and values in, `applyFields` /
// `registry.properties` out, each change one transaction (one undo step).
import { keepFocus } from './focus.ts';
import type { FieldTarget, Registry } from '@pagemd-editor/core';
import { Plugin, type EditorState, type Transaction } from 'prosemirror-state';
import { icon, iconButton, renderFields } from './form.ts';
import type { PropertyHints } from './model.ts';
import { PropertiesForm, readOnlyNote } from './properties.ts';

export type InspectorTab = 'element' | 'document';

export interface InspectorOptions {
  registry: Registry;
  /** The editor's state now; undefined before the canvas exists. */
  state(): EditorState | undefined;
  /** False in Read: everything is shown, nothing can be changed. */
  editable(): boolean;
  /** Why it is read-only now (Read, Print Preview): said at the top of both tabs. */
  readOnlyNote?(): string | undefined;
  /** Runs `change` on a new transaction of the editor and dispatches it when it returns true. */
  edit(change: (tr: Transaction) => boolean): void;
  hints(): PropertyHints;
  pickFile?(extensions?: readonly string[]): Promise<string | undefined>;
  /** The close button was pressed. */
  onClose(): void;
  /**
   * P15: the focus went into a list row of the Element tab (`field` is its path, e.g. "markers.2"), so the canvas can select
   * the shape that row describes.
   */
  onFocusField?(field: string): void;
}

export class Inspector {
  readonly element: HTMLElement;
  /** Add to the canvas's `pmPlugins`: the panel follows the selection and the document. */
  readonly plugin: Plugin;
  readonly #o: InspectorOptions;
  readonly #doc: Document;
  readonly #tabs: Record<InspectorTab, HTMLButtonElement>;
  readonly #panel: HTMLElement;
  readonly #element: HTMLElement;
  readonly #properties: PropertiesForm;
  #tab: InspectorTab = 'element';
  #elementKey = '';
  #pending: number | undefined;
  /** The list row shown as the canvas's selection (P15), e.g. "markers.2". */
  #marked: string | null = null;

  constructor(parent: HTMLElement, options: InspectorOptions) {
    this.#o = options;
    const d = (this.#doc = parent.ownerDocument);
    this.element = d.createElement('aside');
    this.element.className = 'pmd-inspector';
    this.element.setAttribute('aria-label', 'Inspector');
    const head = d.createElement('div');
    head.className = 'pmd-insp-head';
    const tablist = d.createElement('div');
    tablist.className = 'pmd-insp-tabs';
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Inspector');
    const tab = (id: InspectorTab, label: string, iconName: string): HTMLButtonElement => {
      const button = d.createElement('button');
      button.type = 'button';
      button.id = `pmd-insp-tab-${id}`;
      button.className = 'pmd-insp-tab';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', 'pmd-insp-panel');
      button.append(icon(d, iconName), d.createTextNode(` ${label}`));
      button.addEventListener('click', () => this.show(id));
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next: InspectorTab = id === 'element' ? 'document' : 'element';
        this.show(next);
        this.#tabs[next].focus();
      });
      tablist.append(button);
      return button;
    };
    this.#tabs = { element: tab('element', 'Element', 'symbol-property'), document: tab('document', 'Document', 'file') };
    head.append(tablist, iconButton(d, 'close', 'Close the Inspector', () => options.onClose()));
    this.#panel = d.createElement('div');
    this.#panel.className = 'pmd-insp-panel';
    this.#panel.id = 'pmd-insp-panel';
    this.#panel.setAttribute('role', 'tabpanel');
    this.#element = d.createElement('div');
    this.#element.className = 'pmd-insp-element';
    this.#properties = new PropertiesForm(d, {
      registry: options.registry,
      edit: options.edit,
      hints: options.hints,
      readOnly: () => !options.editable(),
      ...(options.readOnlyNote ? { readOnlyNote: options.readOnlyNote } : {}),
      ...(options.pickFile ? { pickFile: options.pickFile } : {}),
      idPrefix: 'pmd-insp-doc',
    });
    this.#panel.append(this.#element, this.#properties.element);
    this.#element.addEventListener('focusin', (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-row]') : null;
      if (row?.dataset['row']) options.onFocusField?.(row.dataset['row']);
    });
    this.element.append(head, this.#panel);
    parent.append(this.element);
    this.plugin = new Plugin({
      view: () => {
        this.update();
        return {
          update: (view, previous) => {
            if (previous.doc.eq(view.state.doc) && previous.selection.eq(view.state.selection)) return;
            this.update();
          },
        };
      },
    });
    this.#select('element');
  }

  get tab(): InspectorTab {
    return this.#tab;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** Shows the panel on `tab`; with `field`, focuses that field's box (e.g. a new FIGURE's caption, P11). */
  show(tab: InspectorTab = this.#tab, field?: string): void {
    this.element.hidden = false;
    this.#select(tab);
    this.refresh();
    if (field) this.#panel.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"] input, [data-field="${CSS.escape(field)}"] select, [data-property="${CSS.escape(field)}"] input`)?.focus();
  }

  hide(): void {
    this.element.hidden = true;
  }

  /**
   * P15: shows the list row `field` (e.g. "markers.2") as the one selected on the canvas, scrolled into view; null clears it.
   * Kept across redraws until changed.
   */
  mark(field: string | null): void {
    this.#marked = field;
    this.#applyMark(true);
  }

  #applyMark(scroll: boolean): void {
    for (const row of this.#element.querySelectorAll<HTMLElement>('.pmd-insp-row-marked')) {
      row.classList.remove('pmd-insp-row-marked');
      row.removeAttribute('aria-current');
    }
    if (!this.#marked) return;
    const row = this.#element.querySelector<HTMLElement>(`[data-row="${CSS.escape(this.#marked)}"]`);
    if (!row) return;
    row.classList.add('pmd-insp-row-marked');
    row.setAttribute('aria-current', 'true');
    if (scroll) row.scrollIntoView?.({ block: 'nearest' });
  }

  /** Redraws now (the hints or the editable state changed). */
  refresh(): void {
    this.#elementKey = '';
    this.#draw(true);
  }

  /** Redraws on the next frame (the selection or document changed), at most once per frame. */
  update(): void {
    if (this.#pending !== undefined || this.element.hidden) return;
    const win = this.#doc.defaultView;
    const run = (): void => {
      this.#pending = undefined;
      this.#draw(false);
    };
    this.#pending = win ? win.requestAnimationFrame(run) : (setTimeout(run, 0) as unknown as number);
  }

  destroy(): void {
    if (this.#pending !== undefined) this.#doc.defaultView?.cancelAnimationFrame(this.#pending);
    this.element.remove();
  }

  #select(tab: InspectorTab): void {
    this.#tab = tab;
    for (const [id, button] of Object.entries(this.#tabs) as [InspectorTab, HTMLButtonElement][]) {
      button.setAttribute('aria-selected', String(id === tab));
      button.tabIndex = id === tab ? 0 : -1;
    }
    this.#panel.setAttribute('aria-labelledby', `pmd-insp-tab-${tab}`);
    this.#element.hidden = tab !== 'element';
    this.#properties.element.hidden = tab !== 'document';
  }

  #draw(force: boolean): void {
    const state = this.#o.state();
    if (!state || this.element.hidden) return;
    if (this.#tab === 'document') {
      this.#properties.render(state.doc, force);
      return;
    }
    const targets = this.#o.registry.fieldsFor(state);
    const why = this.#o.editable() ? undefined : this.#o.readOnlyNote?.();
    const key = JSON.stringify([targets, this.#o.editable(), why], (_k, v: unknown) => (v instanceof Date ? `D${v.toISOString()}` : v));
    if (!force && key === this.#elementKey) return;
    this.#elementKey = key;
    const d = this.#doc;
    if (targets.length === 0) {
      const empty = d.createElement('div');
      empty.className = 'pmd-insp-empty';
      empty.textContent = 'Select something on the page to see its settings.';
      keepFocus(this.#element, () => this.#element.replaceChildren(empty), () => this.#tabs.element);
      return;
    }
    keepFocus(this.#element, () => this.#element.replaceChildren(...(why ? [readOnlyNote(d, why)] : []), ...targets.map((target, index) => this.#target(target, index))), () => this.#tabs.element);
    this.#applyMark(false);
  }

  #target(target: FieldTarget, index: number): HTMLElement {
    const d = this.#doc;
    const box = d.createElement('section');
    box.className = 'pmd-insp-target';
    box.dataset['target'] = target.name;
    const title = d.createElement('h3');
    title.className = 'pmd-insp-title';
    title.textContent = target.label;
    box.append(title);
    for (const section of target.sections) {
      if (target.sections.length > 1) {
        const sub = d.createElement('h4');
        sub.className = 'pmd-insp-subtitle';
        sub.textContent = section.label;
        box.append(sub);
      }
      box.append(
        renderFields(d, section.fields, section.values, (values) => this.#o.edit((tr) => this.#o.registry.applyFields(tr, target, section.id, values)), {
          readOnly: !this.#o.editable(),
          ...(this.#o.pickFile ? { pickFile: this.#o.pickFile } : {}),
          idPrefix: `pmd-insp-${index}-${section.id}`,
          ...(section.rowNotes ? { rowNotes: section.rowNotes } : {}),
        }),
      );
    }
    return box;
  }
}
