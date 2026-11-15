// FIX-FT item 3: a table not in standard form from the user's showcase file (the "Tables" section of a general markdown
// example, Desktop/example.md lines 499-527). Six GitHub-style tables, one blank line apart, with 3, 2, 2, 2, 3 and 2
// columns. pagemd (markdown-it-multimd-table with `multibody`) reads them as ONE table: the first header, then six body
// groups; a later table's header and separator lines are ordinary body rows; rows of 2 cells in a 3-column table are short.
// The canvas must read it the same way (via @pagemd/syntax), keep its bytes until the table is edited (ADR-0007), and the
// first edit writes it in standard form in one undo step (AD-FIX-FT-04/05).
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { TableMap } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { createDialect } from '@pagemd/syntax';
import { createRegistry, ItemRegistry, RAW_BLOCK, ViewState } from '@pagemd-editor/core';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { pagemdItems, tableEditingPlugins, tableShape } from '../src/index.ts';

const all = [...commonmarkItems, ...gfmItems, ...pagemdItems()];
const t = createTransformer(all);
const registry = createRegistry({ items: new ItemRegistry([...all]), view: new ViewState() });

const EXAMPLE = [
  'Markdown | Less | Pretty',
  '--- | --- | ---',
  '*Still* | `renders` | **nicely**',
  '1 | 2 | 3',
  '',
  '| First Header  | Second Header |',
  '| ------------- | ------------- |',
  '| Content Cell  | Content Cell  |',
  '| Content Cell  | Content Cell  |',
  '',
  '| Command | Description |',
  '| --- | --- |',
  '| git status | List all new or modified files |',
  "| git diff | Show file differences that haven't been staged |",
  '',
  '| Command | Description |',
  '| --- | --- |',
  '| `git status` | List all *new or modified* files |',
  "| `git diff` | Show file differences that **haven't been** staged |",
  '',
  '| Left-aligned | Center-aligned | Right-aligned |',
  '| :---         |     :---:      |          ---: |',
  '| git status   | git status     | git status    |',
  '| git diff     | git diff       | git diff      |',
  '',
  '| Name     | Character |',
  '| ---      | ---       |',
  '| Backtick | `         |',
  '| Pipe     | \\|        |',
].join('\n');
const DOC = `Before.\n\n${EXAMPLE}\n\n------\n\nAfter.\n`;

function tableOf(doc: Node): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name === 'table' && !found) found = { node, pos };
    return !found;
  });
  return found!;
}

/** pagemd's rows: the number of cells in each `<tr>`, and the body groups (`<tbody>`s). */
function pagemdRows(text: string): { cells: number[]; bodies: number } {
  const html = createDialect().render(text);
  const cells = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1]!.matchAll(/<t[hd][^>]*>/g)].length);
  return { cells, bodies: (html.match(/<tbody>/g) ?? []).length };
}

/** The canvas's rows: cells per row, and the body groups. */
function canvasRows(table: Node): { cells: number[]; bodies: number } {
  const cells: number[] = [];
  const groups = new Set<number>();
  table.forEach((row) => {
    cells.push(row.childCount);
    if ((row.attrs['group'] as number) >= 0) groups.add(row.attrs['group'] as number);
  });
  return { cells, bodies: groups.size };
}

function stateIn(text: string, row: number, col: number): EditorState {
  const doc = t.parse(text);
  const { node, pos } = tableOf(doc);
  const map = TableMap.get(node);
  const state = EditorState.create({ schema: t.schema, doc, plugins: tableEditingPlugins() });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos + 1 + map.map[row * map.width + col]! + 1)));
}

describe('the showcase table that is not in standard form', () => {
  it('is read as pagemd reads it: one table, six body groups, the same cells in every row', () => {
    const pagemd = pagemdRows(EXAMPLE);
    expect(pagemd).toEqual({ cells: [3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 2, 2, 2, 2], bodies: 6 });
    const doc = t.parse(DOC);
    expect(JSON.stringify(doc.toJSON()).includes(RAW_BLOCK)).toBe(false);
    const table = tableOf(doc).node;
    expect(canvasRows(table)).toEqual(pagemd);
    // the cells pagemd reads in a special way: the backtick with no partner keeps the pipe after it; `\|` is a pipe
    const texts: string[][] = [];
    table.forEach((row) => texts.push(Array.from({ length: row.childCount }, (_, k) => row.child(k).textContent)));
    expect(texts[21]).toEqual(['Backtick', '`         |']);
    expect(texts[22]).toEqual(['Pipe', '|']);
    expect(texts[4]).toEqual(['-------------', '-------------']); // a later table's separator line is a body row
    expect(tableShape(table)).toMatchObject({ kind: 'fixable' });
  });

  it('keeps its bytes (LF and CRLF) when the author edits only the text around it', () => {
    for (const text of [DOC, DOC.replace(/\n/g, '\r\n')]) {
      const state = stateIn(text, 1, 0);
      const after = state.doc.content.size - 2; // inside the last paragraph ("After.")
      const next = state.applyTransaction(state.tr.insertText('!', after));
      expect(next.transactions).toHaveLength(1); // nothing appended: the table was not touched
      const saved = applyEdits(text, diffToEdits(state.doc, next.state.doc, text));
      expect(saved).toBe(text.replace(/After\./, 'After!.'));
    }
  });

  it('its tools are on; the first edit writes it in standard form (3 cells in every row) in one step; it reads back the same, in pagemd too', () => {
    for (const eol of ['\n', '\r\n']) {
      const text = DOC.replace(/\n/g, eol);
      const state = stateIn(text, 1, 0);
      const action = registry.actions({ surface: 'ribbon', context: { state, editable: true } }).find((a) => a.id === 'table.add-row-below')!;
      expect(action.enabled).toBe(true);
      const typed = state.applyTransaction(state.tr.insertText('Very '));
      expect(typed.transactions).toHaveLength(2); // the author's typing and the filling: one undo step
      const saved = applyEdits(text, diffToEdits(state.doc, typed.state.doc, text));
      const lines = saved.split(eol);
      const table = lines.slice(lines.indexOf('Before.') + 2, lines.indexOf('------') - 1);
      expect(table.filter((l) => l !== '').every((l) => l.startsWith('| ') && l.endsWith(' |'))).toBe(true);
      expect(saved.startsWith(`Before.${eol}${eol}| Markdown`)).toBe(true);
      expect(saved.endsWith(`|${eol}${eol}------${eol}${eol}After.${eol}`)).toBe(true); // the text around it keeps its bytes
      // every row now has 3 cells; the groups and the text stay; it reads back as the canvas shows it, and pagemd reads the same
      const again = t.parse(saved);
      expect(again.toJSON()).toEqual(typed.state.doc.toJSON());
      const rows = canvasRows(tableOf(again).node);
      expect(rows).toEqual({ cells: Array(23).fill(3), bodies: 6 });
      expect(pagemdRows(table.join('\n'))).toEqual(rows);
      expect(tableOf(again).node.textContent).toBe(tableOf(state.doc).node.textContent.replace('Still', 'Very Still'));
    }
  });
});
