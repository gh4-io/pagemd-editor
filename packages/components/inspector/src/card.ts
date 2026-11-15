// The document-properties card (P8, R-4): the frontmatter on the canvas, a collapsible card at the top of the page with
// the same form as the Inspector's Document tab. A node view the app gives the canvas for the frontmatter node; it
// edits through `registry.properties` like the Document tab (one transaction per change).
import type { Registry } from '@pagemd-editor/core';
import type { Node } from 'prosemirror-model';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { icon } from './form.ts';
import type { PropertyHints } from './model.ts';
import { PropertiesForm } from './properties.ts';

export interface CardOptions {
  registry: Registry;
  hints(): PropertyHints;
  /** Why the card can't be changed now (Read): said at the top of its form. */
  readOnlyNote?(): string | undefined;
  pickFile?(extensions?: readonly string[]): Promise<string | undefined>;
}

export interface FrontmatterCards {
  /** The node view constructor for the frontmatter node. */
  nodeView: NodeViewConstructor;
  /** Redraws every card (the hints changed). */
  refresh(): void;
  /** Opens or closes the card(s). */
  setExpanded(expanded: boolean): void;
}

/** Cards share their open/closed state: a document re-read (a new node view) keeps it. */
export function frontmatterCards(options: CardOptions): FrontmatterCards {
  const live = new Set<Card>();
  let expanded = false;
  const nodeView: NodeViewConstructor = (node, view) => {
    const card = new Card(node, view, options, () => expanded, (next) => {
      expanded = next;
      for (const c of live) c.draw(true);
    });
    live.add(card);
    card.onDestroy = () => live.delete(card);
    return card;
  };
  return {
    nodeView,
    refresh: () => {
      for (const card of live) card.draw(true);
    },
    setExpanded: (next) => {
      expanded = next;
      for (const card of live) card.draw(true);
    },
  };
}

class Card implements NodeView {
  readonly dom: HTMLElement;
  onDestroy: (() => void) | undefined;
  #node: Node;
  readonly #view: EditorView;
  readonly #toggle: HTMLButtonElement;
  readonly #summary: HTMLElement;
  readonly #form: PropertiesForm;
  readonly #expanded: () => boolean;
  readonly #setExpanded: (expanded: boolean) => void;
  readonly #options: CardOptions;

  constructor(node: Node, view: EditorView, options: CardOptions, expanded: () => boolean, setExpanded: (expanded: boolean) => void) {
    this.#node = node;
    this.#view = view;
    this.#options = options;
    this.#expanded = expanded;
    this.#setExpanded = setExpanded;
    const d = view.dom.ownerDocument;
    this.dom = d.createElement('div');
    this.dom.className = 'pmd-fm-card';
    this.dom.contentEditable = 'false';
    const head = d.createElement('div');
    head.className = 'pmd-fm-head';
    this.#toggle = d.createElement('button');
    this.#toggle.type = 'button';
    this.#toggle.className = 'pmd-fm-toggle';
    this.#toggle.addEventListener('click', () => this.#setExpanded(!this.#expanded()));
    this.#summary = d.createElement('span');
    this.#summary.className = 'pmd-fm-summary';
    head.append(this.#toggle, this.#summary);
    this.#form = new PropertiesForm(d, {
      registry: options.registry,
      edit: (change) => {
        const tr = this.#view.state.tr;
        if (change(tr)) this.#view.dispatch(tr);
      },
      hints: options.hints,
      readOnly: () => !this.#view.editable,
      ...(options.readOnlyNote ? { readOnlyNote: options.readOnlyNote } : {}),
      ...(options.pickFile ? { pickFile: options.pickFile } : {}),
      idPrefix: 'pmd-fm',
    });
    this.dom.append(head, this.#form.element);
    this.draw(true);
  }

  draw(force: boolean): void {
    const open = this.#expanded();
    const d = this.dom.ownerDocument;
    this.#toggle.replaceChildren(icon(d, open ? 'chevron-down' : 'chevron-right'), d.createTextNode(' Document properties'));
    this.#toggle.setAttribute('aria-expanded', String(open));
    const state = this.#options.registry.properties?.read(this.#view.state.doc) ?? null;
    const title = state?.entries.find((e) => e.key === 'title')?.value;
    const count = state?.entries.length ?? 0;
    this.#summary.textContent = state?.error ? 'cannot be read' : [typeof title === 'string' && title ? title : '', `${count} ${count === 1 ? 'property' : 'properties'}`].filter(Boolean).join(' · ');
    this.#form.element.hidden = !open;
    if (open) this.#form.render(this.#view.state.doc, force);
  }

  update(node: Node): boolean {
    if (node.type !== this.#node.type) return false;
    const changed = node !== this.#node;
    this.#node = node;
    if (changed) this.draw(false);
    return true;
  }

  /** The card's own controls handle their events; ProseMirror stays out of them. */
  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.onDestroy?.();
  }
}
