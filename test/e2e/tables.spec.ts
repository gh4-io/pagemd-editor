// P16 in a real browser (Chromium) with a pretend host: Tab / Shift+Tab / Enter move between cells (Tab in the last cell
// adds a row), Tab still indents a list outside a table, a dragged cell selection then Merge, the Table tab's buttons are
// on only in a table. (Ragged tables are in the unit tests and table-round3.) Run: npm run test:e2e (builds first).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const PLAIN = { styles: null, gateDefaults: {}, notes: [] };
const TABLE = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';
const TEXT = `# Title\n\n- one\n- two\n\n${TABLE}\n\nAfter.\n`;

type Edit = { from: number; to: number; text: string };

async function waitFor(page: Page, match: (m: Message) => boolean, nth = 0): Promise<Message> {
  let found: Message | undefined;
  await expect.poll(async () => (found = (await sent(page)).filter(match)[nth]), { timeout: 5000 }).toBeTruthy();
  return found!;
}

async function open(page: Page, text = TEXT) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: PLAIN, settings: { gatedInsert: 'ask' }, output: [], mermaidScript: '' },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
  return errors;
}

/** The text the host has after answering every applyEdits (as the host does) until it matches. */
async function hostReaches(page: Page, expected: string | RegExp, text: string): Promise<string> {
  let current = text;
  let answered = 0;
  await expect
    .poll(
      async () => {
        const requests = (await sent(page)).filter((m) => m.method === 'applyEdits');
        for (; answered < requests.length; answered++) {
          const request = requests[answered]!;
          let out = '';
          let at = 0;
          for (const e of (request.params as { edits: Edit[] }).edits) {
            out += current.slice(at, e.from) + e.text;
            at = e.to;
          }
          current = out + current.slice(at);
          await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: answered + 2 } });
        }
        return typeof expected === 'string' ? current === expected : expected.test(current);
      },
      { timeout: 6000 },
    )
    .toBe(true);
  return current;
}

const tab = (page: Page, name: string) => page.locator('.pmd-ribbon').getByRole('tab', { name, exact: true });
const button = (page: Page, command: string) => page.locator('.pmd-ribbon').locator(`[data-command="${command}"]`);
const cell = (page: Page, text: string): Locator => page.locator('.pmd-canvas td, .pmd-canvas th').filter({ hasText: new RegExp(`^${text}$`) });
const cursor = (page: Page) =>
  page.evaluate(() => {
    const { $from } = (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $from: { parent: { textContent: string } } } } } } } }).__pmd.canvas.view.state.selection;
    return $from.parent.textContent;
  });

/** Clicks a cell and waits until the editor knows the cursor is in it (it learns of a click one browser event later). */
async function inCell(page: Page, text: string): Promise<void> {
  await cell(page, text).click();
  await expect.poll(() => cursor(page)).toBe(text);
}

test.describe('table editing', () => {
  test('Tab and Shift+Tab move between cells, Enter goes down, Tab in the last cell adds a row (one edit of that table only)', async ({ page }) => {
    const errors = await open(page);
    await inCell(page, 'A');
    await page.keyboard.press('Tab');
    await expect.poll(() => cursor(page)).toBe('B');
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => cursor(page)).toBe('A');
    await page.keyboard.press('Enter');
    await expect.poll(() => cursor(page)).toBe('1');
    await inCell(page, '6');
    await page.keyboard.press('Enter'); // the last row: stays
    await expect.poll(() => cursor(page)).toBe('6');
    await page.keyboard.press('Tab');
    await expect(page.locator('.pmd-canvas table tr')).toHaveCount(4); // the header row, three body rows
    await page.keyboard.type('x');
    const saved = await hostReaches(page, /\| x \|/, TEXT);
    expect(saved).toBe(TEXT.replace('| 4 | 5 | 6 |', '| 4 | 5 | 6 |\n| x |  |  |'));
    expect(errors).toEqual([]);
  });

  test('Tab outside a table still indents a list item; inside a table it moves between cells (the table keys do nothing elsewhere)', async ({ page }) => {
    const errors = await open(page);
    await page.locator('.pmd-canvas li', { hasText: 'two' }).click();
    await expect.poll(() => cursor(page)).toBe('two');
    await page.keyboard.press('Tab');
    await expect(page.locator('.pmd-canvas ul ul li')).toHaveText('two');
    const saved = await hostReaches(page, /- one\n\s+- two/, TEXT);
    expect(saved).toContain(TABLE); // the table was not touched
    expect(errors).toEqual([]);
  });

  test('the Table tab: its buttons are on only in a table; a drag across cells then Merge joins them', async ({ page }) => {
    const errors = await open(page);
    await tab(page, 'Table').click();
    await expect(button(page, 'table.add-row-below')).toBeDisabled(); // the cursor is not in a table
    await expect(button(page, 'table.delete')).toBeDisabled();
    await inCell(page, '2');
    await expect(button(page, 'table.add-row-below')).toBeEnabled();
    await expect(button(page, 'table.merge-cells')).toBeDisabled(); // one cell
    await expect(button(page, 'table.align-center')).toBeEnabled();
    const from = await cell(page, '1').boundingBox();
    const to = await cell(page, '2').boundingBox();
    await page.mouse.move(from!.x + 6, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width - 6, to!.y + to!.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.pmd-canvas .selectedCell')).toHaveCount(2);
    await expect(button(page, 'table.merge-cells')).toBeEnabled();
    await button(page, 'table.merge-cells').click();
    const saved = await hostReaches(page, /1 2 \|\|/, TEXT);
    expect(saved).toBe(TEXT.replace('| 1 | 2 | 3 |', '| 1 2 || 3 |'));
    // the merged table is still a table on the canvas (it reads back as one)
    await expect(page.locator('.pmd-canvas td[colspan="2"]')).toHaveText('1 2');
    // away from the table the tools are off again
    await page.locator('.pmd-canvas p', { hasText: 'After.' }).click();
    await expect(button(page, 'table.add-row-below')).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('Arrow down from the last row leaves the table; Backspace on selected cells empties them (one edit of that table)', async ({ page }) => {
    const errors = await open(page);
    await inCell(page, '6');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => cursor(page)).toBe('After.');
    const from = await cell(page, '1').boundingBox();
    const to = await cell(page, '5').boundingBox();
    await page.mouse.move(from!.x + 6, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width - 6, to!.y + to!.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.pmd-canvas .selectedCell')).toHaveCount(4);
    await page.keyboard.press('Backspace');
    const saved = await hostReaches(page, /\|  \|  \| 6 \|/, TEXT);
    expect(saved).toBe(TEXT.replace('| 1 | 2 | 3 |\n| 4 | 5 | 6 |', '|  |  | 3 |\n|  |  | 6 |'));
    expect(errors).toEqual([]);
  });
});
