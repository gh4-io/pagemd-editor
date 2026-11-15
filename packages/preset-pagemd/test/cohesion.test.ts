// P4: the cohesion-matrix completeness check (roadmap checkpoint 4; the plan's "a script compares registry items
// to the matrix"). Reads the pagemd table of test/cohesion/cohesion-matrix.md (moved from docs/ in SAN-0b): every pagemd item has a row,
// every item a row names exists, and a ✓ under Slash or Outline means the item really has slash keywords or an
// outline entry.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIALECT_ID, pagemdItems } from '../src/index.ts';

const MATRIX = fileURLToPath(new URL('../../../test/cohesion/cohesion-matrix.md', import.meta.url));

interface Row {
  name: string;
  slash: boolean;
  outline: boolean;
  ids: string[];
  later: boolean;
}

/** The rows of the "### pagemd" table. */
export function pagemdRows(markdown: string): Row[] {
  const section = markdown.slice(markdown.indexOf('### pagemd ('), markdown.indexOf('### Core safety net'));
  const lines = section.split('\n').filter((line) => line.startsWith('|'));
  const header = lines[0]!.split('|').map((c) => c.trim());
  const col = (name: string): number => header.indexOf(name);
  return lines.slice(2).map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    const idCell = cells[col('Item id')] ?? '';
    return {
      name: cells[col('Item')]!,
      slash: (cells[col('Slash')] ?? '').startsWith('✓'),
      outline: (cells[col('Outline')] ?? '').startsWith('✓'),
      ids: [...idCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
      later: /\(P\d+\)/.test(idCell),
    };
  });
}

describe('cohesion matrix ↔ preset-pagemd registry', () => {
  const rows = pagemdRows(readFileSync(MATRIX, 'utf8'));
  const items = pagemdItems().filter((item) => item.id !== DIALECT_ID);

  it('the table has its rows and an Item id column', () => {
    expect(rows.length).toBeGreaterThanOrEqual(24);
    expect(rows.every((row) => row.ids.length > 0 || row.later)).toBe(true);
  });

  it('every pagemd item has a row', () => {
    const named = new Set(rows.flatMap((row) => row.ids));
    expect(items.map((item) => item.id).filter((id) => !named.has(id))).toEqual([]);
  });

  it('every item a row names exists', () => {
    const ids = new Set(items.map((item) => item.id));
    expect(rows.flatMap((row) => row.ids).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('✓ under Slash means slash keywords; ✓ under Outline means an outline entry', () => {
    const problems: string[] = [];
    for (const row of rows) {
      for (const id of row.ids) {
        const item = items.find((i) => i.id === id)!;
        if (row.slash && !item.slash?.keywords.length) problems.push(`${id}: no slash keywords`);
        if (row.outline && !item.outline) problems.push(`${id}: no outline entry`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every item has a label and an icon', () => {
    expect(items.filter((item) => !item.label || !item.icon).map((item) => item.id)).toEqual([]);
  });

  it('control: a missing row is caught', () => {
    const without = readFileSync(MATRIX, 'utf8').replace(/^\| `PAGEBREAK`.*\n/m, '');
    const named = new Set(pagemdRows(without).flatMap((row) => row.ids));
    expect(items.map((item) => item.id).filter((id) => !named.has(id))).toEqual(['pagebreak']);
  });
});
