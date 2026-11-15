// Applies TextEdits to a string: what IDocumentSync does to the real document, for tests and headless use.
import type { TextEdit } from '@pagemd-editor/core';

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (edit.from < cursor || edit.to < edit.from || edit.to > text.length) throw new RangeError(`Bad or overlapping edit ${JSON.stringify({ from: edit.from, to: edit.to })}.`);
    out += text.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return out + text.slice(cursor);
}
