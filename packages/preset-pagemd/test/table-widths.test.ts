// P19: table column widths. The arithmetic (widths.ts), the canvas's table drawn as pagemd's HTML has it (one reading of
// `data-col-widths` and `.fixed-layout`, @pagemd/syntax's), the width commands and the column commands keeping widths in
// step (each written, read back and compared, as P16's command tests), and the Inspector's Width boxes and raw-table note.
// The drag itself needs a page: test/e2e/table-widths.spec.ts.
import type { DOMOutputSpec, Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { TableMap } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { createDialect } from '@pagemd/syntax';
import { createEditor, createRegistry, ItemRegistry, RAW_BLOCK, ViewState, type CommandSpec, type Editor } from '@pagemd-editor/core';
import { commonmarkItems, commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { gfmItems, gfmPreset } from '@pagemd-editor/preset-gfm';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { createTransformer } from '@pagemd-editor/transformer';
import { completeWidths, layoutOf, moveBorder, pagemdItems, pagemdPreset, roundTo100, tableEditingPlugins, withLayout } from '../src/index.ts';
import { canWiden, deleteColumnWidths, insertColumnWidth, widenColumn } from '../src/tables/widths.ts';

const all = [...commonmarkItems, ...gfmItems, ...pagemdItems()];
const t = createTransformer(all);
const registry = createRegistry({ items: new ItemRegistry([...all]), view: new ViewState() });
const get = (id: string): CommandSpec => registry.commands.get(id)!;

const T3 = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |';

function tableOf(doc: Node): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name === 'table' && !found) found = { node, pos };
    return !found;
  });
  return found!;
}

function stateFor(text: string, at: [number, number] = [0, 0]): EditorState {
  const doc = t.parse(text);
  const state = EditorState.create({ schema: t.schema, doc, plugins: tableEditingPlugins() });
  const { node, pos } = tableOf(doc);
  const map = TableMap.get(node);
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos + 1 + map.map[at[0] * map.width + at[1]]! + 1)));
}

/** Runs the command: the written text, which must read back as the document the command made. */
function act(id: string, text: string, at?: [number, number]): string {
  const state = stateFor(text, at);
  expect(get(id).isEnabled(state), `${id} enabled`).toBe(true);
  let next = state;
  expect(get(id).run(state, (tr) => (next = state.apply(tr)))).toBe(true);
  const written = t.serialize(next.doc);
  const again = t.parse(written);
  expect(JSON.stringify(again.toJSON()).includes(RAW_BLOCK)).toBe(false);
  expect(again.toJSON()).toEqual(next.doc.toJSON());
  return written;
}

