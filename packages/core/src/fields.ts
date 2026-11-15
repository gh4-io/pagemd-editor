// Inspector fields (P8, R-161, ADR-0013 amendment): what the Inspector's Element tab shows for the selected item and
// how a changed value goes back into the document. An item describes its node's (or mark's) settings as ItemFields,
// the same shape as @pagemd/syntax's `params` (text, number, on/off, choice, path, color, list, group), and says how
// to read them from the node's attributes and write them back. The Inspector only ever sees fields and values; the
// item's own writer turns the changed attributes into markdown (only that block changes, ADR-0007).
import type { Mark, Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

export type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'path' | 'color' | 'list' | 'object';

/** One setting the Inspector shows (the shape of @pagemd/syntax's params, plus a label for every field). */
export interface ItemField {
  key: string;
  type: FieldType;
  label: string;
  help?: string;
  /** `enum`: the choices. */
  values?: readonly string[];
  /** `enum`: other text is accepted too (the choices are suggestions, e.g. a layout's named pages). */
  free?: boolean;
  /** `object`: its fields. `list`: each row's fields (without them a row is one line of text). */
  fields?: readonly ItemField[];
  /** `number`: limits, shown as help (the Inspector checks the type only, R-160 amendment 5). */
  min?: number;
  max?: number;
  default?: unknown;
  /** Marked in the form; not enforced. */
  required?: boolean;
  /** `path`: file extensions the "Browse…" picker offers (without the dot). */
  extensions?: readonly string[];
  /** Shown, not editable. */
  readOnly?: boolean;
}

/** A node or a mark: both carry `attrs`. */
export type FieldOwner = Node | Mark;

/**
 * How one node or mark type shows in the Inspector. `values` reads the field values from the attributes; `apply`
 * returns the attributes that hold `values` (only the keys it changes need to be in the result).
 */
export interface FieldBinding {
  /** A title for this group of fields; the item's label when absent. */
  label?: string;
  fields: readonly ItemField[] | ((owner: FieldOwner) => readonly ItemField[]);
  values(owner: FieldOwner): Record<string, unknown>;
  apply(owner: FieldOwner, values: Record<string, unknown>): Record<string, unknown>;
  /**
   * P27 (amendment 4): a note on some list rows, by the row's path ("markers.2" → "Hidden by the crop"). The Inspector marks
   * those rows and shows the note. Optional.
   */
  rowNotes?(owner: FieldOwner): Record<string, string>;
}

/** One group of fields on a target: the item's own, or one an extension adds (e.g. pagemd's `{.class #id}`). */
export interface FieldSection {
  /** The item that declares the binding. */
  id: string;
  label: string;
  fields: readonly ItemField[];
  values: Record<string, unknown>;
  /** Notes on list rows, by path (FieldBinding.rowNotes). */
  rowNotes?: Record<string, string>;
}

/** Something the Element tab can edit: a node (by position) or a mark (by the range it covers). */
export interface FieldTarget {
  kind: 'node' | 'mark';
  /** Node or mark type name. */
  name: string;
  /** The owning item's label. */
  label: string;
  /** Node: its position. Mark: where the marked text starts. */
  from: number;
  /** Node: its end. Mark: where the marked text ends. */
  to: number;
  sections: FieldSection[];
}

/** The text range around `pos` that carries `mark` (a link's whole text). */
export function markRange(doc: Node, pos: number, mark: Mark): { from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  let index = $pos.index();
  // At the very end of a marked run the cursor's index is past it: look at the node before.
  if (index >= parent.childCount || !mark.isInSet(parent.child(index).marks)) {
    if (index > 0 && mark.isInSet(parent.child(index - 1).marks)) index--;
    else return null;
  }
  let from = 0;
  for (let i = 0; i < index; i++) from += parent.child(i).nodeSize;
  let to = from + parent.child(index).nodeSize;
  let first = index;
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) {
    first--;
    from -= parent.child(first).nodeSize;
  }
  let last = index;
  while (last + 1 < parent.childCount && mark.isInSet(parent.child(last + 1).marks)) {
    last++;
    to += parent.child(last).nodeSize;
  }
  const start = $pos.start();
  return { from: start + from, to: start + to };
}

