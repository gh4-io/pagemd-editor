// Fix run undo-bg-table-split (session 38), the user's two reports, against a pretend VS Code that answers the canvas's edits and
// reports VS Code's own undo and redo the way the real one does: as a change from outside (`externalChange`), which the canvas
// reads again.
// Bug 1: "Ctrl+Z in Print view drops the background; moving views and coming back repairs it." The canvas made a new editor
//   state for the text it read again, and the pages' on/off lived in that state, so the pages went off (no paper, no page
//   gaps) until a view switch turned them on again. Print Layout and Read had it; Web Layout and Draft have no pages.
// Bug 2: "Split for tables has not worked since the widths." A merged cell spanning columns and rows was written with one `|`
//   too many (pagemd-common), so once the text was read again (undo / redo, reopening) the table wasn't in standard form and
//   Split was off; and a merge that left a row without a cell of its own put the table out of standard form at once.
// Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, openEditor, sent } from '../support/host.ts';
import { quiet } from '../support/quiet.ts';
import { settle } from './pagination-harness.ts';


const open = (page: Page, text: string, mode: string) => openEditor(page, text, { mode });

/** What the canvas shows of the pages: the paper sheets, the gaps between pages, and whether the pagination is on. */
const pages = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('.pmd-canvas')!;
    const pm = (window as unknown as { __pmd: { pagination: { enabled: boolean } } }).__pmd;
    return { papers: canvas.querySelectorAll(':scope > .pmd-pages > .pmd-page').length, gaps: canvas.querySelectorAll('.pmd-page-gap').length, on: pm.pagination.enabled, classes: canvas.className };
  });
const canvasText = (page: Page) => page.evaluate(() => (document.querySelector('.pmd-canvas .ProseMirror') as HTMLElement).innerText);

/** Three pages or more (plain styles: Letter). */
const LONG = ['# Long document', '', ...Array.from({ length: 70 }, (_, i) => [`Paragraph ${i + 1} with enough words to fill a line or two on the page.`, '']).flat()].join('\n');

