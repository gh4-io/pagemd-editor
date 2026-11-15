// The search itself (P11): which text counts, and where the matches are. Pure functions over a ProseMirror document.
// "Visible text" means the text of the document's text blocks as the canvas shows it: markup characters (the `**` of bold,
// a directive's comment, a table's pipes) are not in the document as text, so they are never found, and a word split by
// bold or a link is still one word. What is NOT searched: a raw block (kept as its exact source text, invariant I4), the
// properties card (frontmatter), and anything the app says is hidden (a drawn diagram's source).
import type { Mark, Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { RAW_BLOCK } from '@pagemd-editor/core';

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export interface Range {
  from: number;
  to: number;
}

export interface Matches {
  ranges: Range[];
  /** True when the list stopped at MAX_MATCHES. */
  capped: boolean;
}

/** A long list is cut here: highlighting more would slow the canvas for no use. */
export const MAX_MATCHES = 5000;

/** Stands for an inline node that has no text (a hard break, a chip): never part of a match. */
const LEAF = '￼';
const WORD = '[\\p{L}\\p{N}_]';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The expression for `query` (null for an empty query). Plain text only: no pattern language. */
export function queryExpression(query: string, options: FindOptions): RegExp | null {
  if (query === '') return null;
  const body = escapeRegExp(query);
  const source = options.wholeWord ? `(?<!${WORD})${body}(?!${WORD})` : body;
  return new RegExp(source, options.matchCase ? 'gu' : 'giu');
}

/** Every match of `query` in the text of `doc`, in document order. `searchable` can hide a node (and what is inside it). */
export function findRanges(doc: Node, query: string, options: FindOptions, searchable: (node: Node) => boolean = () => true): Matches {
  const expression = queryExpression(query, options);
  const ranges: Range[] = [];
  if (!expression) return { ranges, capped: false };
  let capped = false;
  doc.descendants((node, pos) => {
    if (capped) return false;
    if (node.type.name === RAW_BLOCK || !searchable(node)) return false;
    if (!node.isTextblock) return true;
    // The block's text, with the document position of each character (a text node's characters are one position each).
    let text = '';
    const at: number[] = [];
    node.descendants((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) at.push(pos + 1 + offset + i);
        text += child.text;
      } else if (child.isLeaf) {
        at.push(pos + 1 + offset);
        text += LEAF;
      }
      return true;
    });
    expression.lastIndex = 0;
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      if (match[0] === '') {
        expression.lastIndex++;
        continue;
      }
      const first = at[match.index]!;
      const last = at[match.index + match[0].length - 1]! + 1;
      // A match across a chip, or across an inline node's edge, can't be replaced as plain text: it isn't listed.
      if (match[0].includes(LEAF) || last - first !== match[0].length) continue;
      if (ranges.length >= MAX_MATCHES) {
        capped = true;
        break;
      }
      ranges.push({ from: first, to: last });
    }
    return false;
  });
  return { ranges, capped };
}

/** The index of the first range that starts at or after `pos`, wrapping to the first; -1 when there are none. */
export function indexFrom(ranges: readonly Range[], pos: number): number {
  if (ranges.length === 0) return -1;
  const found = ranges.findIndex((r) => r.from >= pos);
  return found === -1 ? 0 : found;
}

/** The marks the replacement takes: those of the text it replaces (bold stays bold). */
export function marksAt(doc: Node, pos: number): readonly Mark[] {
  return doc.nodeAt(pos)?.marks ?? [];
}

/**
 * Puts `text` in place of each of `ranges` (found in `state`'s document) into `tr`: the same marks as the text replaced
 * (bold stays bold), an empty replacement deletes. Done from the end so the ranges still to change stay where they were. The
 * replacement is plain text: a `*` in it is written escaped, like any typed `*`.
 */
export function replaceInto(tr: Transaction, state: EditorState, ranges: readonly Range[], text: string): Transaction {
  for (const range of [...ranges].reverse()) {
    if (text === '') tr.delete(range.from, range.to);
    else tr.replaceWith(range.from, range.to, state.schema.text(text, marksAt(state.doc, range.from) as Mark[]));
  }
  return tr;
}
