// Building blocks for item commands (P7, R-153): the few shapes nearly every command has (toggle a mark, set a block's
// type, wrap blocks, make a list, insert a block or an inline node). Items call these with their node and mark names;
// no syntax lives here. Each helper returns a complete CommandSpec: label, icon, enabled, active, run.
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import type { Attrs, MarkType, Node, NodeType, Schema } from 'prosemirror-model';
import { liftListItem, wrapInList } from 'prosemirror-schema-list';
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { CommandSpec, Dispatch } from './commands.ts';

/** What every helper takes beyond its own options. */
export interface CommandInfo {
  id: string;
  label: string;
  icon?: string;
  /** ProseMirror key notation, e.g. 'Mod-b'. */
  keybinding?: string;
  /** Also on the floating selection toolbar. */
  toolbar?: boolean;
  keywords?: readonly string[];
  slash?: boolean;
}

function spec(info: CommandInfo, rest: Pick<CommandSpec, 'isEnabled' | 'run'> & Partial<Pick<CommandSpec, 'isActive'>>): CommandSpec {
  return {
    id: info.id,
    label: info.label,
    ...(info.icon !== undefined ? { icon: info.icon } : {}),
    ...(info.keybinding !== undefined ? { keybinding: info.keybinding } : {}),
    ...(info.toolbar ? { toolbar: true } : {}),
    ...(info.keywords ? { keywords: info.keywords } : {}),
    ...(info.slash !== undefined ? { slash: info.slash } : {}),
    ...rest,
  };
}

const matches = (node: Node, attrs: Attrs | undefined): boolean => !attrs || Object.entries(attrs).every(([key, value]) => JSON.stringify(node.attrs[key] ?? null) === JSON.stringify(value ?? null));

// ── marks ──

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** Bold, italic, code, strikethrough: turns the mark on or off for the selection (or the next typed text). */
export function markCommand(info: CommandInfo, markName: string, attrs?: Attrs): CommandSpec {
  const type = (schema: Schema): MarkType | undefined => schema.marks[markName];
  return spec(info, {
    isEnabled: (state) => !!type(state.schema) && toggleMark(type(state.schema)!, attrs)(state),
    isActive: (state) => !!type(state.schema) && markActive(state, type(state.schema)!),
    run: (state, dispatch) => toggleMark(type(state.schema)!, attrs)(state, dispatch),
  });
}

/**
 * A link: turns the selection into a link to `href`, or removes the link when it already is one. With nothing
 * selected it inserts `placeholder` text as the link. The address is a placeholder; the Inspector (P8) edits it.
 */
export function linkCommand(info: CommandInfo, markName: string, href: string, placeholder: string): CommandSpec {
  return spec(info, {
    isEnabled: (state) => !!state.schema.marks[markName] && state.selection.$from.parent.inlineContent,
    isActive: (state) => !!state.schema.marks[markName] && markActive(state, state.schema.marks[markName]!),
    run: (state, dispatch) => {
      const type = state.schema.marks[markName]!;
      const { from, to, empty } = state.selection;
      if (markActive(state, type)) return toggleMark(type)(state, dispatch);
      if (empty) {
        const text = state.schema.text(placeholder, [type.create({ href })]);
        dispatch(state.tr.replaceSelectionWith(text, false).scrollIntoView());
      } else dispatch(state.tr.addMark(from, to, type.create({ href })).scrollIntoView());
      return true;
    },
  });
}

// ── blocks ──

/**
 * Makes the selected text blocks `nodeName` (with `attrs`); a second use turns them back into `fallback`.
 * `anyAttrs`: the command counts as active for any block of that type (a code block, whatever its language).
 */
export function blockTypeCommand(info: CommandInfo, nodeName: string, attrs?: Attrs, options: { fallback?: string; anyAttrs?: boolean } = {}): CommandSpec {
  const fallback = options.fallback ?? 'paragraph';
  const active = (state: EditorState): boolean => {
    const type = state.schema.nodes[nodeName];
    const parent = state.selection.$from.parent;
    return !!type && parent.type === type && (options.anyAttrs || matches(parent, attrs));
  };
  return spec(info, {
    isEnabled: (state) => !!state.schema.nodes[nodeName] && setBlockType(state.schema.nodes[nodeName]!, attrs)(state),
    isActive: active,
    run: (state, dispatch) => {
      if (active(state)) return setBlockType(state.schema.nodes[fallback]!)(state, dispatch);
      return setBlockType(state.schema.nodes[nodeName]!, attrs)(state, dispatch);
    },
  });
}