describe('the arithmetic', () => {
  it('roundTo100: whole percentages adding up to 100', () => {
    expect(roundTo100([1, 1, 1])).toEqual([34, 33, 33]);
    expect(roundTo100([12.4, 37.6, 50])).toEqual([12, 38, 50]);
    expect(roundTo100([20, 20])).toEqual([50, 50]); // scaled up
    expect(roundTo100([0, 0])).toEqual([50, 50]);
  });

  it('completeWidths: set widths kept, unset ones share what is left; without the fixed layout the measured columns', () => {
    const layout = (pmdAttrs: [string, string][] | null): ReturnType<typeof layoutOf> => layoutOf(t.parse(`${T3}\n`).child(0).type.create({ ...t.parse(`${T3}\n`).child(0).attrs, pmdAttrs }, t.parse(`${T3}\n`).child(0).content));
    expect(completeWidths(layout([['data-col-widths', '50% * *']]))).toEqual([50, 25, 25]);
    expect(completeWidths(layout([['data-col-widths', '50% 30% 20%']]))).toEqual([50, 30, 20]);
    expect(completeWidths(layout([['class', 'fixed-layout']]), [60, 30, 10])).toEqual([34, 33, 33]); // fixed: equal is what shows
    expect(completeWidths(layout(null), [60.4, 29.6, 10])).toEqual([60, 30, 10]);
    expect(completeWidths(layout(null))).toEqual([34, 33, 33]);
  });

  it('moveBorder and widenColumn change two columns, never below 5%', () => {
    expect(moveBorder([50, 30, 20], 0, 10)).toEqual([60, 20, 20]);
    expect(moveBorder([50, 30, 20], 1, 40)).toEqual([50, 45, 5]);
    expect(widenColumn([50, 30, 20], 2, 5)).toEqual([50, 25, 25]); // the last column trades with its left neighbour
    expect(widenColumn([50, 30, 20], 0, -5)).toEqual([45, 35, 20]);
    expect(canWiden([5, 95], 0, -5)).toBe(false);
    expect(canWiden([100], 0, 5)).toBe(false);
  });

  it('a new column takes half its neighbour; a deleted one gives its width to the left', () => {
    expect(insertColumnWidth([50, 30, 20], 3, 2)).toEqual([50, 30, 10, 10]);
    expect(insertColumnWidth([50, 30, 20], 0, 0)).toEqual([25, 25, 30, 20]);
    expect(deleteColumnWidths([50, 30, 20], 1, 2)).toEqual([80, 20]);
    expect(deleteColumnWidths([50, 30, 20], 0, 1)).toEqual([80, 20]);
  });

  it('withLayout keeps the other pairs where they are; the class can sit with others', () => {
    expect(withLayout([['id', 't'], ['class', 'striped fixed-layout']], { fixedClass: false })).toEqual([['id', 't'], ['class', 'striped']]);
    expect(withLayout([['class', 'striped'], ['id', 't']], { fixedClass: true })).toEqual([['class', 'striped fixed-layout'], ['id', 't']]);
    expect(withLayout([['data-col-widths', '1% 99%'], ['class', 'a']], { widths: [40, 60] })).toEqual([['data-col-widths', '40% 60%'], ['class', 'a']]);
    expect(withLayout(null, { widths: [40, 60], fixedClass: true })).toEqual([['data-col-widths', '40% 60%'], ['class', 'fixed-layout']]);
    expect(withLayout([['data-col-widths', '40% 60%']], { widths: null })).toBeNull();
  });
});

describe('the canvas draws what pagemd writes (one reading of the attributes)', () => {
  /** The table's look from the editor's toDOM: the table's style and the `<col>` widths. */
  function editorLook(text: string): { style: string | null; cols: string[] | null } {
    const node = tableOf(t.parse(text)).node;
    const spec = node.type.spec.toDOM!(node) as unknown as unknown[];
    const table = spec[2] as unknown[];
    const attrs = table[1] as Record<string, string>;
    const group = (table.slice(2) as DOMOutputSpec[]).find((c) => Array.isArray(c) && c[0] === 'colgroup') as unknown[] | undefined;
    return { style: attrs['style'] ?? null, cols: group ? (group.slice(1) as [string, Record<string, string>][]).map(([, a]) => a['style'] ?? '') : null };
  }
  /** The same from pagemd's HTML (render mode). */
  function pagemdLook(text: string): { style: string | null; cols: string[] | null } {
    const html = createDialect().render(text);
    const style = /<table[^>]*\sstyle="([^"]*)"/.exec(html)?.[1] ?? null;
    const group = /<colgroup>([\s\S]*?)<\/colgroup>/.exec(html)?.[1];
    return { style, cols: group ? [...group.matchAll(/<col(?: style="([^"]*)")?>/g)].map((m) => m[1] ?? '') : null };
  }
  const cases = [`${T3}\n`, `${T3}\n{data-col-widths="50% 20% 30%"}\n`, `${T3}\n{data-col-widths="40% *"}\n`, `${T3}\n{.fixed-layout}\n`, `${T3}\n{data-col-widths="25% 25% 25% 25%" .striped}\n`, `${T3}\n{data-col-widths="* * *"}\n`, `${T3}\n{data-col-widths="12.5% 2in 87.5%"}\n`];
  for (const text of cases) {
    it(`the same table style and <col> widths: ${JSON.stringify(text.split('\n').at(-2))}`, () => {
      expect(editorLook(text)).toEqual(pagemdLook(text));
    });
  }

  it('control: the comparison sees a difference', () => {
    expect(editorLook(`${T3}\n{data-col-widths="50% 20% 30%"}\n`)).not.toEqual(pagemdLook(`${T3}\n{data-col-widths="50% 25% 25%"}\n`));
  });
});