test.describe('bug 1: VS Code’s undo and redo keep the pages (the background) in Print Layout and Read', () => {
  for (const mode of ['print', 'read'] as const) {
    test(`${mode}: after undo and after redo the paper, the page gaps and the page count are as before`, async ({ page }) => {
      const { host, errors } = await open(page, LONG, mode === 'read' ? 'print' : mode);
      await expect.poll(async () => (await pages(page)).papers).toBeGreaterThanOrEqual(3);
      // An edit (typed in Print Layout; Read can't type, so it switches there after the edit).
      await page.locator('.pmd-canvas p', { hasText: 'Paragraph 1 with' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Added');
      const typed = await host.settle((text) => text.includes('page. Added'));
      if (mode === 'read') await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'read' } });
      await expect.poll(async () => (await pages(page)).papers).toBeGreaterThanOrEqual(3);
      await settle(page); // (the pages after the view switch, measured until two runs agree; after undo and redo nothing is run by hand)
      const before = await pages(page);
      expect(before.on).toBe(true);
      if (mode === 'print') expect(before.gaps).toBeGreaterThan(0); // (Read lays its pages out without gaps between them)

      await host.undo();
      await expect.poll(() => canvasText(page)).not.toContain('Added');
      await expect.poll(() => pages(page)).toEqual(before);

      await host.redo();
      await expect.poll(() => canvasText(page)).toContain('page. Added');
      await expect.poll(() => pages(page)).toEqual(before);
      expect(host.text).toBe(typed);
      expect(errors).toEqual([]);
    });
  }

  test('web: an undo changes nothing about the look (no pages before or after; the classes stay)', async ({ page }) => {
    const { host, errors } = await open(page, LONG, 'web');
    await page.locator('.pmd-canvas p', { hasText: 'Paragraph 1 with' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Added');
    await host.settle((text) => text.includes('page. Added'));
    const before = await pages(page);
    expect(before.papers).toBe(0);
    await host.undo();
    await expect.poll(() => canvasText(page)).not.toContain('Added');
    expect(await pages(page)).toEqual(before);
    expect(errors).toEqual([]);
  });
});

/** The round-3 table: a `||` span, a `^^` span, the hidden widths. */
const SPAN = '| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall | x | y |\n| ^^ | p | q |\n<!-- ::TABLE widths="20% 30% 50%" -->';
const DOC = `# Tables\n\nBefore.\n\n${SPAN}\n\nAfter.\n`;
const cell = (page: Page, text: string) => page.locator('.pmd-canvas td, .pmd-canvas th').filter({ hasText: new RegExp(`^${text}$`) }).first();
const button = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const isOff = async (page: Page, command: string) => (await button(page, command).getAttribute('aria-disabled')) === 'true';

async function dragCells(page: Page, from: string, to: string): Promise<void> {
  const a = (await cell(page, from).boundingBox())!;
  const b = (await cell(page, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe('bug 2: merge, then split, in a table with widths and spanning cells (Print Layout)', () => {
  test('a merged block spanning columns and rows is written so it reads back; after undo and redo Split is on and works; the pages stay', async ({ page }) => {
    const { host, errors } = await open(page, DOC, 'print');
    await expect.poll(async () => (await pages(page)).papers).toBeGreaterThanOrEqual(1);
    await dragCells(page, 'tall', 'x'); // tall spans two rows: the selection is tall, x and p
    await expect(page.locator('.pmd-canvas .selectedCell')).toHaveCount(3);
    expect(await isOff(page, 'table.merge-cells')).toBe(false);
    await button(page, 'table.merge-cells').click();
    const merged = DOC.replace('| tall | x | y |\n| ^^ | p | q |', '| tall x p || y |\n| ^^ || q |');
    expect(await host.settle((text) => text !== DOC)).toBe(merged);
    // VS Code's undo, then redo: the canvas reads the merged text again, as it would after reopening the file.
    await host.undo();
    await expect(page.locator('.pmd-canvas td[rowspan="2"]', { hasText: /^tall$/ })).toBeVisible();
    await host.redo();
    await expect(page.locator('.pmd-canvas td[colspan="2"][rowspan="2"]')).toHaveText('tall x p');
    await cell(page, 'tall x p').click();
    await expect.poll(() => isOff(page, 'table.split-cell')).toBe(false);
    await expect(page.locator('.pmd-table-prompt')).toHaveCount(0); // the table is in standard form: no "fix" bar
    await button(page, 'table.split-cell').click();
    expect(await host.settle((text) => text !== merged)).toBe(DOC.replace('| tall | x | y |\n| ^^ | p | q |', '| tall x p |  | y |\n|  |  | q |'));
    expect((await pages(page)).on).toBe(true); // bug 1 too: the pages are still there after the undo and the redo
    expect(errors).toEqual([]);
  });

  test('a merge that would leave a row without a cell of its own removes that row (Word); undo brings it back; the table stays in standard form', async ({ page }) => {
    const { host, errors } = await open(page, DOC, 'print');
    await dragCells(page, 'x', 'q'); // x y p q: the row of p and q would keep only the ^^ of tall
    await expect(page.locator('.pmd-canvas .selectedCell')).toHaveCount(4);
    expect(await isOff(page, 'table.merge-cells')).toBe(false);
    await button(page, 'table.merge-cells').click();
    const merged = DOC.replace('| tall | x | y |\n| ^^ | p | q |', '| tall | x y p q ||');
    expect(await host.settle((text) => text !== DOC)).toBe(merged);
    await expect(page.locator('.pmd-table-prompt')).toHaveCount(0);
    await host.undo();
    await expect(page.locator('.pmd-canvas td[rowspan="2"]', { hasText: /^tall$/ })).toBeVisible();
    await host.redo();
    await expect(page.locator('.pmd-canvas td[colspan="2"]', { hasText: 'x y p q' })).toBeVisible();
    await cell(page, 'x y p q').click();
    await expect.poll(() => isOff(page, 'table.split-cell')).toBe(false);
    await button(page, 'table.split-cell').click();
    await expect(page.locator('.pmd-canvas td[colspan="2"]', { hasText: 'x y p q' })).toHaveCount(0);
    await expect(page.locator('.pmd-table-prompt')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('an ordinary merge in the same table still works and Split takes it back', async ({ page }) => {
    const { errors } = await open(page, DOC, 'print');
    // The ordinary merge in the same table still works and Split takes it back.
    await dragCells(page, 'x', 'y');
    await expect.poll(() => isOff(page, 'table.merge-cells')).toBe(false);
    await button(page, 'table.merge-cells').click();
    await expect(page.locator('.pmd-canvas td[colspan="2"]', { hasText: 'x y' })).toBeVisible();
    await expect.poll(() => isOff(page, 'table.split-cell')).toBe(false);
    await button(page, 'table.split-cell').click();
    await expect(page.locator('.pmd-canvas td[colspan="2"]', { hasText: 'x y' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

// FIX-PGF (item 3), the user: "I'm still getting heavy flicker with Ctrl+Z". Measured (docs/phases/FIX-preview-greyouts-flicker.md):
// every undo built a brand-new editor state, which took the paper sheets off the page and every page gap out of the text for a
// frame (the text ran as one column, the page grew 20-30 % shorter, the view jumped by up to 13 pages while the browser held the
// text in place), then laid all the pages out again. Now the canvas patches the changed blocks into the same state: the drawing
// stays until the new layout replaces it. The page's own frame-by-frame trace (`test:trace`) counts it.
test.describe('FIX-PGF: an undo in Print Layout does not flicker', () => {
  const trace = (page: Page, action: 'start' | 'stop') =>
    page.evaluate(([a]) => {
      const w = window as unknown as { __toHost: { kind: string; id?: number; result?: unknown }[]; __fromHost(m: unknown): void };
      const id = 800000 + w.__toHost.length;
      w.__fromHost({ kind: 'request', id, method: 'test:trace', params: { action: a } });
      return new Promise<Record<string, unknown> | null>((resolve) => {
        const poll = () => {
          const answer = w.__toHost.find((m) => m.kind === 'response' && m.id === id);
          if (answer) resolve(answer.result as Record<string, unknown> | null);
          else setTimeout(poll, 10);
        };
        poll();
      });
    }, [action] as const);
  const BIG = ['# Long document', '', ...Array.from({ length: 260 }, (_, i) => [`Paragraph ${i + 1} with enough words to fill a line or two on the page, and a few more words.`, '']).flat()].join('\n');

  test('undo and redo, scrolled to the middle: no new state, the paper and gaps never leave, one layout pass, the view stays, nothing sent back', async ({ page }) => {
    const { host, errors } = await open(page, BIG, 'print');
    await expect.poll(async () => (await pages(page)).papers).toBeGreaterThanOrEqual(10);
    await page.locator('.pmd-canvas p', { hasText: 'Paragraph 130 with' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Added');
    await host.settle((text) => text.includes('more words. Added'));
    await settle(page);
    await page.locator('.pmd-canvas p', { hasText: 'Paragraph 130 with' }).scrollIntoViewIfNeeded();
    const before = await pages(page);
    for (const step of ['undo', 'redo'] as const) {
      const sentBefore = (await sent(page)).filter((m) => m.method === 'applyEdits').length;
      await trace(page, 'start');
      await host[step]();
      await expect.poll(() => canvasText(page)).toEqual(expect.stringContaining(step === 'undo' ? 'more words.\n' : 'more words. Added'));
      await quiet(page);
      const seen = (await trace(page, 'stop'))!;
      // Before the fix: rebuilds 1, layerRemovals 1, framesWithoutPages 1 or more, runs 2, scrollMovedPx in the hundreds or thousands.
      expect(seen, step).toMatchObject({ rebuilds: 0, patches: 1, layerRemovals: 0, framesWithoutPages: 0, scrollMovedPx: 0 });
      expect(seen['runs'] as number, step).toBeLessThanOrEqual(1);
      expect(await pages(page), step).toEqual(before);
      // One VS Code undo step: the canvas sends nothing back for VS Code's own change.
      await quiet(page);
      expect((await sent(page)).filter((m) => m.method === 'applyEdits').length, step).toBe(sentBefore);
      // The cursor is back in the block that changed.
      const at = await page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $head: { parent: { textContent: string } } } } } } } }).__pmd.canvas.view.state.selection.$head.parent.textContent);
      expect(at, step).toContain('Paragraph 130 with');
    }
    expect(errors).toEqual([]);
  });
});
