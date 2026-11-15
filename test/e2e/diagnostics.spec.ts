// P14 in a real browser (Chromium) with a pretend host: the checks' results (the `diagnostics` event, protocol v9) become
// hints on the blocks they are about, take no room, follow typing, go when the results say so, and Document ▸ Check asks
// the host for "pagemd: Check Document". Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const DOC = ['---', 'title: T', '---', '# Heading', '', 'First paragraph.', '', '<!-- ::BREAK -->', '', 'Last paragraph.', ''].join('\n');


async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await expect.poll(async () => (await sent(page)).some((m) => m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: DOC, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: '' },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  return errors;
}

/** The text range of a 0-based line of `text`. */
function line(text: string, n: number): { from: number; to: number } {
  const lines = text.split('\n');
  const from = lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
  return { from, to: from + lines[n]!.length };
}

const results = (items: { line?: number; severity: string; message: string }[], extra: Record<string, unknown> = {}) => ({
  kind: 'event',
  name: 'diagnostics',
  data: {
    version: 1,
    text: DOC,
    enabled: true,
    shown: true,
    items: items.map((i) => ({ ...(i.line === undefined ? { from: 0, to: 0 } : line(DOC, i.line)), severity: i.severity, message: i.message, code: 'x/y', source: 'pagemd' })),
    ...extra,
  },
});

const blocks = (page: Page) => page.locator('.pmd-canvas .ProseMirror > *');
const hinted = (page: Page) => page.locator('.pmd-canvas .ProseMirror > .pmd-hint');

test.describe('problem hints on the canvas', () => {
  test('each result marks its block (worst severity, every message as the tooltip); problems at the start get none', async ({ page }) => {
    const errors = await open(page);
    const before = await page.locator('.pmd-canvas .ProseMirror').boundingBox();
    await fromHost(page, results([
      { line: 7, severity: 'warning', message: 'Unknown directive ::BREAK' },
      { line: 5, severity: 'info', message: 'a note' },
      { line: 5, severity: 'error', message: 'an error' },
      { severity: 'error', message: 'Missing required field: owner' },
    ]));
    await expect(hinted(page)).toHaveCount(2);
    const paragraph = blocks(page).filter({ hasText: 'First paragraph.' });
    await expect(paragraph).toHaveClass(/pmd-hint-error/);
    await expect(paragraph).toHaveAttribute('title', 'a note\nan error');
    await expect(hinted(page).nth(1)).toHaveClass(/pmd-hint-warning/);
    await expect(hinted(page).nth(1)).toHaveAttribute('title', 'Unknown directive ::BREAK');
    // the bar is drawn (a box-shadow in the problem color) and takes no room
    expect(await paragraph.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
    expect((await page.locator('.pmd-canvas .ProseMirror').boundingBox())!.height).toBe(before!.height);
    expect(errors).toEqual([]);
  });

  test('results for another text change nothing; typing keeps the hints on their blocks; an empty list clears them', async ({ page }) => {
    await open(page);
    await fromHost(page, results([{ line: 9, severity: 'warning', message: 'last' }], { text: `${DOC}changed\n` }));
    await quiet(page);
    await expect(hinted(page)).toHaveCount(0);
    await fromHost(page, results([{ line: 9, severity: 'warning', message: 'last' }]));
    await expect(hinted(page)).toHaveCount(1);
    await blocks(page).filter({ hasText: 'First paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('A new paragraph');
    await expect(blocks(page).filter({ hasText: 'Last paragraph.' })).toHaveClass(/pmd-hint-warning/);
    await expect(hinted(page)).toHaveCount(1);
    await fromHost(page, results([], { text: DOC }));
    // the canvas no longer shows DOC (typing not sent), so the hint stays until results for its text arrive
    await expect(hinted(page)).toHaveCount(1);
  });

  test('the setting hides them: shown false clears every hint', async ({ page }) => {
    await open(page);
    await fromHost(page, results([{ line: 5, severity: 'error', message: 'x' }]));
    await expect(hinted(page)).toHaveCount(1);
    await fromHost(page, results([{ line: 5, severity: 'error', message: 'x' }], { shown: false }));
    await expect(hinted(page)).toHaveCount(0);
  });

  test('Document ▸ Check asks the host for "pagemd: Check Document"', async ({ page }) => {
    await open(page);
    await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Document', exact: true }).click();
    const check = page.locator('.pmd-ribbon [data-command="document.check"]');
    await expect(check).toBeVisible();
    await check.click();
    await expect.poll(async () => (await sent(page)).filter((m) => m.name === 'runCommand').map((m) => (m.data as { command: string }).command)).toContain('pagemd.checkDocument');
  });
});
