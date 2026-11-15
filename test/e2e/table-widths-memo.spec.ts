// P19 follow-up, on a copy of the user's own file (pagemd-examples department-memo-uofo, its profile, template and styles; the
// logo left out), in Print Layout with the styles style-pagemd resolves:
// - the Table tab's buttons are on with the cursor in a table and off outside (the user's "does nothing" report);
// - a click right next to a cell border puts the cursor in that cell (P19's border handle swallowed it before);
// - the table shape the user made by adding a fifth column to the header line only (body rows one cell short): FIX-FT
//   (AD-FIX-FT-05), its tools are on; "Even out rows" still adds the missing cells as one change;
// - dragging a border shows the two widths by the pointer and says the result in the live region once; nothing is written
//   until release;
// - a double-click on a border fits the column on its left to its content (one change); "Fit column to content" does the same
//   from the Table tab; nothing in Read.
// Run: npm run test:e2e (builds first).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { quiet } from '../support/quiet.ts';
import { openInPrintLayout, settle } from './pagination-harness.ts';

const DIR = new URL('./fixtures/table-widths/department-memo-uofo/', import.meta.url).pathname;
const PATH = `${DIR}uofo-harvest-schedule-memo.md`;
const MEMO = readFileSync(PATH, 'utf8');
const HEAD = '| Crew        | Field Block | Original Day | Revised Day |\n| ----------- | ----------- | ------------- | ------------- |';
const EMPTY_COLUMN = MEMO.replace(HEAD, '| Crew | Field Block | Original Day | Revised Day |  |\n| --- | --- | --- | --- | --- |');

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
/** The host's side: answers every edit request not answered yet and returns its text and how many edits it got. */
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

async function open(page: Page, text = MEMO): Promise<() => Promise<{ text: string; edits: number }>> {
  await page.setViewportSize({ width: 1400, height: 1100 });
  await openInPrintLayout(page, PATH, text, pathToFileURL(DIR).href);
  return pretendHost(page, text);
}

const cell = (page: Page, text: string) => page.locator('.pmd-canvas td, .pmd-canvas th').filter({ hasText: new RegExp(`^${text}$`) }).first();
const button = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const isOff = async (page: Page, command: string) => (await button(page, command).getAttribute('aria-disabled')) === 'true';
const cursorText = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $from: { parent: { textContent: string } } } } } } } }).__pmd.canvas.view.state.selection.$from.parent.textContent);
const tableTab = (page: Page) => page.locator('.pmd-ribbon').getByRole('tab', { name: 'Table', exact: true }).click();
const announced = (page: Page) => page.locator('.pmd-announcer').textContent();

test.describe('P19 follow-up on the user\'s memo', () => {
  test('the Table tab: buttons on with the cursor in the table, off outside; Add row and Wider work', async ({ page }) => {
    const host = await open(page);
    await tableTab(page);
    await cell(page, 'East Block').click();
    await expect.poll(() => isOff(page, 'table.add-row-below')).toBe(false);
    expect(await isOff(page, 'table.column-wider')).toBe(false);
    await page.locator('.pmd-canvas .ProseMirror p').first().click();
    await expect.poll(() => isOff(page, 'table.add-row-below')).toBe(true);
    expect(await isOff(page, 'table.column-wider')).toBe(true);
    await cell(page, 'East Block').click();
    await button(page, 'table.column-wider').click();
    await expect.poll(async () => (await host()).text).toMatch(/\n<!-- ::TABLE widths="\d+% \d+% \d+% \d+%" -->\n/);
  });

  test('a click right next to a cell border puts the cursor in that cell', async ({ page }) => {
    await open(page);
    await page.locator('.pmd-canvas .ProseMirror p').first().click();
    const box = (await cell(page, 'East Block').boundingBox())!;
    await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
    await expect.poll(() => cursorText(page)).toBe('East Block');
  });

  test('a fifth column on the header line only: the tools are on (FIX-FT); Even out rows fills the short rows as one change', async ({ page }) => {
    const host = await open(page, EMPTY_COLUMN);
    await tableTab(page);
    await cell(page, 'East Block').click();
    await expect.poll(() => isOff(page, 'table.fill-rows')).toBe(false);
    for (const command of ['table.add-row-below', 'table.add-column-right', 'table.column-wider', 'table.equal-widths']) expect(await isOff(page, command), command).toBe(false);
    expect(await button(page, 'table.fill-rows').getAttribute('title')).toContain('short rows');
    await button(page, 'table.fill-rows').click();
    await expect.poll(async () => (await host()).text).toContain('| Crew A | East Block | Monday | Wednesday |  |\n| Crew B | North Block | Tuesday | Tuesday |  |\n| Crew C | South Block | Wednesday | Thursday |  |');
    expect((await host()).edits).toBe(1);
    await expect.poll(() => isOff(page, 'table.add-row-below')).toBe(false);
  });

  test('dragging a border: the two widths by the pointer, nothing written until release, the result said once', async ({ page }) => {
    const host = await open(page);
    const box = (await cell(page, 'Crew A').boundingBox())!;
    const x = box.x + box.width - 1;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let k = 1; k <= 6; k++) await page.mouse.move(x + k * 10, y);
    const readout = page.locator('.pmd-col-readout');
    await expect(readout).toBeVisible();
    expect(await readout.textContent()).toMatch(/^\d+(\.5)?% \| \d+(\.5)?%$/);
    expect(await readout.getAttribute('aria-hidden')).toBe('true');
    expect((await host()).edits).toBe(0);
    const shown = (await readout.textContent())!;
    await page.mouse.up();
    await expect(readout).toHaveCount(0);
    await expect.poll(async () => (await host()).edits).toBe(1);
    const [left, right] = shown.split(' | ');
    expect((await host()).text).toContain(`${left} ${right}`); // what the readout showed is what is written
    await expect.poll(() => announced(page)).toContain(`Column widths ${left} and ${right}`);
  });

  test('double-click on a border fits the column on its left to its content; the Fit button does the same; not in Read', async ({ page }) => {
    const host = await open(page);
    const before = await cell(page, 'Crew A').evaluate((c) => c.getBoundingClientRect().width);
    const box = (await cell(page, 'Crew A').boundingBox())!;
    await page.mouse.dblclick(box.x + box.width - 1, box.y + box.height / 2);
    await expect.poll(async () => (await host()).edits).toBe(1);
    const widths = /<!-- ::TABLE widths="([^"]*)" -->/.exec((await host()).text)![1]!.split(' ').map((w) => parseFloat(w));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
    // "Crew A" is short: the column gets narrower than its equal share, and wide enough for its longest cell on one line
    const after = await cell(page, 'Crew A').evaluate((c) => c.getBoundingClientRect().width);
    expect(after).toBeLessThan(before);
    for (const text of ['Crew', 'Crew A', 'Crew B', 'Crew C']) expect(await cell(page, text).evaluate((c) => c.getBoundingClientRect().height), text).toBeLessThan(40);
    await expect.poll(() => announced(page)).toContain('Column fitted to its content');
    // the keyboard way: the Table tab's Fit on the second column
    await tableTab(page);
    await cell(page, 'North Block').click();
    await button(page, 'table.fit-column').click();
    await expect.poll(async () => (await host()).edits).toBe(2);
    // Read: no fitting
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'read' } });
    await settle(page);
    const b2 = (await cell(page, 'Crew A').boundingBox())!;
    await page.mouse.dblclick(b2.x + b2.width - 1, b2.y + b2.height / 2);
    await quiet(page);
    expect((await host()).edits).toBe(2);
  });
});
