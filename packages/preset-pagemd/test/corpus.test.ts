// P4 acceptance: pagemd's corpus (91 files, read in place from pagemd/tests/corpus; incl. uofo-field-safety-sop)
// with every preset. (1) Open + save with no edits is byte-identical (ADR-0007). (2) Only the planned blocks stay
// raw (amendments 4 and 7). (3) Every block written fresh by the items' writers reads back the same (the writers
// are right, not only the reuse of untouched text). (4) An edit to one text block anywhere (inside lists, tables,
// callouts, boxes, alerts) changes one stretch of the file: one edit, one diff hunk, and the result reads back as
// the edited document.
import { structuredPatch } from 'diff';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { TableMap } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { createRegistry, ItemRegistry, RAW_BLOCK, topBlocks, ViewState } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { pagemdItems, tableEditingPlugins } from '../src/index.ts';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { sourceOf, type Transformer } from '@pagemd-editor/transformer';
import { corpus, transformerFor } from './corpus-files.ts';

/** Node JSON with the one formatting-only attribute left out: a code fence's form (P1: a longer fence is needed
 *  when the code holds one; indented code after a list is written fenced). */
function normal(doc: Node): unknown {
  return JSON.parse(JSON.stringify(doc.toJSON(), (key, value: unknown) => (key === 'fence' ? 'any' : value)));
}

/** Blocks kept as raw text on purpose, with why (the dialect step's safety net). */
const EXPECTED_RAW = [
  // `{.class}` on a blockquote: no node keeps attributes there (amendment 4, safety net)
  'pagemd/docs/wiki/reference/Inline-Attributes.md [unknown-token]: > **Note:** Requires Node.js 20+',
  // `{.highlight}` on a list item (same)
  'pagemd/examples/md/04-fancy-lists-stress.md [unknown-token]: A.  Important item {.highlight}',
  // a table with multi-line rows (amendment 7: edited with table editing, P7)
  'pagemd/examples/md/15-advanced-tables.md [unknown-token]: | Feature | Description |',
];


/**
 * An edited paragraph whose code span wraps over two lines is written with the span on one line (P1's
 * CommonMark writer; the text is the same, markdown-it reads the line break in a code span as a space), so the
 * saved file has a second hunk there. The one corpus file that had such a span (pagemd-examples' agent rules) left
 * pagemd's corpus in SAN-0a, so the list is empty; the allowance stays for the next such file.
 */
const TWO_HUNKS: string[] = [];

function rawBlocks(name: string, doc: Node): string[] {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === RAW_BLOCK) found.push(`${name} [${node.attrs['reason'] as string}]: ${node.textContent.split('\n')[0]!.slice(0, 70)}`);
    return true;
  });
  return found;
}

/** Every text block at any depth (paragraphs, headings, table cells) with some text. */
function textblocks(doc: Node, max: number): number[] {
  const all: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock && node.type.name !== RAW_BLOCK && node.type.name !== 'code_block' && node.textContent.trim() !== '') all.push(pos);
    return !node.isTextblock;
  });
  return spread(all, max);
}

/** Up to `max` of the positions, spread over the document. */
function spread(all: number[], max: number): number[] {
  if (all.length <= max) return all;
  return Array.from({ length: max }, (_, k) => all[Math.floor((k * (all.length - 1)) / (max - 1))]!);
}

const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Types " EDITED" into the text block at `pos`, saves, and checks the result. */
function editAt(t: Transformer, doc: Node, text: string, pos: number): { edits: number; hunks: number; readBack: boolean } {
  const next = edited(doc, pos);
  const edits = diffToEdits(doc, next, text);
  const saved = applyEdits(text, edits);
  const hunks = structuredPatch('a', 'b', text, saved, '', '', { context: 0 }).hunks.length;
  return { edits: edits.length, hunks, readBack: JSON.stringify(normal(t.parse(saved))) === JSON.stringify(normal(next)) };
}

/** The document with " EDITED" typed at the end of the text block at `pos`. */
function edited(doc: Node, pos: number): Node {
  const at = pos + doc.nodeAt(pos)!.nodeSize - 1;
  return doc.replace(at, at, new Slice(Fragment.from(doc.type.schema.text(' EDITED')), 0, 0));
}