describe('the width commands (Table tab, Width group)', () => {
  it('Wider / Narrower trade with the neighbour, starting from equal columns when there is no canvas', () => {
    expect(act('table.column-wider', `${T3}\n`, [0, 0])).toBe(`${T3}\n<!-- ::TABLE widths="39% 28% 33%" -->`);
    expect(act('table.column-narrower', `${T3}\n<!-- ::TABLE widths="50% 30% 20%" -->\n`, [0, 2])).toBe(`${T3}\n<!-- ::TABLE widths="50% 35% 15%" -->`);
    // round 3: an older {data-col-widths} line is read, and the change moves the widths into the hidden comment (AD-P19-22)
    expect(act('table.column-narrower', `${T3}\n{data-col-widths="50% 30% 20%"}\n`, [0, 2])).toBe(`${T3}\n<!-- ::TABLE widths="50% 35% 15%" -->`);
  });

  it('Narrower stops at 5%; Wider and Narrower need one column (not a table of one column)', () => {
    expect(get('table.column-narrower').isEnabled(stateFor(`${T3}\n{data-col-widths="5% 45% 50%"}\n`, [0, 0]))).toBe(false);
    expect(get('table.column-wider').isEnabled(stateFor(`${T3}\n{data-col-widths="5% 45% 50%"}\n`, [0, 0]))).toBe(true);
    expect(get('table.column-wider').isEnabled(stateFor('| A |\n| --- |\n| 1 |\n'))).toBe(false);
  });

  it('Equal widths writes widths="equal" in the hidden comment (the old spellings go, other classes stay) and shows as on; Automatic removes it', () => {
    const equal = act('table.equal-widths', `${T3}\n{data-col-widths="50% 30% 20%" .striped .fixed-layout}\n`);
    expect(equal).toBe(`${T3}\n{.striped}\n<!-- ::TABLE widths="equal" -->`);
    expect(get('table.equal-widths').isActive!(stateFor(`${equal}\n`))).toBe(true);
    expect(act('table.reset-widths', `${equal}\n`)).toBe(`${T3}\n{.striped}`);
    expect(get('table.equal-widths').isActive!(stateFor(`${T3}\n{.fixed-layout}\n`))).toBe(true); // the older class alone: equal columns too
    expect(act('table.reset-widths', `${T3}\n{data-col-widths="50% 30% 20%"}\n`)).toBe(T3);
    expect(get('table.reset-widths').isEnabled(stateFor(`${T3}\n{.striped}\n`))).toBe(false);
  });

  it('a "Table:" caption below moves above when the table gets its comment (pagemd reads it below neither)', () => {
    expect(act('table.equal-widths', `${T3}\n\nTable: Parts\n`)).toBe(`Table: Parts\n\n${T3}\n<!-- ::TABLE widths="equal" -->`);
  });

  it('FIX-FT: they work in a table with short rows (evened out first, AD-FIX-FT-05); Automatic still needs widths', () => {
    const ragged = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |\n';
    for (const id of ['table.column-wider', 'table.column-narrower', 'table.equal-widths']) expect(get(id).isEnabled(stateFor(ragged, [1, 0])), id).toBe(true);
    expect(get('table.reset-widths').isEnabled(stateFor(ragged, [1, 0]))).toBe(false);
    expect(act('table.equal-widths', ragged, [1, 0])).toBe('| A | B | C |  |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |  |  |\n<!-- ::TABLE widths="equal" -->');
  });
});

// The user's memo (pagemd-examples department-memo-uofo) with a fifth column added to the header and separator lines only.
const MEMO_HEAD = '| Crew | Field Block | Original Day | Revised Day |';
const MEMO_BODY = '| Crew A | East Block | Monday | Wednesday |\n| Crew B | North Block | Tuesday | Tuesday |';
const SPANNED = `${MEMO_HEAD}|\n| --- | --- | --- | --- | --- |\n${MEMO_BODY}\n`;
const EMPTY = `${MEMO_HEAD}  |\n| --- | --- | --- | --- | --- |\n${MEMO_BODY}\n`;

