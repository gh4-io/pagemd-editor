// Footnotes (P26, R-245): `text[^label]`, an inline note `^[text]`, and the note `[^label]: text` (more paragraphs indented
// by four spaces). Read and written by @pagemd/syntax's `footnotes` item (markdown-it-footnote with its editor-mode shim: the
// note stays where it is written). On the canvas a reference is a small raised number that links to its note; a note is a
// block, drawn where it is written, with its number and a back-link to the first reference. Numbers follow the order of the
// first references, as pagemd prints them (a second reference to one note reads "[2:1]", as pagemd's). pagemd's PDF prints
// the notes at the end of the document (as GitHub does); Word prints footnotes at the bottom of each page (not built, AD-P26-04).
import type { Node } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from 'prosemirror-view';
import type { CommandSpec, SyntaxItem, TokenSpec } from '@pagemd-editor/core';
import { inlineWriter, wrapperWriter } from '../shared/write.ts';

export const FOOTNOTE_REF = 'pmd_footnote_ref';
export const FOOTNOTE = 'pmd_footnote';

type Data = Record<string, unknown>;
const dataOf = (node: Node): Data => (node.attrs['data'] as Data | undefined) ?? {};
const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
const pmdData = (tok: { meta: unknown }): Data => ({ ...((tok.meta as { pmd?: { data: Data } } | null)?.pmd?.data ?? {}) });
const labelOf = (node: Node): string => str(dataOf(node)['label']);
const isInline = (node: Node): boolean => dataOf(node)['form'] === 'inline';

/** What the canvas shows for one reference or note (from the numbering). */
export interface FootnoteMark {
  /** The reference's caption, `[1]` or `[2:1]`; a note's number; null: no number (see `problem`). */
  caption: string | null;
  /** Why it has no number, in plain words (a reference with no note, a note nothing refers to, a note written twice). */
  problem?: string;
}

/** The numbering of the whole document, as pagemd gives it: by first reference, inline notes in their place. */
export function footnoteNumbers(doc: Node): Map<number, FootnoteMark> {
  const out = new Map<number, FootnoteMark>();
  const notes = new Map<string, number[]>();
  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE) notes.set(labelOf(node), [...(notes.get(labelOf(node)) ?? []), pos]);
    return true;
  });
  const numbers = new Map<string, number>();
  const seen = new Map<string, number>();
  let count = 0;
  doc.descendants((node, pos) => {
    if (node.type.name !== FOOTNOTE_REF) return true;
    if (isInline(node)) {
      out.set(pos, { caption: `[${++count}]` });
      return false;
    }
    const label = labelOf(node);
    if (!notes.has(label)) {
      out.set(pos, { caption: null, problem: `No note [^${label}]: … in the document, so pagemd prints this reference as text` });
      return false;
    }
    if (!numbers.has(label)) numbers.set(label, ++count);
    const sub = seen.get(label) ?? 0;
    seen.set(label, sub + 1);
    out.set(pos, { caption: sub > 0 ? `[${numbers.get(label)}:${sub}]` : `[${numbers.get(label)}]` });
    return false;
  });
  for (const [label, places] of notes) {
    places.forEach((pos, i) => {
      if (i < places.length - 1) out.set(pos, { caption: null, problem: `Another note [^${label}] comes later; pagemd prints only the last one` });
      else if (numbers.has(label)) out.set(pos, { caption: String(numbers.get(label)) });
      else out.set(pos, { caption: null, problem: `Nothing refers to [^${label}], so pagemd leaves this note out` });
    });
  }
  return out;
}

const footnotesKey = new PluginKey<{ set: DecorationSet; any: boolean }>('pmd-footnotes');

const hasFootnotes = (doc: Node, from = 0, to = doc.content.size): boolean => {
  let found = false;
  doc.nodesBetween(Math.max(0, from), Math.min(to, doc.content.size), (node) => {
    if (found) return false;
    if (node.type.name === FOOTNOTE_REF || node.type.name === FOOTNOTE) found = true;
    return !found;
  });
  return found;
};

