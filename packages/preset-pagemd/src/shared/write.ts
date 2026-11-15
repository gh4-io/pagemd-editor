// Writing helpers shared by the items. Every pagemd construct is written by its own write rule in
// @pagemd/syntax (C3); these only move text in and out of prosemirror-markdown's serializer state.
import type { Node } from 'prosemirror-model';
import { MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown';
import { items, writeDirective, type SyntaxItemDef } from '@pagemd/syntax';
import type { NodeWriter } from '@pagemd-editor/core';

/** The @pagemd/syntax item with this id (throws for an unknown id: a programming error). */
export function syntaxItem(id: string): SyntaxItemDef {
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`@pagemd/syntax has no item '${id}'.`);
  return found;
}

/** Writes an item from the data its editor-mode token carried (itemOccurrences), with a wrapper's inner markdown. */
export function writeItem(itemId: string, data: Record<string, unknown>, content?: string): string {
  if (itemId === UNKNOWN_DIRECTIVE) return writeDirective(data);
  const write = syntaxItem(itemId).write;
  if (!write) throw new Error(`@pagemd/syntax item '${itemId}' has no write rule.`);
  return write(data, content);
}

/** The id itemOccurrences gives a directive no item owns (e.g. BREAK, R-107). */
export const UNKNOWN_DIRECTIVE = 'unknown-directive';

interface StateInternals {
  out: string;
  delim: string;
  nodes: MarkdownSerializer['nodes'];
  marks: MarkdownSerializer['marks'];
  options: MarkdownSerializerState['options'];
}

const internals = (state: MarkdownSerializerState): StateInternals => state as unknown as StateInternals;

/**
 * Writes text that is already markdown, line by line, with the enclosing block's prefix on each line (a list
 * item's indent, a quote's `> `); blank lines get the prefix without its trailing spaces.
 */
export function writeLines(state: MarkdownSerializerState, text: string): void {
  const s = internals(state);
  text.split('\n').forEach((line, i) => {
    if (i === 0) {
      state.write();
      s.out += line;
    } else {
      s.out += `\n${line === '' ? s.delim.replace(/\s+$/, '') : s.delim}${line}`;
    }
  });
}

/** The markdown of a node's children, written with the same writers, without any outer prefix. */
export function innerMarkdown(state: MarkdownSerializerState, node: Node): string {
  const s = internals(state);
  return new MarkdownSerializer(s.nodes, s.marks, s.options).serialize(node).replace(/\n+$/, '');
}

/**
 * The inline markdown of a textblock-like node (a table cell), on one line. A line break the author wrote (a soft break
 * kept as a line break, R-85 B) stays one only with `keepLines`: a multi-line table row (P16, amendment 7).
 */
export function inlineMarkdown(state: MarkdownSerializerState, node: Node, keepLines = false): string {
  const s = internals(state);
  // The constructor is public in prosemirror-markdown's code (1.13.8) but typed without arguments.
  const State = MarkdownSerializerState as unknown as new (nodes: StateInternals['nodes'], marks: StateInternals['marks'], options: StateInternals['options']) => MarkdownSerializerState;
  const sub = new State(s.nodes, s.marks, s.options);
  sub.renderInline(node);
  const out = internals(sub).out.replace(/\r\n?/g, '\n');
  // A hard break stays a backslash and a line break: in a multi-line row that is the cell's own line break (review fix).
  return keepLines ? out : out.replace(/\n/g, ' ');
}

/** A writer for an atom node whose `data` attribute is its write data. */
export function atomWriter(itemOf: (node: Node) => string): NodeWriter {
  return (state, node) => {
    writeLines(state, writeItem(itemOf(node), node.attrs['data'] as Record<string, unknown>));
    state.closeBlock(node);
  };
}

/**
 * A writer for a wrapper node: the item's write rule gets the children's markdown as `content`. A wrapper the
 * author never closed (the token's `meta.closed` is false, C2: e.g. a `::: {…}` inside another, which pagemd's
 * reader closes at the outer one's `:::`) is written without its closing line, so it reads back the same.
 */
export function wrapperWriter(itemId: string): NodeWriter {
  return (state, node) => {
    let text = writeItem(itemId, node.attrs['data'] as Record<string, unknown>, innerMarkdown(state, node));
    if (node.attrs['closed'] === false && text.includes('\n')) text = text.slice(0, text.lastIndexOf('\n'));
    writeLines(state, text);
    state.closeBlock(node);
  };
}

/** A writer for an inline atom. */
export function inlineWriter(itemOf: (node: Node) => string): NodeWriter {
  return (state, node) => {
    state.write();
    internals(state).out += writeItem(itemOf(node), node.attrs['data'] as Record<string, unknown>);
  };
}
