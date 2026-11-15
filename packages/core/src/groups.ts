// Groups (P18, R-229): a box drawn around the blocks between two marker blocks, as pagemd draws `<div class="…">` between
// `<!-- ::SECTION_START class="…" -->` and `<!-- ::SECTION_END -->` (and `<div class="cover">` for COVER). The markers stay
// blocks of their own (atoms, written as they were); the group node holds the start marker, the blocks between and the end
// marker, so the profile's CSS (`.panel { display: table-cell }`, `.panel-1 h1`) styles real boxes on the canvas.
//
// Groups are TRANSPARENT (NodeSpec `transparent: true`): reading and saving never see them. `topBlocks(doc)` lists the blocks a
// document is made of with the groups opened, in order; the transformer's block ranges, lossless saving, the source map, the
// Code view and every other per-block reader use it, so an edit inside a section still rewrites only that one block (ADR-0007),
// and a document nobody edited is written back byte for byte. Which marker opens or closes a group is the preset's business
// (`SyntaxItem.groups`); the pairing follows HTML: an end closes the innermost open group, a start nobody closes runs to the end of
// its parent, an end with nothing open is an ordinary block. `groupsPlugin` keeps the groups matching the markers after every
// change (delete a start marker and its box goes), in the same transaction group, and puts the selection back on the same text.
import type { Node, Schema } from 'prosemirror-model';
import { AllSelection, NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Selection, type Transaction } from 'prosemirror-state';

/** The NodeSpec flag of a group node: saving and block ranges look through it. */
export const TRANSPARENT = 'transparent';

/** What a preset says about one kind of group (SyntaxItem.groups). */
export interface GroupRule {
  /** The group node's name in the schema: `content: 'block+'`, `transparent: true`. */
  node: string;
  /** The group's attributes when `block` opens a group of this kind, else null. */
  opens(block: Node): Record<string, unknown> | null;
  /** Whether `block` closes the innermost open group (of any kind, as `</div>` does). */
  closes(block: Node): boolean;
}

/** Whether `node` is a group (transparent for saving). */
export function isTransparent(node: Node): boolean {
  return node.type.spec[TRANSPARENT] === true;
}

/** A block the document is made of, with the position right before it. */
export interface TopBlock {
  node: Node;
  pos: number;
}

/** The document's blocks with every group opened, in order (what the block ranges count). */
export function topBlocks(doc: Node): TopBlock[] {
  const out: TopBlock[] = [];
  const walk = (parent: Node, start: number) =>
    parent.forEach((child, offset) => {
      if (isTransparent(child)) walk(child, start + offset + 1);
      else out.push({ node: child, pos: start + offset });
    });
  walk(doc, 0);
  return out;
}

/** The blocks of `nodes` with every group opened (recursively). */
export function flattenGroups(nodes: readonly Node[]): Node[] {
  const out: Node[] = [];
  const add = (node: Node) => {
    if (isTransparent(node)) node.forEach(add);
    else out.push(node);
  };
  nodes.forEach(add);
  return out;
}

/** `blocks` (no groups among them) with groups made around the marker pairs `rules` describe. */
export function groupBlocks(blocks: readonly Node[], rules: readonly GroupRule[], schema: Schema): Node[] {
  if (rules.length === 0) return [...blocks];
  const root: Node[] = [];
  const open: Array<{ rule: GroupRule; attrs: Record<string, unknown>; children: Node[] }> = [];
  const current = (): Node[] => (open.length > 0 ? open[open.length - 1]!.children : root);
  const close = (): void => {
    const top = open.pop()!;
    current().push(schema.nodes[top.rule.node]!.create(top.attrs, top.children));
  };
  for (const block of blocks) {
    let opened = false;
    for (const rule of rules) {
      const attrs = rule.opens(block);
      if (attrs) {
        open.push({ rule, attrs, children: [block] });
        opened = true;
        break;
      }
    }
    if (opened) continue;
    if (open.length > 0 && rules.some((rule) => rule.closes(block))) {
      current().push(block);
      close();
      continue;
    }
    current().push(block);
  }
  while (open.length > 0) close();
  return root;
}