describe('P4: the pagemd corpus with every preset', () => {
  it('reads the corpus in place (87 files in pagemd/tests/corpus since SAN-0a trimmed its pagemd-examples copy)', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(87);
    expect(corpus.some((f) => f.name.endsWith('uofo-field-safety-sop.md'))).toBe(true);
  });

  it.each(corpus.map((f) => [f.name, f] as const))('%s is byte-identical after open + save', (_name, file) => {
    const doc = transformerFor(file.text).parse(file.text);
    expect(applyEdits(file.text, diffToEdits(doc, doc, file.text))).toBe(file.text);
  });

  it('keeps only the planned blocks raw (safety net and multi-line tables)', () => {
    const raw = corpus.flatMap((f) => rawBlocks(f.name, transformerFor(f.text).parse(f.text)));
    expect(raw).toEqual(EXPECTED_RAW);
  });

  it('every block written fresh by the items reads back the same', () => {
    const differ: string[] = [];
    for (const file of corpus) {
      const t = transformerFor(file.text);
      const doc = t.parse(file.text);
      const again = t.parse(t.serialize(doc));
      if (JSON.stringify(normal(again)) !== JSON.stringify(normal(doc))) differ.push(file.name);
    }
    expect(differ).toEqual([]);
  });

  it('an edit to one top-level text block (outside the frontmatter) gives one edit and one hunk, and reads back', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of corpus) {
      const t = transformerFor(file.text);
      const doc = t.parse(file.text);
      const ranges = sourceOf(doc)!.blocks;
      const frontmatterEnd = FRONTMATTER.exec(file.text)?.[0].length ?? 0;
      const positions: number[] = [];
      doc.forEach((node, pos, i) => {
        if (node.isTextblock && node.textContent.trim() !== '' && !['code_block', RAW_BLOCK].includes(node.type.name) && ranges[i]!.from >= frontmatterEnd) positions.push(pos);
      });
      for (const pos of spread(positions, 5)) {
        const result = editAt(t, doc, file.text, pos);
        checked++;
        const hunksOk = result.hunks === 1 || (TWO_HUNKS.includes(file.name) && result.hunks === 2);
        if (result.edits !== 1 || !hunksOk || !result.readBack) problems.push(`${file.name} @${pos}: ${JSON.stringify(result)}`);
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  });

  it('an edit to a text block inside a list, table, callout, box or alert is one edit and reads back (the top-level block is rewritten: R-75, amendment 13)', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of corpus) {
      const t = transformerFor(file.text);
      const doc = t.parse(file.text);
      const nested = textblocks(doc, 1000).filter((pos) => doc.resolve(pos).depth > 0);
      for (const pos of spread(nested, 6)) {
        const result = editAt(t, doc, file.text, pos);
        checked++;
        if (result.edits !== 1 || !result.readBack) problems.push(`${file.name} @${pos}: ${JSON.stringify(result)}`);
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(250);
  });

  it('P16: add-row-below on every modelled table in the corpus changes only that table\'s text (and the file reads back as that document)', () => {
    const registry = createRegistry({ items: new ItemRegistry([...commonmarkItems, ...gfmItems, ...pagemdItems()]), view: new ViewState() });
    const addRow = registry.commands.get('table.add-row-below')!;
    const problems: string[] = [];
    let changed = 0;
    let ragged = 0;
    for (const file of corpus) {
      const t = transformerFor(file.text);
      const doc = t.parse(file.text);
      const ranges = sourceOf(doc)!.blocks;
      doc.descendants((node, at) => {
        if (node.type.name !== 'table') return true;
        const index = topBlocks(doc).findIndex((b) => at >= b.pos && at < b.pos + b.node.nodeSize); // (P18: boxes looked through)
        const state = EditorState.create({ doc, plugins: tableEditingPlugins() });
        const found = TableMap.get(node);
        const withCursor = state.apply(state.tr.setSelection(TextSelection.create(doc, at + 1 + found.map[0]! + 1)));
        if (!addRow.isEnabled(withCursor)) {
          ragged++;
          return false;
        }
        let next = withCursor;
        addRow.run(withCursor, (tr) => (next = withCursor.apply(tr)));
        const edits = diffToEdits(doc, next.doc, file.text);
        const where = ranges[index]!;
        if (edits.length !== 1 || edits.some((e) => e.from < where.from || e.to > where.to)) problems.push(`${file.name} table @${at}: edits ${JSON.stringify(edits.map((e) => [e.from, e.to]))} outside block ${where.from}-${where.to}`);
        const saved = applyEdits(file.text, edits);
        if (JSON.stringify(normal(t.parse(saved))) !== JSON.stringify(normal(next.doc))) problems.push(`${file.name} table @${at}: the saved file does not read back as the changed document`);
        changed++;
        return false;
      });
    }
    expect(problems).toEqual([]);
    expect(changed).toBeGreaterThan(200); // 261 tables in the corpus
    expect(ragged).toBeLessThanOrEqual(2); // the ragged ones: CLI.md's (the multi-line one stays a raw block)
  }, 120_000);
});