function decorations(doc: Node): DecorationSet {
  const marks = footnoteNumbers(doc);
  const decos: Decoration[] = [];
  for (const [pos, mark] of marks) {
    const node = doc.nodeAt(pos);
    if (!node) continue;
    decos.push(Decoration.node(pos, pos + node.nodeSize, mark.problem ? { class: 'pmd-footnote-problem' } : {}, { footnote: mark }));
  }
  return DecorationSet.create(doc, decos);
}

/**
 * The numbers on the canvas (one decoration per reference and note, read by their node views). Only documents with footnotes
 * pay for it: a change that brings none in, in a document that had none, keeps the empty set (the 400-page keystroke budget).
 */
export function footnotesPlugin(): Plugin {
  return new Plugin<{ set: DecorationSet; any: boolean }>({
    key: footnotesKey,
    state: {
      init: (_config, state) => {
        const any = hasFootnotes(state.doc);
        return { any, set: any ? decorations(state.doc) : DecorationSet.empty };
      },
      apply: (tr, value) => {
        if (!tr.docChanged) return value;
        if (!value.any) {
          let touched = false;
          tr.mapping.maps.forEach((map, i) => {
            map.forEach((_a, _b, start, end) => {
              const rest = tr.mapping.slice(i + 1);
              if (!touched && hasFootnotes(tr.doc, rest.map(start, -1), rest.map(end, 1))) touched = true;
            });
          });
          if (!touched) return value;
        }
        const any = hasFootnotes(tr.doc);
        return { any, set: any ? decorations(tr.doc) : DecorationSet.empty };
      },
    },
    props: { decorations: (state) => footnotesKey.getState(state)?.set ?? DecorationSet.empty },
    // Word: deleting a footnote's reference deletes its note too (in the same undo step). A cut keeps the note, so pasting the
    // reference back finds it again (Word moves the note with a cut and pasted reference).
    appendTransaction: (trs, oldState, newState) => {
      if (!trs.some((tr) => tr.docChanged) || trs.some((tr) => tr.getMeta('uiEvent') === 'cut')) return null;
      if (!footnotesKey.getState(oldState)?.any) return null;
      const before = refCounts(oldState.doc);
      const after = refCounts(newState.doc);
      const gone = [...before.keys()].filter((label) => !after.has(label));
      if (gone.length === 0) return null;
      const notes: { pos: number; size: number }[] = [];
      newState.doc.descendants((node, pos) => {
        if (node.type.name === FOOTNOTE && gone.includes(labelOf(node))) notes.push({ pos, size: node.nodeSize });
        return node.type.name !== FOOTNOTE;
      });
      if (notes.length === 0) return null;
      const tr = newState.tr;
      try {
        for (const note of notes.reverse()) tr.delete(note.pos, note.pos + note.size);
      } catch {
        return null; // (a note that is the document's only block stays)
      }
      return tr;
    },
  });
}

/** How many references each label has. */
function refCounts(doc: Node): Map<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name === FOOTNOTE_REF && !isInline(node)) counts.set(labelOf(node), (counts.get(labelOf(node)) ?? 0) + 1);
    return true;
  });
  return counts;
}

const markOf = (decorations: readonly Decoration[]): FootnoteMark | null => {
  for (const d of decorations) {
    const mark = (d.spec as { footnote?: FootnoteMark }).footnote;
    if (mark) return mark;
  }
  return null;
};

/** Where the note for `label` is (the last one with that label: the one pagemd prints), or -1. */
function notePos(doc: Node, label: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE && labelOf(node) === label) at = pos;
    return node.type.name !== FOOTNOTE;
  });
  return at;
}

/** Where the first reference to `label` is, or -1. */
function firstRefPos(doc: Node, label: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.type.name === FOOTNOTE_REF && !isInline(node) && labelOf(node) === label) at = pos;
    return true;
  });
  return at;
}