describe('the follow-up: a fifth column added to the header line only (P19, items 2 and 3)', () => {
  it("`||` at the end of a row is a span, as pagemd reads it: the last header cell spans columns 4 and 5", () => {
    const header = tableOf(t.parse(SPANNED)).node.child(0);
    expect([header.childCount, header.lastChild!.attrs['colspan'], header.lastChild!.textContent]).toEqual([4, 2, 'Revised Day']);
    expect(createDialect().render(SPANNED)).toContain('<th colspan="2">Revised Day</th>');
    expect(tableOf(t.parse(EMPTY)).node.child(0).childCount).toBe(5); // `|  |`: an empty fifth cell
  });

  it('both forms leave the body rows short (ragged): FIX-FT, the tools are on as in a plain table (AD-FIX-FT-05)', () => {
    for (const text of [SPANNED, EMPTY]) {
      const state = stateFor(text, [1, 0]);
      const off = [...registry.commands.list()].filter((c) => c.id.startsWith('table.') && c.id !== 'table.insert' && !c.isEnabled(state)).map((c) => c.id);
      expect(off.sort()).toEqual(['table.fit-column', 'table.merge-cells', 'table.move-column-left', 'table.move-row-up', 'table.reset-widths', ...(text === SPANNED ? [] : ['table.fill-rows-split'])].sort());
    }
  });

  it('Even out rows adds the missing empty cells (one change), and the tools work again', () => {
    expect(act('table.fill-rows', EMPTY, [1, 0])).toBe('| Crew | Field Block | Original Day | Revised Day |  |\n| --- | --- | --- | --- | --- |\n| Crew A | East Block | Monday | Wednesday |  |\n| Crew B | North Block | Tuesday | Tuesday |  |');
    expect(act('table.fill-rows', SPANNED, [1, 0])).toBe('| Crew | Field Block | Original Day | Revised Day ||\n| --- | --- | --- | --- | --- |\n| Crew A | East Block | Monday | Wednesday |  |\n| Crew B | North Block | Tuesday | Tuesday |  |');
    const filled = act('table.fill-rows', EMPTY, [1, 0]);
    expect(get('table.add-row-below').isEnabled(stateFor(`${filled}\n`, [1, 0]))).toBe(true);
    expect(act('table.column-wider', `${filled}\n`, [1, 0])).toBe(`${filled}\n<!-- ::TABLE widths="25% 15% 20% 20% 20%" -->`);
    expect(get('table.fill-rows').isEnabled(stateFor(`${filled}\n`, [1, 0]))).toBe(false);
  });

  it('Add column writes an empty cell `|  |` in every row (never `||`, which would be a span)', () => {
    expect(act('table.add-column-right', '| A | B |\n| --- | --- |\n| 1 | 2 |\n', [0, 1])).toBe('| A | B |  |\n| --- | --- | --- |\n| 1 | 2 |  |');
  });

  it('widths count real columns: a spanning cell takes the sum of its columns, on the canvas as in pagemd', () => {
    const text = '| A | B | C |\n|---|---|---|\n| wide || 3 |\n{data-col-widths="20% 30% 50%"}\n';
    expect(layoutOf(tableOf(t.parse(text)).node).widths).toEqual([20, 30, 50]);
    expect(createDialect().render(text)).toContain('<td colspan="2" style="width:50%">wide</td>');
  });
});

describe('the forms a width may take reach the canvas as pagemd reads them (follow-up, item 4)', () => {
  it('30%, 30, 30.5, 0.3 and .25 are read; 1 is not', () => {
    const widths = (v: string) => layoutOf(tableOf(t.parse(`${T3}\n{data-col-widths="${v}"}\n`)).node).widths;
    expect(widths('30% 30.5 0.3')).toEqual([30, 30.5, 30]);
    expect(widths('.25 1 *')).toEqual([25, null, null]);
  });
});

