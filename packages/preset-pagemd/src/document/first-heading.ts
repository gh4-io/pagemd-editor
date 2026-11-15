// The first level-1 heading (FIX-S50, OQ-68): `hide_first_h1: true` (the properties, or the profile's default) hides it on the page, as pagemd's own
// output does (render mode adds the class `hide-first-h1`; the editor must not, it would read back as an attribute the author never wrote). The canvas
// marks the heading with the class `pmd-first-h1` (a decoration: nothing is written); the app's `pmd-hide-first-h1` on the canvas, from
// `hideFirstH1()`, turns the hiding on. In Draft, where the author edits, the heading is shown dimmed and struck through instead of hidden.
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';
import { layer, normalizeMetadata } from '@pagemd/meta';
import { frontmatterYaml, readProperties } from './frontmatter.ts';

export const firstHeadingKey = new PluginKey<DecorationSet>('pmd-first-heading');

/** The decoration for the document's first level-1 heading, if it has one. */
function decorations(doc: Node): DecorationSet {
  let found: { pos: number; node: Node } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'heading' && node.attrs['level'] === 1) found = { pos, node };
    return !found && !node.isTextblock;
  });
  const first = found as { pos: number; node: Node } | null;
  return first ? DecorationSet.create(doc, [Decoration.node(first.pos, first.pos + first.node.nodeSize, { class: 'pmd-first-h1' })]) : DecorationSet.empty;
}

export function firstHeadingPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: firstHeadingKey,
    state: {
      init: (_config, state: EditorState) => decorations(state.doc),
      apply: (tr, value, _old, state) => (tr.docChanged ? decorations(state.doc) : value),
    },
    props: { decorations: (state) => firstHeadingKey.getState(state) },
  });
}

/**
 * Is `hide_first_h1` on for this text: the written properties (aliases and value rules by @pagemd/meta), over the profile's default
 * (`StylesPayload.gateDefaults` carries it). Unreadable properties: off.
 */
export function hideFirstH1(text: string, profileDefaults: Record<string, unknown> = {}): boolean {
  const yaml = frontmatterYaml(text);
  let written: Record<string, unknown> = {};
  if (yaml !== null) {
    const read = readProperties(yaml);
    if (!('data' in read)) return false;
    written = normalizeMetadata(read.data, { applyDefaults: false });
  }
  return Boolean(layer(profileDefaults, written)['hide_first_h1']);
}

/** The canvas's look for it (editor UI, scoped to the canvas by the preset). */
export const FIRST_HEADING_CSS = `
.pmd-canvas.pmd-hide-first-h1.pmd-pdf-look .pmd-first-h1 { display: none; }
.pmd-canvas.pmd-hide-first-h1:not(.pmd-pdf-look) .pmd-first-h1 { opacity: 0.45; text-decoration: line-through; }
`;