function jump(view: EditorView, tr: Transaction): void {
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** A reference: `<sup class="footnote-ref"><a href="#fn1">[1]</a></sup>`, as pagemd writes it; a click goes to the note. */
class FootnoteRefView implements NodeView {
  readonly dom: HTMLElement;
  readonly #link: HTMLAnchorElement;
  #node: Node;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[]) {
    this.#node = node;
    this.dom = document.createElement('sup');
    this.dom.className = 'footnote-ref';
    this.dom.contentEditable = 'false';
    this.#link = document.createElement('a');
    this.dom.append(this.#link);
    this.#draw(decorations);
    this.#link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey) return; // the canvas's own link handling
      event.preventDefault();
      event.stopPropagation();
      const pos = getPos();
      if (pos === undefined) return;
      const { state } = view;
      if (isInline(this.#node)) {
        // An inline note has no block of its own: the reference is selected, so the Inspector shows its text
        jump(view, state.tr.setSelection(NodeSelection.create(state.doc, pos)));
        return;
      }
      const note = notePos(state.doc, labelOf(this.#node));
      if (note >= 0) jump(view, state.tr.setSelection(TextSelection.near(state.doc.resolve(note + 1))));
    });
  }

  #draw(decorations: readonly Decoration[]): void {
    const mark = markOf(decorations);
    const label = labelOf(this.#node);
    this.#link.textContent = mark?.caption ?? (isInline(this.#node) ? '[?]' : `[^${label}]`);
    this.#link.setAttribute('href', isInline(this.#node) ? '#' : `#fn-${label}`);
    const text = isInline(this.#node) ? str(dataOf(this.#node)['content']) : '';
    const name = mark?.caption ? `Footnote ${mark.caption.replace(/[[\]]/g, '')}` : 'Footnote';
    this.#link.setAttribute('aria-label', text ? `${name}: ${text}` : name);
    this.#link.title = mark?.problem ?? (text || `Go to note ${mark?.caption ?? ''}`.trim());
  }

  update(node: Node, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#draw(decorations);
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.type === 'click' || event.type === 'mousedown';
  }

  ignoreMutation(): boolean {
    return true;
  }
}

/** A note: its number, its text (editable) and a back-link "↩︎" to the first reference, as pagemd's `.footnote-item`. */
class FootnoteView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly #label: HTMLElement;
  readonly #back: HTMLAnchorElement;
  #node: Node;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[]) {
    this.#node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'footnote-item pmd-footnote';
    this.#label = document.createElement('span');
    this.#label.className = 'pmd-footnote-label';
    this.#label.contentEditable = 'false';
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'pmd-footnote-body';
    this.#back = document.createElement('a');
    this.#back.className = 'footnote-backref';
    this.#back.contentEditable = 'false';
    this.#back.textContent = '↩︎';
    this.dom.append(this.#label, this.contentDOM, this.#back);
    this.#draw(decorations);
    this.#back.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (getPos() === undefined) return;
      const ref = firstRefPos(view.state.doc, labelOf(this.#node));
      if (ref >= 0) jump(view, view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(ref + 1))));
    });
  }

  #draw(decorations: readonly Decoration[]): void {
    const mark = markOf(decorations);
    const label = labelOf(this.#node);
    this.dom.id = `fn-${label}`;
    this.dom.setAttribute('role', 'note');
    this.dom.setAttribute('aria-label', mark?.caption ? `Footnote ${mark.caption}` : `Footnote [^${label}]`);
    this.#label.textContent = mark?.caption ? `${mark.caption}.` : `[^${label}]`;
    this.#label.title = mark?.problem ?? `Footnote [^${label}]`;
    this.#back.setAttribute('href', `#fnref-${label}`);
    this.#back.setAttribute('aria-label', 'Back to the reference');
    this.#back.hidden = !mark?.caption;
  }

  update(node: Node, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#draw(decorations);
    return true;
  }

  stopEvent(event: Event): boolean {
    return (event.type === 'click' || event.type === 'mousedown') && (this.#back.contains(event.target as globalThis.Node) || this.#label.contains(event.target as globalThis.Node));
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: globalThis.Node }): boolean {
    return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target);
  }
}

