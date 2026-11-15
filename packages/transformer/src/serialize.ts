// ProseMirror → markdown through the items' writers (R-74 a). Used for CHANGED blocks only; untouched
// blocks re-emit their original text (lossless).
import type { Node, Schema } from 'prosemirror-model';
import { MarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown';
import { extendReadWrite, type MarkWriter, type NodeWriter, type SyntaxItem } from '@pagemd-editor/core';

/** Serializer internals the default prosemirror-markdown writers also rely on. */
interface StateInternals {
  out: string;
  atBlockStart: boolean;
  inAutolink?: boolean;
}

/**
 * Escapes a line of text so it reads back as the same text.
 * - Everywhere: `` ` * \ ~ [ ] `` and `_` (left alone only between two letters or digits, where it can't
 *   start or end emphasis; prosemirror-markdown's `esc` also counts `_` itself as a letter, which lets
 *   `__` slip through); `<` that could open a tag or autolink; `&` that could start an entity.
 * - At a line start: `-`, `*`, `+` (before a space or alone), `>`, `#`, `1.` and `1)` list markers, and a setext underline (`===`).
 */
export function escapeLine(state: MarkdownSerializerState, line: string, startOfLine: boolean): string {
  const alnum = /[\p{L}\p{N}]/u;
  let out = line
    .replace(/[`*\\~[\]_]/g, (ch, i: number) => (ch === '_' && alnum.test(line[i - 1] ?? '') && alnum.test(line[i + 1] ?? '') ? ch : `\\${ch}`))
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?\w+;)/g, '\\&');
  if (startOfLine) {
    out = out
      .replace(/^(\+(?=[ \t]|$)|[-*>])/, '\\$&')
      .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
      .replace(/^(\s*\d+)([.)])(\s|$)/, '$1\\$2$3')
      .replace(/^(\s*)(=+\s*)$/, '$1\\$2');
  }
  const extra = state.options.escapeExtraCharacters;
  return extra ? out.replace(extra, '\\$&') : out;
}

/**
 * Text, including the line breaks kept from soft breaks (R-85 B). Each new line is prefixed by the
 * enclosing block's delimiter (`> `, list indent) and escaped as a line start.
 */
const writeText: NodeWriter = (state, node) => {
  const internals = state as unknown as StateInternals;
  const escape = !internals.inAutolink;
  const lines = (node.text ?? '').split('\n');
  lines.forEach((line, i) => {
    if (i > 0) state.write('\n');
    // A line also starts after a hard break ("\\\n"), not only at the start of the block.
    const lineStart = i > 0 || internals.atBlockStart || internals.out.endsWith('\n');
    state.write();
    internals.out += escape ? escapeLine(state, line, lineStart) : line;
  });
};

export interface Serializer {
  /** The whole document, every block written fresh (no reuse). */
  serializeDoc(doc: Node): string;
  /** One top-level block, '\n' line endings, no trailing newline. */
  serializeBlock(node: Node): string;
}

export function createSerializer(items: readonly SyntaxItem[], schema: Schema): Serializer {
  const nodes: Record<string, NodeWriter> = { text: writeText };
  const marks: Record<string, MarkWriter> = {};
  for (const item of items) {
    Object.assign(nodes, item.toMarkdown.nodes);
    Object.assign(marks, item.toMarkdown.marks);
  }
  // Writers wrapped by the items that extend those nodes and marks (ADR-0013 amendment, P4).
  extendReadWrite(items, {}, { nodes, marks });
  for (const name of Object.keys(schema.nodes)) {
    if (name !== 'doc' && !nodes[name]) throw new Error(`No item writes the node '${name}'.`);
  }
  for (const name of Object.keys(schema.marks)) {
    if (!marks[name]) throw new Error(`No item writes the mark '${name}'.`);
  }
  const serializer = new MarkdownSerializer(nodes, marks, { strict: true });

  return {
    serializeDoc: (doc) => serializer.serialize(doc).replace(/\n+$/, ''),
    serializeBlock: (node) => serializer.serialize(schema.topNodeType.create(null, node)).replace(/\n+$/, ''),
  };
}
