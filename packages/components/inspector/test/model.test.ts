// P8: the Inspector's decisions without a DOM (the drawn parts are covered by Playwright, AD-P7-12): which properties
// the Document tab lists and how they are marked, how typed text becomes a value per field type, and list/group edits.
import { describe, expect, it } from 'vitest';
import type { FieldSpec, MetaCatalogue, PropertiesState } from '@pagemd-editor/core';
import { documentModel, getIn, helpOf, listEdit, NO_HINTS, newRow, parseInput, pickerColor, setIn, textOf } from '../src/index.ts';

const field = (key: string, type: FieldSpec['type'], extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, type, label: key.replace(/_/g, ' '), help: `${key} help`, aliases: [], sources: ['parser'], ...extra });
const META: MetaCatalogue = {
  version: '1',
  fields: [
    field('title', 'string', { default: '' }),
    field('document_id', 'string'),
    field('revision', 'number', { default: 0 }),
    field('effective_date', 'date'),
    field('fancy_lists', 'boolean'),
    field('status', 'enum', { values: ['draft', 'final'] }),
    field('styles', 'list'),
    field('timestamp', 'string', { generated: true }),
    field('author', 'string'),
  ],
  aliases: { doc_id: 'document_id', date: 'effective_date' },
  gates: {},
};
const state = (entries: PropertiesState['entries'], error?: string): PropertiesState => ({ pos: 0, yaml: 'x', entries, ...(error ? { error } : {}) });

describe('the Document tab (documentModel)', () => {
  it('lists what the document has, in written order, typed by the catalogue; nicknames kept', () => {
    const model = documentModel(
      state([
        { key: 'title', written: 'title', value: 'Guide' },
        { key: 'document_id', written: 'doc_id', value: 'X-1' },
        { key: 'effective_date', written: 'date', value: new Date('2024-01-15T00:00:00Z') },
        { key: 'fancy_lists', written: 'fancy_lists', value: true },
        { key: 'my_own', written: 'my_own', value: 3 },
      ]),
      META,
      NO_HINTS,
    );
    expect(model.rows.map((r) => [r.key, r.written, r.type])).toEqual([
      ['title', 'title', 'string'],
      ['document_id', 'doc_id', 'string'],
      ['effective_date', 'date', 'date'],
      ['fancy_lists', 'fancy_lists', 'boolean'],
      ['my_own', 'my_own', 'number'], // not in the catalogue: typed by its value
    ]);
  });

  it('then the required and shown-on-page properties it lacks (empty, marked); defaults from the profile, else pagemd', () => {
    const model = documentModel(state([{ key: 'title', written: 'title', value: 'G' }]), META, { required: ['title', 'author'], shownOnPage: ['revision', 'doc_id'], profileFields: [], defaults: { author: 'TBD' } });
    expect(model.rows.map((r) => [r.key, r.written ?? '—', r.required, r.shownOnPage, r.fallback ?? '—'])).toEqual([
      ['title', 'title', true, false, '—'],
      ['author', '—', true, false, 'TBD'],
      ['revision', '—', false, true, 0],
      ['document_id', '—', false, true, '—'], // the template's nickname named by the catalogue
    ]);
  });

  it('"Add property" offers the rest of the catalogue and the profile\'s own fields, never generated ones', () => {
    const model = documentModel(state([{ key: 'title', written: 'title', value: 'G' }]), META, { ...NO_HINTS, profileFields: [field('doc_type', 'string', { sources: ['profile'] })] });
    const keys = model.addable.map((a) => a.key);
    expect(keys).toContain('doc_type');
    expect(keys).toContain('author');
    expect(keys).not.toContain('title'); // already there
    expect(keys).not.toContain('timestamp'); // generated
  });

  it('values too complex for the form are edited in the raw YAML; unreadable YAML shows the error and no rows', () => {
    const model = documentModel(state([{ key: 'cover', written: 'cover', value: { a: 1 } }, { key: 'styles', written: 'styles', value: ['a.css'] }]), META, NO_HINTS);
    expect(model.rows.map((r) => r.type)).toEqual(['raw', 'list']);
    const bad = documentModel(state([], 'bad indentation'), META, NO_HINTS);
    expect(bad).toMatchObject({ rows: [], error: 'bad indentation', exists: true });
    expect(documentModel(null, META, NO_HINTS).exists).toBe(false);
  });
});

describe('typed text → values (the type is checked; limits are help only, R-160 amendment 5)', () => {
  it.each([
    ['number', '12', { value: 12 }],
    ['number', ' 1.5 ', { value: 1.5 }],
    ['number', 'twelve', { problem: 'A number is needed here.' }],
    ['date', '2026-10-04', { value: '2026-10-04' }],
    ['date', '4 Oct', { problem: 'A date like 2026-10-04 is needed here.' }],
    ['boolean', 'TRUE', { value: true }],
    ['string', '  kept as typed ', { value: '  kept as typed ' }],
    ['string', '   ', { value: undefined }],
  ] as const)('%s %j', (type, text, expected) => {
    expect(parseInput(type, text)).toEqual(expected);
  });
  it('help shows the limits', () => {
    expect(helpOf({ help: '% of the image', min: 0, max: 100 })).toBe('% of the image (0 to 100)');
    expect(helpOf({ min: 1 })).toBe('(at least 1)');
  });
  it('shows values as text: calendar dates as written', () => {
    expect(textOf(new Date('2024-01-15T00:00:00Z'))).toBe('2024-01-15');
    expect([textOf(undefined), textOf(3), textOf(false)]).toEqual(['', '3', 'false']);
  });
});

describe('lists and groups (D6: list rows add / remove / reorder, colors)', () => {
  it('setIn changes one value deep inside, without touching the input', () => {
    const values = { markers: [{ id: '1', x: 10 }], options: { caption: 'C' } };
    const next = setIn(values, ['markers', 0, 'x'], 20) as typeof values;
    expect(next.markers[0]!.x).toBe(20);
    expect(values.markers[0]!.x).toBe(10);
    expect(setIn(values, ['options', 'caption'], undefined)).toEqual({ markers: values.markers, options: {} });
    expect(getIn(next, ['markers', 0, 'x'])).toBe(20);
  });
  it('rows move, are removed and added', () => {
    expect(listEdit(['a', 'b', 'c'], { move: 0, by: 1 })).toEqual(['b', 'a', 'c']);
    expect(listEdit(['a', 'b'], { move: 0, by: -1 })).toEqual(['a', 'b']); // already first
    expect(listEdit(['a', 'b'], { remove: 0 })).toEqual(['b']);
    expect(listEdit(undefined, { add: 'x' })).toEqual(['x']);
  });
  it('a new row: positions in the middle, a required id numbered, defaults left to the renderer', () => {
    const fields = [
      { key: 'id', type: 'string', label: 'Number', required: true },
      { key: 'x', type: 'number', label: 'X', min: 0, max: 100 },
      { key: 'color', type: 'color', label: 'Color', default: '#cc0000' },
    ] as const;
    expect(newRow(fields, 2)).toEqual({ id: '3', x: 50 });
  });
  it('the color picker takes #rrggbb (and #rgb); other colors stay text only', () => {
    expect([pickerColor('#CC0000'), pickerColor('#abc'), pickerColor('red'), pickerColor('none')]).toEqual(['#cc0000', '#aabbcc', undefined, undefined]);
  });
});