/** A binding's fields for one owner. */
export const fieldsOf = (binding: FieldBinding, owner: FieldOwner): readonly ItemField[] =>
  typeof binding.fields === 'function' ? binding.fields(owner) : binding.fields;

/** What the Element tab shows for `state`'s selection: innermost first (a mark at the cursor, the selected node, then its ancestors). */
export function fieldTargets(state: EditorState, bindingsFor: (name: string, kind: 'node' | 'mark') => { id: string; label: string; binding: FieldBinding }[], labelOf: (name: string) => string): FieldTarget[] {
  const out: FieldTarget[] = [];
  // A binding with no fields for this node (a fancy-list section on a plain numbered list) shows nothing.
  const sections = (owner: FieldOwner, name: string, kind: 'node' | 'mark'): FieldSection[] =>
    bindingsFor(name, kind)
      .map(({ id, label, binding }) => ({ id, label: binding.label ?? label, fields: fieldsOf(binding, owner), binding }))
      .filter((s) => s.fields.length > 0)
      .map(({ id, label, fields, binding }) => {
        const notes = binding.rowNotes?.(owner);
        return { id, label, fields, values: binding.values(owner), ...(notes && Object.keys(notes).length > 0 ? { rowNotes: notes } : {}) };
      });
  const sel = state.selection;
  const selected = (sel as { node?: Node }).node;
  if (!selected) {
    // Marks at the cursor (a link): those with fields.
    const marks = sel.empty ? (state.storedMarks ?? sel.$from.marks()) : sel.$from.marksAcross(sel.$to) ?? [];
    for (const mark of marks) {
      const found = sections(mark, mark.type.name, 'mark');
      if (found.length === 0) continue;
      const range = markRange(state.doc, sel.from, mark);
      if (range) out.push({ kind: 'mark', name: mark.type.name, label: labelOf(mark.type.name), ...range, sections: found });
    }
  } else {
    const found = sections(selected, selected.type.name, 'node');
    if (found.length > 0) out.push({ kind: 'node', name: selected.type.name, label: labelOf(selected.type.name), from: sel.from, to: sel.from + selected.nodeSize, sections: found });
  }
  const $from = sel.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    const found = sections(node, node.type.name, 'node');
    if (found.length === 0) continue;
    const pos = $from.before(depth);
    out.push({ kind: 'node', name: node.type.name, label: labelOf(node.type.name), from: pos, to: pos + node.nodeSize, sections: found });
  }
  return out;
}

/**
 * Writes `values` of one section back onto the target in `tr` (one step: the node's or mark's attributes change).
 * Returns false when the target is no longer there (the document changed meanwhile) or nothing would change.
 */
export function applyFieldValues(tr: Transaction, target: FieldTarget, binding: FieldBinding, values: Record<string, unknown>): boolean {
  if (target.kind === 'node') {
    const node = tr.doc.nodeAt(target.from);
    if (!node || node.type.name !== target.name) return false;
    const attrs = { ...node.attrs, ...binding.apply(node, values) };
    if (sameJson(attrs, node.attrs)) return false;
    tr.setNodeMarkup(target.from, undefined, attrs, node.marks);
    return true;
  }
  const type = tr.doc.type.schema.marks[target.name];
  if (!type || target.to > tr.doc.content.size) return false;
  let mark: Mark | undefined;
  tr.doc.nodesBetween(target.from, target.to, (node) => {
    mark ??= type.isInSet(node.marks) ?? undefined;
    return !mark;
  });
  if (!mark) return false;
  const attrs = { ...mark.attrs, ...binding.apply(mark, values) };
  if (sameJson(attrs, mark.attrs)) return false;
  tr.removeMark(target.from, target.to, type);
  tr.addMark(target.from, target.to, type.create(attrs));
  return true;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
