// The webview half of plugin-diagnostics (P14, ADR-0017): the checks' results as hints on the canvas. Each problem on a
// line of the document marks the top-level block holding that line: a colored bar at its left edge (error, warning or
// note) and the messages as its tooltip. No checks run here and nothing is read: the host sends the results (the core's
// `Diagnostic`, character positions in the text the host checked). Positions become blocks through the transformer's
// block ranges (`sourceOf(doc).blocks`, ADR-0007), only when the canvas shows exactly that text; after that the
// decorations follow the edits until the next results arrive. Decorations take no room, so pages don't move.
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { topBlocks, type Diagnostic } from '@pagemd-editor/core';
import { sourceOf } from '@pagemd-editor/transformer';

export type HintSeverity = Diagnostic['severity'];

/** One marked block: the worst severity of its problems and their messages. */
export interface Hint {
  /** The top-level block's index. */
  block: number;
  severity: HintSeverity;
  messages: string[];
}

interface HintsState {
  hints: Hint[];
  decorations: DecorationSet;
}

export const hintsKey = new PluginKey<HintsState>('pmd-hints');

const RANK: Record<HintSeverity, number> = { error: 0, warning: 1, info: 2 };

/** The block an offset of the text belongs to: the last block starting at or before it. */
function blockAt(blocks: readonly { from: number; to: number }[], offset: number): number {
  let found = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.from <= offset) found = i;
    else break;
  }
  return found;
}

/**
 * The hints for `doc` from diagnostics computed on `text`; null when the canvas doesn't show exactly that text (its
 * source isn't known, or it changed since): the hints already shown then stay where the edits moved them, until the
 * next results. Problems at the very start (`to` 0: a
 * missing property, a problem in the profile or the template) get no hint; the Problems panel lists them.
 */
export function hintsFor(doc: Node, text: string, diagnostics: readonly Diagnostic[]): Hint[] | null {
  const source = sourceOf(doc);
  if (!source || source.text !== text || source.blocks.length !== topBlocks(doc).length) return null;
  const byBlock = new Map<number, Hint>();
  for (const d of diagnostics) {
    if (d.to <= 0) continue;
    const block = blockAt(source.blocks, d.from);
    const hint = byBlock.get(block) ?? { block, severity: d.severity, messages: [] };
    if (RANK[d.severity] < RANK[hint.severity]) hint.severity = d.severity;
    hint.messages.push(d.message);
    byBlock.set(block, hint);
  }
  return [...byBlock.values()].sort((a, b) => a.block - b.block);
}

function decorate(doc: Node, hints: readonly Hint[]): DecorationSet {
  const decorations: Decoration[] = [];
  const wanted = new Map(hints.map((h) => [h.block, h]));
  // Blocks as the block ranges count them (P18: a SECTION's box is looked through).
  topBlocks(doc).forEach(({ node, pos }, index) => {
    const hint = wanted.get(index);
    if (hint) {
      const label = hint.messages.join('\n');
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `pmd-hint pmd-hint-${hint.severity}`, title: label }, { hint }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

type Meta = { hints: Hint[] };

/** The hints plugin: holds the hints and their decorations; `showHints` sets them. */
export function diagnosticsPlugin(): Plugin<HintsState> {
  return new Plugin<HintsState>({
    key: hintsKey,
    state: {
      init: () => ({ hints: [], decorations: DecorationSet.empty }),
      apply(tr: Transaction, value: HintsState, _old: EditorState, state: EditorState): HintsState {
        const meta = tr.getMeta(hintsKey) as Meta | undefined;
        if (meta) return { hints: meta.hints, decorations: decorate(state.doc, meta.hints) };
        if (!tr.docChanged) return value;
        return { hints: value.hints, decorations: value.decorations.map(tr.mapping, tr.doc) };
      },
    },
    props: {
      decorations: (state) => hintsKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

/**
 * Shows the results the host sent for `text` (an empty list clears the hints); null, changing nothing, when the canvas
 * no longer shows that text. Changes no content: not an undo step.
 */
export function showHints(view: EditorView, text: string, diagnostics: readonly Diagnostic[]): Hint[] | null {
  const hints = hintsFor(view.state.doc, text, diagnostics);
  if (hints === null) return null;
  view.dispatch(view.state.tr.setMeta(hintsKey, { hints } satisfies Meta).setMeta('addToHistory', false));
  return hints;
}

/** The hints on the canvas now, with their blocks as they are now (decorations follow edits). */
export function hintsOf(state: EditorState): Hint[] {
  const plugin = hintsKey.getState(state);
  if (!plugin) return [];
  const out: Hint[] = [];
  topBlocks(state.doc).forEach(({ node, pos }, index) => {
    for (const d of plugin.decorations.find(pos, pos + node.nodeSize, (spec: { hint?: Hint }) => spec.hint !== undefined)) {
      if (d.from === pos) out.push({ ...(d.spec as { hint: Hint }).hint, block: index });
    }
  });
  return out;
}

/** The hints' look: a bar at the block's left edge in VS Code's problem colors (box-shadow takes no room). */
export const hintsCss = `
.pmd-hint { box-shadow: -4px 0 0 0 var(--pmd-hint-color); }
.pmd-hint-error { --pmd-hint-color: var(--vscode-editorError-foreground, #e51400); }
.pmd-hint-warning { --pmd-hint-color: var(--vscode-editorWarning-foreground, #bf8803); }
.pmd-hint-info { --pmd-hint-color: var(--vscode-editorInfo-foreground, #1a85ff); }
`;