/** Labels already used by a reference or a note. */
function usedLabels(doc: Node): Set<string> {
  const used = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === FOOTNOTE || (node.type.name === FOOTNOTE_REF && !isInline(node))) used.add(labelOf(node));
    return true;
  });
  return used;
}

/** The next free label: the smallest number not used yet. */
export function nextLabel(doc: Node): string {
  const used = usedLabels(doc);
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

/**
 * Insert ▸ Footnote (Word: References ▸ Insert Footnote; Word's Ctrl+Alt+F is a VS Code default here, so no shortcut: OQ-59): a reference at the cursor and a numbered note at the end
 * of the document, in one transaction (one undo step), the cursor in the note's text. Selected text stays; the reference goes
 * after it.
 */
export function insertFootnoteTransaction(state: EditorState): Transaction | null {
  const refType = state.schema.nodes[FOOTNOTE_REF];
  const noteType = state.schema.nodes[FOOTNOTE];
  const paragraph = state.schema.nodes['paragraph'];
  if (!refType || !noteType || !paragraph) return null;
  const { $to } = state.selection;
  if (!$to.parent.inlineContent || !$to.parent.canReplaceWith($to.index(), $to.index(), refType)) return null;
  const label = nextLabel(state.doc);
  const tr = state.tr.insert(state.selection.to, refType.create({ data: { form: 'ref', label } }));
  const end = tr.doc.content.size;
  tr.insert(end, noteType.create({ data: { form: 'definition', label } }, paragraph.create()));
  return tr.setSelection(TextSelection.create(tr.doc, end + 2)).scrollIntoView();
}

const insertFootnote: CommandSpec = {
  id: 'footnotes.insert',
  label: 'Footnote',
  icon: 'note',
  keywords: ['footnote', 'note', 'reference', 'endnote'],
  isEnabled: (state) => {
    const refType = state.schema.nodes[FOOTNOTE_REF];
    const { $to } = state.selection;
    return !!refType && $to.parent.inlineContent && $to.parent.canReplaceWith($to.index(), $to.index(), refType);
  },
  run: (state, dispatch) => {
    const tr = insertFootnoteTransaction(state);
    if (!tr) return false;
    dispatch(tr);
    return true;
  },
};

const noteSpec: TokenSpec = { block: FOOTNOTE, getAttrs: (tok) => ({ data: pmdData(tok) }) };

export const footnotes: SyntaxItem = {
  id: 'footnotes',
  group: 'text',
  schema: {
    nodes: {
      [FOOTNOTE_REF]: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: true,
        attrs: { data: {} },
        toDOM: (node) => ['sup', { class: 'footnote-ref', contenteditable: 'false' }, ['a', { href: `#fn-${labelOf(node)}` }, isInline(node) ? '[?]' : `[^${labelOf(node)}]`]],
      },
      [FOOTNOTE]: {
        content: 'block+',
        group: 'block',
        defining: true,
        attrs: { data: {} },
        toDOM: (node) => ['div', { class: 'footnote-item pmd-footnote', id: `fn-${labelOf(node)}` }, 0],
      },
    },
  },
  fromTokens: {
    footnote_ref: { node: FOOTNOTE_REF, getAttrs: (tok) => ({ data: pmdData(tok) }) },
    footnote_reference: noteSpec,
  },
  toMarkdown: { nodes: { [FOOTNOTE_REF]: inlineWriter(() => 'footnotes'), [FOOTNOTE]: wrapperWriter('footnotes') } },
  nodeViews: {
    [FOOTNOTE_REF]: (node, view, getPos, decorations) => new FootnoteRefView(node, view, getPos, decorations),
    [FOOTNOTE]: (node, view, getPos, decorations) => new FootnoteView(node, view, getPos, decorations),
  },
  label: 'Footnote',
  icon: 'note',
  slash: { keywords: ['footnote', 'note', 'reference'] },
  commands: [insertFootnote],
};
