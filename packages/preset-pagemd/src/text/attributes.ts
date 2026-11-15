// `{.class #id key="value"}` attributes (markdown-it-attrs, read by @pagemd/syntax's `attributes` item).
// They sit on nodes other presets own (a CommonMark heading, a link), so this item adds a `pmdAttrs`
// attribute to those nodes and marks and wraps their writers (ADR-0013 amendment, P4, R-114). Attributes on
// any other node keep that block a raw_block (dialect.ts, the safety net). The `{…}` text is written by
// @pagemd/syntax's writeAttributes().
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import { writeAttributes } from '@pagemd/syntax';
import type { MarkExtension, MarkWriter, NodeExtension, NodeWriter, SyntaxItem } from '@pagemd-editor/core';
import { writtenAttributes } from '../dialect.ts';
import { withAttributes } from '../shared/dom.ts';

export const ATTRS = 'pmdAttrs';

type Pairs = [string, string][];

const pairsOf = (attrs: Record<string, unknown>): Pairs | null => (attrs[ATTRS] as Pairs | null) ?? null;
const out = (state: MarkdownSerializerState): { out: string } => state as unknown as { out: string };

const attrsSpec = { [ATTRS]: { default: null } };
const fromToken = (tok: Parameters<NonNullable<NodeExtension['fromToken']>>[0]) => ({ [ATTRS]: writtenAttributes(tok as never) });

/**
 * Runs the node's own writer, then puts ` {…}` where markdown-it-attrs reads it for that node. `place` gets the
 * text the node wrote and returns it with the attributes in.
 */
function after(place: (written: string, attrs: string) => string): (original: NodeWriter) => NodeWriter {
  return (original) => (state, node, parent, index) => {
    const s = out(state);
    const start = s.out.length;
    original(state, node, parent, index);
    const pairs = pairsOf(node.attrs);
    if (!pairs) return;
    s.out = s.out.slice(0, start) + place(s.out.slice(start), writeAttributes(pairs));
  };
}

/** At the end of the last line of text: a paragraph, an ATX heading, and a setext heading before its underline. */
const endOfText = (written: string, attrs: string): string => {
  const underline = /\n[ \t]*(=+|-+)$/.exec(written);
  return underline ? `${written.slice(0, underline.index)} ${attrs}${written.slice(underline.index)}` : `${written} ${attrs}`;
};

/** After the info string, on a fence's first line. */
const onFenceLine = (written: string, attrs: string): string => {
  // The written text starts with the line breaks that separate it from the block before.
  const eol = written.indexOf('\n', /^\n*/.exec(written)![0].length);
  return eol < 0 ? `${written} ${attrs}` : `${written.slice(0, eol)} ${attrs}${written.slice(eol)}`;
};

/** Right after the element, no space (an image). */
const rightAfter = (written: string, attrs: string): string => `${written}${attrs}`;

const nodes: Record<string, NodeExtension> = {
  heading: { attrs: attrsSpec, fromToken, write: after(endOfText) },
  paragraph: { attrs: attrsSpec, fromToken, write: after(endOfText) },
  code_block: { attrs: attrsSpec, fromToken, write: after(onFenceLine) },
  image: { attrs: attrsSpec, fromToken, write: after(rightAfter) },
};

/** A link: `[text](href){…}`. */
const link: MarkExtension = {
  attrs: attrsSpec,
  fromToken,
  write: (original: MarkWriter): MarkWriter => ({
    ...original,
    close(state, mark, parent, index) {
      const closing = typeof original.close === 'string' ? original.close : original.close(state, mark, parent, index);
      const pairs = pairsOf(mark.attrs);
      return pairs ? `${closing}${writeAttributes(pairs)}` : closing;
    },
  }),
};

/** Attributes the canvas shows as the renderer does (I3): classes, id, and an image's size (D22). */
const SHOWN = new Set(['class', 'id', 'width', 'height', 'style']);

/** The attributes an author wrote that the canvas applies; other keys stay in the markdown only. */
export function attributeDom(attrs: Record<string, unknown>): Record<string, string> {
  const dom: Record<string, string> = {};
  for (const [key, value] of pairsOf(attrs) ?? []) if (SHOWN.has(key)) dom[key] = value;
  return dom;
}

const view = withAttributes((node) => attributeDom(node.attrs));

export const attributes: SyntaxItem = {
  id: 'attributes',
  group: 'text',
  schema: {},
  fromTokens: {},
  toMarkdown: {},
  extend: { nodes, marks: { link } },
  // code_block's view is the mermaid item's (media/mermaid.ts), which adds these classes too.
  nodeViews: { heading: view, paragraph: view, image: view },
  label: 'Attributes',
  icon: 'symbol-property',
};