/** Wraps the selected blocks in `nodeName` (a quote, a box, an alert); a second use takes them out again. */
export function wrapCommand(info: CommandInfo, nodeName: string, attrs?: Attrs, isThis?: (node: Node) => boolean): CommandSpec {
  const found = (state: EditorState): { node: Node; pos: number } | null => {
    const type = state.schema.nodes[nodeName];
    if (!type) return null;
    const { $from } = state.selection;
    for (let d = $from.depth; d >= 1; d--) {
      const node = $from.node(d);
      if (node.type === type && (isThis ? isThis(node) : matches(node, attrs))) return { node, pos: $from.before(d) };
    }
    return null;
  };
  return spec(info, {
    isEnabled: (state) => !!state.schema.nodes[nodeName] && (found(state) !== null || wrapIn(state.schema.nodes[nodeName]!, attrs)(state)),
    isActive: (state) => found(state) !== null,
    run: (state, dispatch) => (found(state) ? lift(state, dispatch) : wrapIn(state.schema.nodes[nodeName]!, attrs)(state, dispatch)),
  });
}

/**
 * A bullet or numbered list. In a list of another kind, the list changes kind; in a list of this kind, the items
 * come out of it; elsewhere the selected blocks become a list. `attrs` are the list's attributes (the marker, a
 * lettered list's type, …); `same` says whether an existing list already is this kind (default: the attributes match).
 */
export function listCommand(info: CommandInfo, nodeName: string, attrs: Attrs, same?: (node: Node) => boolean): CommandSpec {
  const isThis = (node: Node): boolean => (same ? same(node) : matches(node, attrs));
  const current = (state: EditorState): { node: Node; pos: number } | null => {
    const { $from } = state.selection;
    for (let d = $from.depth; d >= 1; d--) {
      const node = $from.node(d);
      if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') return { node, pos: $from.before(d) };
    }
    return null;
  };
  return spec(info, {
    isEnabled: (state) => !!state.schema.nodes[nodeName] && (current(state) !== null || wrapInList(state.schema.nodes[nodeName]!, attrs)(state)),
    isActive: (state) => {
      const list = current(state);
      return !!list && list.node.type.name === nodeName && isThis(list.node);
    },
    run: (state, dispatch) => {
      const type = state.schema.nodes[nodeName]!;
      const list = current(state);
      if (list && list.node.type === type && isThis(list.node)) return liftOut(state, dispatch);
      if (list) {
        dispatch(state.tr.setNodeMarkup(list.pos, type, { ...defaultAttrs(type), ...attrs, tight: list.node.attrs['tight'] ?? true }).scrollIntoView());
        return true;
      }
      return wrapInList(type, attrs)(state, dispatch);
    },
  });
}

/** Takes the selected list items out of their list. */
function liftOut(state: EditorState, dispatch: Dispatch): boolean {
  const itemType = state.schema.nodes['list_item'];
  return !!itemType && liftListItem(itemType)(state, dispatch);
}

function defaultAttrs(type: NodeType): Attrs {
  const out: Record<string, unknown> = {};
  for (const [name, attr] of Object.entries(type.spec.attrs ?? {})) if ('default' in attr) out[name] = attr.default;
  return out;
}

// ── inserting nodes ──

/** Where a block of `type` can go: right after the block holding the selection, or in place of an empty paragraph. */
function blockPlace(state: EditorState, type: NodeType): { from: number; to: number } | null {
  const { selection } = state;
  const { $to } = selection;
  if (selection instanceof NodeSelection && $to.parent.canReplaceWith($to.index(), $to.index(), type)) return { from: $to.pos, to: $to.pos };
  for (let d = $to.depth; d >= 1; d--) {
    const container = $to.node(d - 1);
    const index = $to.indexAfter(d - 1);
    if (container.canReplaceWith(index, index, type)) {
      const block = $to.node(d);
      // An empty paragraph is replaced (the slash menu leaves one behind), not left above the new block.
      if (block.type.name === 'paragraph' && block.content.size === 0 && selection.empty && container.canReplaceWith(index - 1, index, type)) return { from: $to.before(d), to: $to.after(d) };
      return { from: $to.after(d), to: $to.after(d) };
    }
  }
  return null;
}

