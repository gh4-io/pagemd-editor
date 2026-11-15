// GFM corpus round-trip (P3 acceptance criterion 1), and the "nothing is lost" safety net (criterion 2).
// A separate corpus from test/corpus/ (P1's plain-markdown one): this one's transformer includes GFM items,
// so it doesn't change what that shared, already-approved test proves.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RAW_BLOCK } from '@pagemd-editor/core';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { createTransformer } from '@pagemd-editor/transformer';
import { gfmItems } from '../src/index.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems]);

function roundTrip(text: string): string {
  const doc = t.parse(text);
  return applyEdits(text, diffToEdits(doc, doc, text));
}

const dir = fileURLToPath(new URL('./corpus/', import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ name, text: readFileSync(`${dir}${name}`, 'utf8') }));

describe('preset-gfm corpus round-trip', () => {
  it('finds the GFM corpus files', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files.map((f) => [f.name, f] as const))('%s is byte-identical after open + save', (_name, file) => {
    expect(roundTrip(file.text)).toBe(file.text);
  });

  it('reads every GFM construct with an item (no raw_block)', () => {
    const withRaw = files.filter((f) => {
      let raw = 0;
      t.parse(f.text).descendants((node) => {
        if (node.type.name === RAW_BLOCK) raw++;
      });
      return raw > 0;
    });
    expect(withRaw.map((f) => f.name)).toEqual([]);
  });

  it('an edit to one table cell produces exactly one changed top-level block', () => {
    const file = files.find((f) => f.name === 'tables.md')!;
    const doc = t.parse(file.text);
    // Change the first table's first cell's text (a fresh node with the same table shape otherwise).
    let tablePos = -1;
    doc.descendants((node, pos) => {
      if (tablePos < 0 && node.type.name === 'table') tablePos = pos;
    });
    const table = doc.nodeAt(tablePos)!;
    const firstCell = table.child(0).child(0);
    const edited = doc.type.schema.text('Left*'); // was 'Left'
    const newCell = firstCell.type.create(firstCell.attrs, edited);
    const newRow = table.child(0).copy(table.child(0).content.replaceChild(0, newCell));
    const newTable = table.copy(table.content.replaceChild(0, newRow));
    const newDoc = doc.copy(doc.content.replaceChild(tablePos === 0 ? 0 : findChildIndex(doc, tablePos), newTable));
    const edits = diffToEdits(doc, newDoc, file.text);
    // One contiguous stretch of change: exactly one edit (lossless merges adjacent changed blocks into one edit).
    expect(edits.length).toBe(1);
  });

  it('nothing is lost around a frontmatter-style `---` header (decomposes into existing items, not raw_block)', () => {
    const text = '---\ntitle: Doc\nauthor: Me\n---\n\n# Body\n';
    const doc = t.parse(text);
    let raw = 0;
    doc.descendants((node) => {
      if (node.type.name === RAW_BLOCK) raw++;
    });
    expect(raw).toBe(0);
    expect(roundTrip(text)).toBe(text);
  });
});

function findChildIndex(doc: import('prosemirror-model').Node, pos: number): number {
  let index = 0;
  let offset = 0;
  doc.forEach((child, o, i) => {
    if (o === pos) index = i;
    offset += child.nodeSize;
  });
  return index;
}