describe('columns added, deleted and moved keep the widths in step (sum 100)', () => {
  const W = `${T3}\n<!-- ::TABLE widths="50% 30% 20%" -->\n`;
  it('add right / left: half of the cursor column', () => {
    expect(act('table.add-column-right', W, [0, 2])).toBe('| A | B | C |  |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 |  |\n<!-- ::TABLE widths="50% 30% 10% 10%" -->');
    expect(act('table.add-column-left', W, [0, 0])).toBe('|  | A | B | C |\n| --- | --- | --- | --- |\n|  | 1 | 2 | 3 |\n<!-- ::TABLE widths="25% 25% 30% 20%" -->');
  });
  it('delete: the width goes to the left', () => {
    expect(act('table.delete-column', W, [0, 1])).toBe('| A | C |\n| --- | --- |\n| 1 | 3 |\n<!-- ::TABLE widths="80% 20%" -->');
  });
  it('move: the width goes with the column', () => {
    expect(act('table.move-column-right', W, [0, 0])).toBe('| B | A | C |\n| --- | --- | --- |\n| 2 | 1 | 3 |\n<!-- ::TABLE widths="30% 50% 20%" -->');
  });
  it('a table without widths gets none', () => {
    expect(act('table.add-column-right', `${T3}\n`, [0, 2])).toBe('| A | B | C |  |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 |  |');
  });
});

const editor: Editor = await createEditor({ presets: [commonmarkPreset, gfmPreset, pagemdPreset()] });
const reader = createTransformer(editor.registry.items(), { schema: editor.schema });

describe('the Inspector', () => {
  const sectionAt = (text: string, pos: number, name: string, id: string) => {
    const doc = reader.parse(text);
    const node = doc.nodeAt(pos)!;
    const selection = node.isTextblock || node.type.spec.tableRole ? TextSelection.create(doc, pos + 3) : NodeSelection.create(doc, pos);
    const state = EditorState.create({ doc, selection });
    const target = editor.registry.fieldsFor(state).find((x) => x.name === name);
    return { doc, state, target, section: target?.sections.find((s) => s.id === id) };
  };

  it('each column has Width (%); data-col-widths is not listed again under Other attributes', () => {
    const { section } = sectionAt(`${T3}\n{data-col-widths="50% * 20%" data-x="1"}\n`, 0, 'table', 'multimd-table');
    expect(section!.fields.find((f) => f.key === 'columns')!.fields!.map((f) => f.key)).toEqual(['align', 'wrap', 'width']);
    expect((section!.values['columns'] as { width?: number }[]).map((c) => c.width)).toEqual([50, undefined, 20]);
    expect(section!.values['other']).toEqual([{ key: 'data-x', value: '1' }]);
  });

  it('a typed width is written; an emptied box is "not set"; other attributes stay in place', () => {
    const text = `${T3}\n{data-x="1" data-col-widths="50% 30% 20%"}\n`; // the older spelling: the change migrates it
    const { doc, state, target, section } = sectionAt(text, 0, 'table', 'multimd-table');
    const columns = (section!.values['columns'] as Record<string, unknown>[]).map((c, k) => (k === 1 ? { ...c, width: undefined } : k === 0 ? { ...c, width: 60 } : c));
    const tr = state.tr;
    expect(editor.registry.applyFields(tr, target!, 'multimd-table', { ...section!.values, columns })).toBe(true);
    const out = applyEdits(text, diffToEdits(doc, tr.doc, text));
    expect(out).toBe(`${T3}\n{data-x="1"}\n<!-- ::TABLE widths="60% * 20%" -->\n`);
  });

  it('a table kept as raw text says why its tools are off; other raw blocks say nothing', () => {
    const raw = '| A | B |\n| --- | --- |\n| - item \\\n| two |\n';
    const doc = reader.parse(raw);
    expect(doc.child(0).type.name).toBe(RAW_BLOCK);
    const at = (d: Node) => editor.registry.fieldsFor(EditorState.create({ doc: d, selection: NodeSelection.create(d, 0) }));
    const note = at(doc).find((x) => x.name === RAW_BLOCK)?.sections[0];
    expect(note?.fields.map((f) => [f.key, f.readOnly])).toEqual([['tools', true]]);
    expect(note?.values['tools']).toContain('Off');
    const quote = reader.parse('> **Note:** a quote\n{.note}\n');
    expect(quote.child(0).type.name).toBe(RAW_BLOCK);
    expect(at(quote).filter((x) => x.name === RAW_BLOCK)).toEqual([]);
  });
});
