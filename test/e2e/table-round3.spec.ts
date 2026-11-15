// P19 round 3 in a real browser (Chromium), on the copy of the user's memo (its profile, template and styles), Print Layout
// unless a test says otherwise:
// - the Table tab comes forward when the cursor goes into a table, the earlier tab comes back when it leaves, and a tab picked
//   by hand while in the table is kept (the user's answer);
// - a header cell's text is on the left, as pagemd's PDF has it (the profile's own `thead` rule reaches the canvas: OQ-49);
// - a table not in standard form (a column added to the header and separator lines only): in Print Layout, Web Layout, Draft
//   and Split the Table tab works and never throws, and (FIX-FT, AD-FIX-FT-04/05/06, Word's way) its tools are on with no bar
//   above it: a tool evens the table out and makes its own change in one edit of that table only; clicking in it writes
//   nothing; typing in it evens it out in the same edit; Read draws it as it is;
// - spanning cells (|| and ^^) with widths: drag, double-click fit and Equal write the hidden comment.
// Run: npm run test:e2e (builds first).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { frames, quiet } from '../support/quiet.ts';
import { openInPrintLayout, settle } from './pagination-harness.ts';

const DIR = new URL('./fixtures/table-widths/department-memo-uofo/', import.meta.url).pathname;
const PATH = `${DIR}uofo-harvest-schedule-memo.md`;
const MEMO = readFileSync(PATH, 'utf8');
const HEAD = '| Crew        | Field Block | Original Day | Revised Day |\n| ----------- | ----------- | ------------- | ------------- |';
const BROKEN = MEMO.replace(HEAD, '| Crew | Field Block | Original Day | Revised Day |  |\n| --- | --- | --- | --- | --- |');
const SPANNED = MEMO.replace(
  /\| Crew {8}\| Field Block[\s\S]*?\| Crew C[^\n]*\n/,
  '| Crew | Field Block | Original Day | Revised Day |\n| --- | --- | --- | --- |\n| Crew A | East Block || Wednesday |\n| Crew B | North Block | Tuesday | Tuesday |\n| ^^ | South Block | Wednesday | Thursday |\n<!-- ::TABLE widths="20% 30% 25% 25%" -->\n',
);

type Edit = { from: number; to: number; text: string };
const apply = (text: string, edits: Edit[]): string => {
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.from) + e.text;
    at = e.to;
  }
  return out + text.slice(at);
};
function pretendHost(page: Page, start: string): () => Promise<{ text: string; edits: number }> {
  let text = start;
  let answered = 0;
  return async () => {
    const requests = (await sent(page)).filter((m) => m.method === 'applyEdits');
    for (; answered < requests.length; answered++) {
      const request = requests[answered]!;
      text = apply(text, (request.params as { edits: Edit[] }).edits);
      await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: answered + 2 } });
    }
    return { text, edits: answered };
  };
}

async function open(page: Page, text = MEMO, mode = 'print'): Promise<{ host: () => Promise<{ text: string; edits: number }>; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 1100 });
  await openInPrintLayout(page, PATH, text, pathToFileURL(DIR).href);
  if (mode !== 'print') {
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
    await frames(page);
    await settle(page);
  }
  return { host: pretendHost(page, text), errors };
}

const cell = (page: Page, text: string) => page.locator('.pmd-canvas td, .pmd-canvas th').filter({ hasText: new RegExp(`^${text}$`) }).first();
const button = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const selectedTab = (page: Page) => page.locator('.pmd-ribbon [role="tab"][aria-selected="true"]').textContent();
const tab = (page: Page, name: string) => page.locator('.pmd-ribbon').getByRole('tab', { name, exact: true });
const prompt = (page: Page) => page.locator('.pmd-canvas .pmd-table-prompt, .pmd-canvas .pmd-table-prompt-box');
const firstParagraph = (page: Page) => page.locator('.pmd-canvas .ProseMirror p').first();