/**
 * The transaction that inserts `nodes` (blocks of the type named `nodeName`) below the selection, in place of an empty
 * paragraph, or null when no such block fits there. A block with nothing after it gets an empty paragraph, so the author
 * can keep typing. The selection goes to the first inserted block when it is text-like, else into the nearest text; with
 * `selectFirst` it selects the first inserted block itself (P11: the Inspector then shows its fields).
 */
export function insertBlocksTransaction(state: EditorState, nodeName: string, nodes: readonly Node[], options: { selectFirst?: boolean } = {}): Transaction | null {
  const type = state.schema.nodes[nodeName];
  const place = type && blockPlace(state, type);
  if (!type || !place || nodes.length === 0) return null;
  const tr = state.tr.replaceWith(place.from, place.to, nodes as Node[]);
  const after = place.from + nodes.reduce((sum, n) => sum + n.nodeSize, 0);
  const paragraph = state.schema.nodes['paragraph'];
  const resolved = tr.doc.resolve(after);
  if (paragraph && resolved.nodeAfter === null && resolved.parent.canReplaceWith(resolved.index(), resolved.index(), paragraph)) tr.insert(after, paragraph.create());
  const first = tr.doc.nodeAt(place.from);
  if (options.selectFirst && first && NodeSelection.isSelectable(first)) tr.setSelection(NodeSelection.create(tr.doc, place.from));
  else tr.setSelection(Selection.findFrom(tr.doc.resolve(place.from), 1, true) ?? Selection.near(tr.doc.resolve(Math.min(after, tr.doc.content.size))));
  return tr.scrollIntoView();
}

/**
 * Inserts the block `create` makes below the selection (in place of an empty paragraph). A block with nothing after
 * it gets an empty paragraph, so the author can keep typing; the cursor goes into the new block's text, or after it.
 */
export function insertBlockCommand(info: CommandInfo, nodeName: string, create: (schema: Schema, state: EditorState) => Node): CommandSpec {
  return spec(info, {
    isEnabled: (state) => !!state.schema.nodes[nodeName] && blockPlace(state, state.schema.nodes[nodeName]!) !== null,
    run: (state, dispatch) => {
      const tr = insertBlocksTransaction(state, nodeName, [create(state.schema, state)]);
      if (!tr) return false;
      dispatch(tr);
      return true;
    },
  });
}

/** Inserts the inline node `create` makes in place of the selection. `create` gets the selected text. */
export function insertInlineCommand(info: CommandInfo, nodeName: string, create: (schema: Schema, selectedText: string) => Node, options: { keepSelection?: boolean } = {}): CommandSpec {
  return spec(info, {
    isEnabled: (state) => {
      const type = state.schema.nodes[nodeName];
      const { $from } = state.selection;
      return !!type && $from.parent.inlineContent && $from.parent.canReplaceWith($from.index(), $from.index(), type);
    },
    run: (state, dispatch) => {
      const { from, to, empty } = state.selection;
      const text = empty ? '' : state.doc.textBetween(from, to, ' ');
      const node = create(state.schema, text);
      // Keeping the selection (an index entry for the words) puts the node after them; otherwise it replaces them.
      const tr: Transaction = options.keepSelection ? state.tr.insert(to, node) : state.tr.replaceSelectionWith(node, false);
      const end = (options.keepSelection ? to : from) + node.nodeSize;
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), 1));
      dispatch(tr.scrollIntoView());
      return true;
    },
  });
}

/** A command that needs nothing from the state to be enabled (used by tests and view-like commands). */
export function plainCommand(info: CommandInfo, run: (state: EditorState, dispatch: Dispatch, args?: unknown) => boolean, isEnabled: CommandSpec['isEnabled'] = () => true): CommandSpec {
  return spec(info, { isEnabled, run });
}