/** `doc` with its groups matching its markers: the same document when they already do. */
export function regroup(doc: Node, rules: readonly GroupRule[]): Node {
  const children: Node[] = [];
  doc.forEach((child) => children.push(child));
  const grouped = groupBlocks(flattenGroups(children), rules, doc.type.schema);
  const next = doc.type.create(doc.attrs, grouped, doc.marks);
  return next.eq(doc) ? doc : next;
}

// ── keeping them matched while editing ──

const groupsKey = new PluginKey('pmd-groups');

/** Whether every step of `tr` only changes text inside one textblock (typing): then no marker can have come or gone. */
function onlyText(tr: Transaction): boolean {
  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i] as unknown as { from?: number; to?: number; slice?: { content: { childCount: number; child(i: number): Node }; openStart: number; openEnd: number }; gapFrom?: number; mark?: unknown };
    const doc = tr.docs[i]!;
    if (typeof step.from !== 'number' || typeof step.to !== 'number' || step.gapFrom !== undefined) return false;
    if (step.from > doc.content.size || step.to > doc.content.size) return false;
    const $from = doc.resolve(step.from);
    if (!$from.parent.isTextblock || !$from.sameParent(doc.resolve(step.to))) return false;
    if (step.slice) {
      if (step.slice.openStart !== 0 || step.slice.openEnd !== 0) return false;
      for (let c = 0; c < step.slice.content.childCount; c++) if (!step.slice.content.child(c).isInline) return false;
    } else if (!step.mark) return false;
  }
  return true;
}

/** A position as (block index in `topBlocks`, offset inside it), or the document's end. */
function flatPlace(blocks: readonly TopBlock[], pos: number): { index: number; offset: number } {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (pos < b.pos + b.node.nodeSize) return { index: i, offset: Math.max(0, pos - b.pos) };
  }
  const last = blocks[blocks.length - 1];
  return last ? { index: blocks.length - 1, offset: last.node.nodeSize } : { index: 0, offset: 0 };
}

function posOf(blocks: readonly TopBlock[], place: { index: number; offset: number }): number {
  const b = blocks[Math.min(place.index, blocks.length - 1)];
  return b ? b.pos + Math.min(place.offset, b.node.nodeSize) : 0;
}

/** The selection on the same text after the groups changed (the blocks are the same, only the boxes around them moved). */
function carrySelection(selection: Selection, before: readonly TopBlock[], doc: Node): Selection {
  const after = topBlocks(doc);
  if (selection instanceof AllSelection) return new AllSelection(doc);
  const map = (pos: number) => Math.max(0, Math.min(posOf(after, flatPlace(before, pos)), doc.content.size));
  if (selection instanceof NodeSelection && !isTransparent(selection.node)) {
    const at = map(selection.from);
    const node = doc.nodeAt(at);
    if (node && NodeSelection.isSelectable(node)) return NodeSelection.create(doc, at);
  }
  try {
    return TextSelection.between(doc.resolve(map(selection.anchor)), doc.resolve(map(selection.head)));
  } catch {
    return TextSelection.near(doc.resolve(map(selection.head)));
  }
}

/**
 * Keeps the groups matching the markers (see the file header): after a change that could have added, removed or moved a marker,
 * the document's top level is built again from its blocks (the same block objects, so saving sees no change) and the selection
 * stays on the same text. Typing inside a paragraph is never looked at again (P13b: nothing per keystroke that grows with the
 * document).
 */
export function groupsPlugin(rules: readonly GroupRule[]): Plugin {
  return new Plugin({
    key: groupsKey,
    appendTransaction: (trs: readonly Transaction[], _old: EditorState, state: EditorState) => {
      if (rules.length === 0 || !trs.some((tr) => tr.docChanged) || trs.every((tr) => !tr.docChanged || onlyText(tr))) return null;
      const doc = state.doc;
      const next = regroup(doc, rules);
      if (next === doc) return null;
      const before = topBlocks(doc);
      const tr = state.tr.replaceWith(0, doc.content.size, next.content);
      tr.setSelection(carrySelection(state.selection, before, tr.doc));
      return tr.setMeta(groupsKey, true);
    },
  });
}