test.describe('P19 round 3', () => {
  test('the Table tab comes forward in a table and goes back after; a tab picked by hand is kept', async ({ page }) => {
    await open(page);
    expect(await selectedTab(page)).toBe('Home');
    await cell(page, 'East Block').click();
    await expect.poll(() => selectedTab(page)).toBe('Table');
    await cell(page, 'Monday').click(); // another cell: stays
    expect(await selectedTab(page)).toBe('Table');
    await firstParagraph(page).click();
    await expect.poll(() => selectedTab(page)).toBe('Home');
    // picked by hand while in the table: kept, also after leaving
    await cell(page, 'East Block').click();
    await expect.poll(() => selectedTab(page)).toBe('Table');
    await tab(page, 'Insert').click();
    await cell(page, 'Monday').click();
    expect(await selectedTab(page)).toBe('Insert');
    await firstParagraph(page).click();
    await quiet(page);
    expect(await selectedTab(page)).toBe('Insert');
  });

  test("header text is on the left, as pagemd's PDF has it (the profile's thead rule reaches the canvas)", async ({ page }) => {
    await open(page);
    const style = await cell(page, 'Field Block').evaluate((c) => {
      const s = getComputedStyle(c);
      return { align: s.textAlign, row: c.parentElement!.className };
    });
    expect(style).toEqual({ align: 'left', row: 'pmd-head-row' });
  });

  for (const mode of ['print', 'web', 'draft', 'split'] as const) {
    test(`${mode}: a table not in standard form: the tools are on, no bar; a tool evens it out and adds its row in one edit`, async ({ page }) => {
      const { host, errors } = await open(page, BROKEN, mode);
      await cell(page, 'East Block').click();
      await expect.poll(() => selectedTab(page)).toBe('Table');
      await expect(page.locator('.pmd-ribbon-panel button')).not.toHaveCount(0);
      await expect.poll(() => button(page, 'table.add-row-below').getAttribute('aria-disabled')).toBe('false');
      await expect(prompt(page)).toHaveCount(0);
      await quiet(page);
      expect((await host()).edits).toBe(0); // clicking in it writes nothing
      await button(page, 'table.add-row-below').click();
      await expect.poll(async () => (await host()).text).toContain('| Crew A | East Block | Monday | Wednesday |  |\n|  |  |  |  |  |\n| Crew B | North Block | Tuesday | Tuesday |  |\n| Crew C | South Block | Wednesday | Thursday |  |');
      expect((await host()).edits).toBe(1);
      // only that table's lines changed
      const outside = (text: string): string => text.replace(/\| Crew \|[\s\S]*?\| Crew C[^\n]*\n/, '<table>\n');
      expect(outside((await host()).text)).toBe(outside(BROKEN));
      expect(errors).toEqual([]);
    });
  }

  test('typing in a table not in standard form evens it out in the same edit; Read draws it as it is, with no bar', async ({ page }) => {
    const { host } = await open(page, BROKEN);
    await cell(page, 'Monday').click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await expect.poll(async () => (await host()).text).toContain('| Crew A | East Block | Monday! | Wednesday |  |');
    expect((await host()).edits).toBe(1);
    expect((await host()).text).toContain('| Crew C | South Block | Wednesday | Thursday |  |');
    // Read: drawn as written (the short rows stay short), nothing above it
    const fresh = await page.context().newPage();
    await open(fresh, BROKEN, 'read');
    const row = fresh.locator('.pmd-canvas tr').filter({ hasText: 'East Block' }).first();
    await expect(row.locator('td')).toHaveCount(4);
    await expect(fresh.locator('.pmd-canvas .pmd-table-prompt')).toHaveCount(0);
  });

  test('spanning cells with widths: drag, double-click fit and Equal write the hidden comment; the tab stays usable', async ({ page }) => {
    const { host, errors } = await open(page, SPANNED);
    await expect.poll(() => cell(page, 'Crew A').evaluate((c) => [...c.closest('table')!.querySelectorAll(':scope > colgroup > col')].map((x) => (x as HTMLElement).style.width))).toEqual(['20%', '30%', '25%', '25%']);
    const box = (await cell(page, 'Crew B').boundingBox())!;
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
    await page.mouse.down();
    for (let k = 1; k <= 4; k++) await page.mouse.move(box.x + box.width - 1 + k * 8, box.y + box.height / 2);
    await page.mouse.up();
    // the drag's own edit (not the starting widths: the webview sends after a short pause)
    await expect.poll(async () => (await host()).edits).toBe(1);
    expect((await host()).text).toMatch(/\| \^\^ \| South Block \| Wednesday \| Thursday \|\n<!-- ::TABLE widths="2[1-9](\.5)?% \d+(\.5)?% 25% 25%" -->/);
    // Crew B's column was widened by the drag: fitting it to its short text narrows it again (a second change)
    const b2 = (await cell(page, 'Crew B').boundingBox())!;
    await page.mouse.dblclick(b2.x + b2.width - 1, b2.y + b2.height / 2);
    await expect.poll(async () => (await host()).edits).toBe(2);
    await cell(page, 'Tuesday').first().click();
    await button(page, 'table.equal-widths').click();
    await expect.poll(async () => (await host()).text).toContain('<!-- ::TABLE widths="equal" -->');
    expect((await host()).text).toContain('| Crew A | East Block || Wednesday |');
    expect(errors).toEqual([]);
  });
});
