// OQ-49 (P19 round 3): the canvas holds a table's rows in one <tbody> and marks header rows with a class; pagemd's
// `thead` rules are turned into rules for that class, and `tbody > tr` rules leave header rows out, so the profile's
// own CSS decides how a header row looks on the canvas, as in pagemd's PDF (pagemd's base.css: header text on the left).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HEAD_ROW_CLASS as PRESET_CLASS } from '@pagemd-editor/preset-pagemd';
import { HEAD_ROW_CLASS, scopeCss, tableHeadSelector } from '../src/index.ts';

describe('thead / tbody selectors on the canvas (OQ-49)', () => {
  it('rewrites thead and tbody row rules; leaves other selectors alone', () => {
    expect(tableHeadSelector('table > thead > tr > th')).toBe('table > tbody > tr.pmd-head-row > th');
    expect(tableHeadSelector('thead th')).toBe('tbody > tr.pmd-head-row th');
    expect(tableHeadSelector('thead')).toBe('tbody > tr.pmd-head-row');
    expect(tableHeadSelector('table.striped > tbody > tr:nth-child(2n)')).toBe('table.striped > tbody > tr:not(.pmd-head-row):nth-child(2n)');
    expect(tableHeadSelector('tbody td')).toBe('tbody td');
    expect(tableHeadSelector('.theader > p')).toBe('.theader > p');
    expect(tableHeadSelector('table td[colspan]')).toBe('table td[colspan]');
  });

  it("pagemd's base.css: the header-cell rule reaches the canvas's header rows", () => {
    const base = readFileSync(fileURLToPath(new URL('../../../../pagemd/styles/base.css', import.meta.url)), 'utf8');
    const css = scopeCss(base).css;
    expect(css).toContain('.pmd-canvas table > tbody > tr.pmd-head-row > th');
    expect(css).not.toMatch(/\.pmd-canvas [^{]*thead/);
  });

  it('the canvas and the scoping use the same class', () => {
    expect(PRESET_CLASS).toBe(HEAD_ROW_CLASS);
  });
});
