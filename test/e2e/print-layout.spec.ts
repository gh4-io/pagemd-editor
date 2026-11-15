// P6 Part 2: Print Layout's headers and footers, rulers, pages side by side, zoom and fit, the status bar's page
// number, and Read view, in a real browser (Chromium) against the webview bundle with a pretend host (webview.html).
// The pagination itself (page counts against pagemd's PDF, breaks, benchmark) is in pagination*.spec.ts.
import { expect, test, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openInPrintLayout, PAGEMD_ROOT } from './pagination-harness.ts';

type Message = { kind: string; id?: number; name?: string; method?: string; data?: unknown; params?: any };
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __toHost: Message[] }).__toHost);

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;

async function waitFor(page: Page, match: (m: Message) => boolean): Promise<Message> {
  let found: Message | undefined;
  await expect.poll(async () => (found = (await sent(page)).find(match)), { timeout: 5000 }).toBeTruthy();
  return found!;
}

const A4 = { width: 210, height: 297, margins: { top: 25, right: 25, bottom: 25, left: 25 } };
const CSS = '.pmd-canvas { font: 16px/24px sans-serif } .pmd-canvas p { margin: 0 0 12px; break-inside: avoid } .pmd-canvas h1 { font-size: 24px; margin: 0 0 12px }';

/** Roughly five lines at 24 px each in the 160 mm column. */
const PARA = (n: number) => `Paragraph ${n}. ${'The quick brown fox jumps over the lazy dog and keeps running through the field. '.repeat(5)}`;
const DOC = `# Alpha\n\n${Array.from({ length: 12 }, (_, i) => PARA(i + 1)).join('\n\n')}\n\n# Beta\n\n${Array.from({ length: 24 }, (_, i) => PARA(i + 13)).join('\n\n')}\n`;

interface Setup {
  styles?: Record<string, unknown>;
  plain?: boolean;
  fileName?: string;
  text?: string;
}

/** Opens `text` in the webview (Print Layout, the default view) with styles built from `setup.styles` over A4. */
async function openDoc(page: Page, setup: Setup = {}): Promise<void> {
  await page.goto(pageUrl);
  await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
  const styles = setup.plain ? null : { css: CSS, page: A4, usingDefault: false, sources: [], layout: { path: '/pagemd/layouts/letter.css', bundled: true }, ...setup.styles };
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: setup.text ?? DOC, version: 1, fileName: setup.fileName ?? 'a.md', documentBase: fixtures, testing: true, styles: { styles, gateDefaults: {}, notes: [] }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  await settle(page);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const { pagination } = (window as unknown as { __pmd: { pagination: { run(): { pages: unknown[] } | null } } }).__pmd;
    let last = '';
    for (let i = 0; i < 6; i++) {
      const layout = pagination.run();
      const sig = JSON.stringify((layout?.pages ?? []).map((p) => (p as { pos: number | null }).pos));
      if (sig === last) break;
      last = sig;
    }
  });
}

const pageCount = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: unknown[] } } } }).__pmd.pagination.layout.pages.length);
const papers = (page: Page) => page.locator('.pmd-canvas > .pmd-pages > .pmd-page');
const rectOf = (page: Page, selector: string, nth = 0) => page.locator(selector).nth(nth).evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
});
/** The status bar's page number, e.g. 'Page 2 of 5'. */
const pageText = (page: Page) => page.locator('.pmd-status-bar span', { hasText: /^Page \d+ of \d+$/ });
const setViewMode = (page: Page, mode: string) => fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
/** The viewport top-left of the block starting page `n` (1-based). */
const pageStart = (page: Page, n: number) =>
  page.evaluate((index) => {
    const pmd = (window as unknown as { __pmd: { pagination: { layout: { pages: Array<{ pos: number }> } }; canvas: { view: { nodeDOM(pos: number): Element | null } } } }).__pmd;
    const el = pmd.canvas.view.nodeDOM(pmd.pagination.layout.pages[index - 1]!.pos) as Element;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, bottom: r.bottom };
  }, n);

test.describe('running headers and footers (amendment 7)', () => {
  const styles = {
    header: { left: 'Acme', right: ':::STRING(chapter)' },
    footer: { center: ':::PAGE of :::PAGES' },
    firstPage: { header: false },
    strings: { chapter: 'h1' },
  };

  test('each page gets its own page number, total and running string; the first page follows firstPage', async ({ page }) => {
    await openDoc(page, { styles });
    const n = await pageCount(page);
    expect(n).toBeGreaterThanOrEqual(4);
    const footer = (i: number) => papers(page).nth(i).locator('.pmd-page-footer [data-box="center"]');
    await expect(footer(0)).toHaveText(`1 of ${n}`);
    await expect(footer(2)).toHaveText(`3 of ${n}`);
    await expect(footer(n - 1)).toHaveText(`${n} of ${n}`);
    // firstPage: { header: false } hides page 1's header only
    await expect(papers(page).nth(0).locator('.pmd-page-header')).toHaveCount(0);
    await expect(papers(page).nth(1).locator('.pmd-page-header [data-box="left"]')).toHaveText('Acme');
    // `:::STRING(chapter)`: the first h1 on a page, else the one carried over: page 2 is still in "Alpha"; the last page is in "Beta".
    await expect(papers(page).nth(1).locator('.pmd-page-header [data-box="right"]')).toHaveText('Alpha');
    await expect(papers(page).nth(n - 1).locator('.pmd-page-header [data-box="right"]')).toHaveText('Beta');
  });

  test('the text sits in the margins: the header in the top one, the footer in the bottom one, in the profile\'s font size', async ({ page }) => {
    await openDoc(page, { styles: { ...styles, marginFontSize: '11px' } });
    const paper = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 1);
    const header = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page:nth-child(2) .pmd-page-header');
    const footer = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page:nth-child(2) .pmd-page-footer');
    const margin = (25 * 96) / 25.4;
    expect(Math.abs(header.top - paper.top)).toBeLessThan(1);
    expect(Math.abs(header.height - margin)).toBeLessThan(1);
    expect(Math.abs(paper.bottom - footer.bottom)).toBeLessThan(1);
    await expect(papers(page).nth(1).locator('.pmd-page-footer')).toHaveCSS('font-size', '11px');
  });

  test('inside and outside flip between right pages (1, 3, …) and left pages (2, 4, …)', async ({ page }) => {
    await openDoc(page, { styles: { footer: { inside: 'IN', outside: 'OUT' } } });
    const box = (i: number, side: string) => papers(page).nth(i).locator(`.pmd-page-footer [data-box="${side}"]`);
    await expect(box(0, 'left')).toHaveText('IN');
    await expect(box(0, 'right')).toHaveText('OUT');
    await expect(box(1, 'left')).toHaveText('OUT');
    await expect(box(1, 'right')).toHaveText('IN');
  });

  test('a document with no profile (plain styles) has no headers or footers; Web Layout draws none either', async ({ page }) => {
    await openDoc(page, { plain: true });
    await expect(page.locator('.pmd-page-header, .pmd-page-footer')).toHaveCount(0);
    await openDoc(page, { styles });
    await expect(page.locator('.pmd-page-footer').first()).toBeVisible();
    await setViewMode(page, 'web');
    await expect(page.locator('.pmd-page-footer')).toHaveCount(0);
  });
});

test.describe('rulers and guides (amendment 9)', () => {
  const handle = (page: Page, side: string) => page.locator(`.pmd-ruler-handle[data-side="${side}"]`);
  // P13 flake fix ("a host that fails shows why" failed 1 run in 5 with `boundingBox()` null): the handles are drawn a moment after the
  // pages settle, so wait until the handle is visible before measuring it.
  const handleBox = async (page: Page, side: string) => {
    await expect(handle(page, side)).toBeVisible();
    return (await handle(page, side).boundingBox())!;
  };

  test('both rulers and the margin, header and footer guides show in Print Layout, and not in Read or Web Layout', async ({ page }) => {
    await openDoc(page);
    await expect(page.locator('.pmd-ruler-h')).toBeVisible();
    await expect(page.locator('.pmd-ruler-v')).toBeVisible();
    await expect(papers(page).first().locator('.pmd-guide-margins')).toHaveCount(1);
    await expect(papers(page).first().locator('.pmd-guide-header')).toHaveCount(1);
    await expect(papers(page).first().locator('.pmd-guide-footer')).toHaveCount(1);
    // the margin handles sit where the margins are: 25 mm in from the paper's left edge
    const paper = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page');
    const left = await rectOf(page, '.pmd-ruler-handle[data-side="left"]');
    expect(Math.abs(left.left + left.width / 2 - (paper.left + (25 * 96) / 25.4))).toBeLessThan(3);
    await setViewMode(page, 'read');
    await expect(page.locator('.pmd-ruler-h')).toBeHidden();
    await expect(page.locator('.pmd-guide-margins')).toHaveCount(0); // only Print Layout draws the guides
    await setViewMode(page, 'web');
    await expect(page.locator('.pmd-ruler-h')).toBeHidden();
  });

  test('dragging the left margin handle ends in createLayoutFile with the new margin (snapped to half a mm)', async ({ page }) => {
    await openDoc(page);
    const box = (await handleBox(page, 'left'));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
    await expect(page.locator('.pmd-ruler-line')).toBeVisible(); // the live guide while dragging
    await page.mouse.up();
    const request = await waitFor(page, (m) => m.method === 'createLayoutFile');
    const margins = request.params.page.margins;
    expect(margins.left).toBeGreaterThan(34.5);
    expect(margins.left).toBeLessThan(36.5);
    expect(margins.left * 2).toBeCloseTo(Math.round(margins.left * 2), 5); // half-millimetre steps
    expect({ ...margins, left: 0 }).toEqual({ top: 25, right: 25, bottom: 25, left: 0 });
    expect(request.params.page.width).toBe(210);
  });

  test("a document's own layout file is rewritten silently and the status bar says so (R-143); another layout's confirm is the host's", async ({ page }) => {
    await openDoc(page, { styles: { layout: { path: '/work/.pagemd/layouts/a.css', bundled: false } } });
    const box = (await handleBox(page, 'top'));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    const request = await waitFor(page, (m) => m.method === 'createLayoutFile');
    expect(request.params.page.margins.top).toBeGreaterThan(30);
    await fromHost(page, { kind: 'response', id: request.id, ok: true, result: 'created' });
    await expect(page.locator('.pmd-status-bar')).toContainText('Layout file updated: a.css');
  });

  test('a shared layout: after the host creates the document\'s file the status bar says it was created; a declined change leaves the page and the handle as they were', async ({ page }) => {
    await openDoc(page);
    const drag = async (side: string, dx: number, dy: number) => {
      const box = (await handleBox(page, side));
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
      await page.mouse.up();
    };
    const before = (await handleBox(page, 'right')).x;
    await drag('right', -30, 0);
    const declined = await waitFor(page, (m) => m.method === 'createLayoutFile');
    await fromHost(page, { kind: 'response', id: declined.id, ok: true, result: 'declined' });
    await expect.poll(async () => Math.abs(((await handle(page, 'right').boundingBox())?.x ?? -999) - before)).toBeLessThan(1); // redrawn where the margin really is
    await expect(page.locator('.pmd-status-bar')).not.toContainText('Layout file');
    await drag('top', 0, 20);
    const created = await waitFor(page, (m) => m.method === 'createLayoutFile' && m.id !== declined.id);
    await fromHost(page, { kind: 'response', id: created.id, ok: true, result: 'created' });
    await expect(page.locator('.pmd-status-bar')).toContainText('Layout file created for this document');
  });

  test('a document with plain styles (no profile) has handles that cannot be dragged', async ({ page }) => {
    await openDoc(page, { plain: true });
    await expect(handle(page, 'left')).toHaveClass(/pmd-ruler-handle-fixed/);
  });

  test('a host that fails shows why in the status bar', async ({ page }) => {
    await openDoc(page);
    const box = (await handleBox(page, 'left'));
    await page.mouse.move(box.x + 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 42, box.y + 8, { steps: 5 });
    await page.mouse.up();
    const request = await waitFor(page, (m) => m.method === 'createLayoutFile');
    await fromHost(page, { kind: 'response', id: request.id, ok: false, error: 'a profile named "a.doc" already exists' });
    await expect(page.locator('.pmd-status-bar')).toContainText('Margins not saved: a profile named "a.doc" already exists');
  });
});

test.describe('zoom and fit (amendment 11)', () => {
  const zoom = (page: Page, value: string) => page.locator('.pmd-status-zoom').selectOption(value);

  test('150 % scales the page and keeps the page count and the page breaks (the measuring follows the zoom)', async ({ page }) => {
    await openDoc(page);
    const before = await pageCount(page);
    const starts = await page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: Array<{ pos: number }> } } } }).__pmd.pagination.layout.pages.map((p) => p.pos));
    const width = (await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page')).width;
    await zoom(page, 'zoom:1.5');
    await settle(page);
    expect(await pageCount(page)).toBe(before);
    expect(await page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: Array<{ pos: number }> } } } }).__pmd.pagination.layout.pages.map((p) => p.pos))).toEqual(starts);
    const wider = (await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page')).width;
    expect(wider / width).toBeCloseTo(1.5, 2);
    await expect(page.locator('.pmd-status-zoom option:checked')).toHaveText('150 %');
  });

  test('page width fits the page across the window; one page also fits the height; multiple pages fit a two-page spread', async ({ page }) => {
    await openDoc(page);
    const scroller = () => rectOf(page, '.pmd-scroll');
    await zoom(page, 'fit:page-width');
    await expect.poll(async () => Math.round((await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page')).width)).toBe(Math.round((await scroller()).width));
    await expect(page.locator('.pmd-status-zoom option:checked')).toHaveText('Page width');
    await zoom(page, 'fit:one-page');
    await expect.poll(async () => Math.round((await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page')).height)).toBeLessThanOrEqual(Math.round((await scroller()).height));
    await zoom(page, 'fit:multi-page');
    await expect(papers(page).nth(1)).toBeVisible();
    await expect.poll(async () => (await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 1)).left).toBeGreaterThan((await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 0)).right - 2);
    const first = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 0);
    const second = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 1);
    expect(Math.abs(second.top - first.top)).toBeLessThan(1); // side by side
    expect(Math.abs(second.right - first.left - (await scroller()).width)).toBeLessThan(2); // the spread fills the window's width
  });

  test('the zoom and fit are the view state: the status bar control writes ViewState', async ({ page }) => {
    await openDoc(page);
    await zoom(page, 'zoom:0.75');
    expect(await page.evaluate(() => (window as unknown as { __pmd: { view: { value: { zoom: number; fit: string } } } }).__pmd.view.value)).toMatchObject({ zoom: 0.75, fit: 'none' });
    await zoom(page, 'fit:one-page');
    expect(await page.evaluate(() => (window as unknown as { __pmd: { view: { value: { fit: string } } } }).__pmd.view.value.fit)).toBe('one-page');
  });
});

test.describe('"Page N of M" (amendment 11)', () => {
  test('follows the page at the top of the window as the document scrolls', async ({ page }) => {
    await openDoc(page);
    const n = await pageCount(page);
    await expect(pageText(page)).toHaveText(`Page 1 of ${n}`);
    const top = await page.evaluate(() => {
      const scroller = document.querySelector('.pmd-scroll')!;
      const third = document.querySelectorAll('.pmd-canvas > .pmd-pages > .pmd-page')[2]!.getBoundingClientRect();
      scroller.scrollTop += third.top - scroller.getBoundingClientRect().top + 20;
      return scroller.scrollTop;
    });
    expect(top).toBeGreaterThan(0);
    await expect(pageText(page)).toHaveText(`Page 3 of ${n}`);
  });

  test('Web Layout and Draft have no pages, so no page number', async ({ page }) => {
    await openDoc(page);
    await setViewMode(page, 'web');
    await expect(page.locator('.pmd-status-bar')).not.toContainText('Page 1 of');
    await setViewMode(page, 'print');
    await expect(pageText(page)).toBeVisible();
  });
});

test.describe('pages side by side (amendment 11)', () => {
  test('the pages go into two columns: page 2 beside page 1, its text inside its own paper, the page count unchanged', async ({ page }) => {
    await openDoc(page);
    const n = await pageCount(page);
    await page.locator('.pmd-status-arrangement').selectOption('side-by-side');
    await settle(page);
    expect(await pageCount(page)).toBe(n);
    const p1 = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 0);
    const p2 = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 1);
    const p3 = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 2);
    expect(Math.abs(p1.top - p2.top)).toBeLessThan(1);
    expect(p2.left).toBeGreaterThanOrEqual(p1.right - 1);
    expect(p3.top).toBeGreaterThan(p1.bottom); // the third page starts the next row
    expect(Math.abs(p3.left - p1.left)).toBeLessThan(1);
    // The first block of every page lies inside its own paper, at the top margin.
    const margin = (25 * 96) / 25.4;
    for (const [number, paper] of [[1, p1], [2, p2], [3, p3]] as const) {
      const start = await pageStart(page, number);
      expect(start.left, `page ${number} text left`).toBeGreaterThanOrEqual(paper.left + margin - 1);
      expect(start.left, `page ${number} text left`).toBeLessThan(paper.right - margin);
      if (number > 1) expect(Math.abs(start.top - (paper.top + margin)), `page ${number} text top`).toBeLessThan(3);
    }
  });

  test('the headers and footers move with their papers, and the arrangement switches back to a vertical column', async ({ page }) => {
    await openDoc(page, { styles: { footer: { center: ':::PAGE' } } });
    await page.locator('.pmd-status-arrangement').selectOption('side-by-side');
    await settle(page);
    const footer2 = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page:nth-child(2) .pmd-page-footer');
    const paper2 = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 1);
    expect(Math.abs(footer2.bottom - paper2.bottom)).toBeLessThan(1);
    await page.locator('.pmd-status-arrangement').selectOption('vertical');
    await settle(page);
    const p1 = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 0);
    const p2 = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', 1);
    expect(p2.top).toBeGreaterThan(p1.bottom);
    expect(Math.abs(p2.left - p1.left)).toBeLessThan(1);
    await expect(page.locator('.pmd-canvas')).not.toHaveClass(/pmd-columns/);
  });
});

test.describe('Read view (amendment 10)', () => {
  /** Whether any part of block `n`'s first line is inside the scroll window right now. */
  const visible = (page: Page, number: number) =>
    page.evaluate((index) => {
      const pmd = (window as unknown as { __pmd: { pagination: { layout: { pages: Array<{ pos: number }> } }; canvas: { view: { nodeDOM(pos: number): Element | null } } } }).__pmd;
      const el = pmd.canvas.view.nodeDOM(pmd.pagination.layout.pages[index - 1]!.pos) as HTMLElement;
      const r = el.getBoundingClientRect();
      const s = document.querySelector('.pmd-scroll')!.getBoundingClientRect();
      // clipped parts of the canvas aren't drawn: ask the browser what is on screen at the block's first line
      const hit = document.elementFromPoint(Math.min(Math.max(r.left + 10, s.left + 1), s.right - 1), r.top + 8);
      return r.top + 8 >= s.top && r.top + 8 <= s.bottom && !!hit && (hit === el || el.contains(hit));
    }, number);

  test('is read-only, shows one page at a time, and has no rulers', async ({ page }) => {
    await openDoc(page);
    const n = await pageCount(page);
    await setViewMode(page, 'read');
    await expect(page.locator('.pmd-canvas .ProseMirror')).toHaveAttribute('contenteditable', 'false');
    await expect(pageText(page)).toHaveText(`Page 1 of ${n}`);
    await expect(page.locator('.pmd-status-bar span', { hasText: /^Read$/ })).toBeVisible();
    await expect(page.locator('.pmd-ruler-h')).toBeHidden();
    await expect.poll(() => visible(page, 1)).toBe(true);
    await expect.poll(() => visible(page, 2)).toBe(false);
    // No typing gets through: the keys flip pages instead, and no edit is sent.
    await page.keyboard.type('xyz');
    expect((await sent(page)).some((m) => m.method === 'applyEdits')).toBe(false);
    await expect(page.locator('.pmd-canvas', { hasText: 'xyz' })).toHaveCount(0);
  });

  test('arrow keys, Page keys, Home/End and clicks flip the page, without animation, and stop at both ends', async ({ page }) => {
    await openDoc(page);
    const n = await pageCount(page);
    await setViewMode(page, 'read');
    await expect(page.locator('.pmd-canvas .ProseMirror')).toHaveAttribute('contenteditable', 'false'); // P13 flake fix: the view change arrives a moment after the event; a key pressed before it went to the editable canvas
    await page.keyboard.press('ArrowRight');
    await expect(pageText(page)).toHaveText(`Page 2 of ${n}`);
    await expect.poll(() => visible(page, 2)).toBe(true);
    await expect.poll(() => visible(page, 1)).toBe(false);
    await page.keyboard.press('PageDown');
    await expect(pageText(page)).toHaveText(`Page 3 of ${n}`);
    await page.keyboard.press('ArrowLeft');
    await expect(pageText(page)).toHaveText(`Page 2 of ${n}`);
    await page.keyboard.press('End');
    await expect(pageText(page)).toHaveText(`Page ${n} of ${n}`);
    await page.keyboard.press('ArrowRight'); // past the end: stays
    await expect(pageText(page)).toHaveText(`Page ${n} of ${n}`);
    await page.keyboard.press('Home');
    await expect(pageText(page)).toHaveText(`Page 1 of ${n}`);
    await page.keyboard.press('ArrowLeft'); // before the start: stays
    await expect(pageText(page)).toHaveText(`Page 1 of ${n}`);
    // clicks: the right half forward, the left half back
    const s = await rectOf(page, '.pmd-scroll');
    await page.mouse.click(s.right - 20, s.top + 5);
    await expect(pageText(page)).toHaveText(`Page 2 of ${n}`);
    await page.mouse.click(s.left + 20, s.top + 5);
    await expect(pageText(page)).toHaveText(`Page 1 of ${n}`);
    // no transitions anywhere on the canvas: the flip is immediate
    expect(await page.locator('.pmd-canvas').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
  });

  test('a two-page spread: side by side shows pages 1+2, then 3+4; the page number is the left page', async ({ page }) => {
    await openDoc(page);
    const n = await pageCount(page);
    await setViewMode(page, 'read');
    await page.locator('.pmd-status-arrangement').selectOption('side-by-side');
    await settle(page);
    await expect(pageText(page)).toHaveText(`Page 1 of ${n}`);
    await expect.poll(() => visible(page, 1)).toBe(true);
    await expect.poll(() => visible(page, 2)).toBe(true);
    await expect.poll(() => visible(page, 3)).toBe(false);
    await page.keyboard.press('ArrowRight');
    await expect(pageText(page)).toHaveText(`Page 3 of ${n}`);
    await expect.poll(() => visible(page, 3)).toBe(true);
    await expect.poll(() => visible(page, 4)).toBe(true);
    await expect.poll(() => visible(page, 2)).toBe(false);
    await page.keyboard.press('ArrowLeft');
    await expect(pageText(page)).toHaveText(`Page 1 of ${n}`);
  });

  test('going back to Print Layout makes the canvas editable and scrollable again', async ({ page }) => {
    await openDoc(page);
    await setViewMode(page, 'read');
    await expect(page.locator('.pmd-canvas .ProseMirror')).toHaveAttribute('contenteditable', 'false'); // P13 flake fix: the view change arrives a moment after the event; a key pressed before it went to the editable canvas
    await page.keyboard.press('ArrowRight');
    await setViewMode(page, 'print');
    await expect(page.locator('.pmd-canvas .ProseMirror')).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('.pmd-scroll')).not.toHaveClass(/pmd-reading/);
    expect(await page.locator('.pmd-canvas').evaluate((el) => el.style.clipPath)).toBe('');
    await expect(page.locator('.pmd-ruler-h')).toBeVisible();
    await page.locator('.pmd-canvas p').first().click();
    await page.keyboard.type('z');
    await waitFor(page, (m) => m.method === 'applyEdits');
  });

  test('typing in Print Layout re-paginates and the footer follows (the headers are redrawn from the new layout)', async ({ page }) => {
    await openDoc(page, { styles: { footer: { center: ':::PAGE of :::PAGES' } } });
    const n = await pageCount(page);
    await page.evaluate(() => {
      const pmd = (window as unknown as { __pmd: { canvas: { typeAtEndOfBlock(i: number, t: string): void } } }).__pmd;
      for (let i = 0; i < 8; i++) pmd.canvas.typeAtEndOfBlock(1, ' more words '.repeat(60));
    });
    await expect.poll(() => pageCount(page)).toBeGreaterThan(n);
    // the last footer always says "N of N" for the pages there are now (re-read each time: the layout settles in steps)
    await expect
      .poll(async () => {
        const now = await pageCount(page);
        return (await papers(page).nth(now - 1).locator('.pmd-page-footer [data-box="center"]').textContent()) === `${now} of ${now}`;
      })
      .toBe(true);
  });
});

test.describe("a real pagemd example (05-extended-syntax-stress: frontmatter, a cover, 19 body pages, the technical profile's header and footer)", () => {
  const path = `${PAGEMD_ROOT}/tests/corpus/pagemd/examples/md/05-extended-syntax-stress.md`;
  const open = (page: Page) => openInPrintLayout(page, path, readFileSync(path, 'utf8'), pathToFileURL(`${dirname(path)}/`).href);

  test('side by side, at 150 % and in Read the same pages come out as in the vertical column', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    const n = await pageCount(page);
    expect(n).toBeGreaterThan(10);
    await page.locator('.pmd-status-zoom').selectOption('zoom:1.5');
    await settle(page);
    expect(await pageCount(page), 'at 150 %').toBe(n);
    await page.locator('.pmd-status-zoom').selectOption('zoom:1');
    await page.locator('.pmd-status-arrangement').selectOption('side-by-side');
    await settle(page);
    expect(await pageCount(page), 'side by side').toBe(n);
    // the frontmatter is not part of any page: hidden while the pages are in columns
    await expect(page.locator('.pmd-canvas .ProseMirror > *').first()).toBeHidden();
    // and the first block of every page is inside its own paper
    for (const number of [1, 2, 3, 8, n]) {
      const paper = await rectOf(page, '.pmd-canvas > .pmd-pages > .pmd-page', number - 1);
      const start = await pageStart(page, number);
      expect(start.left, `page ${number}`).toBeGreaterThanOrEqual(paper.left - 1);
      expect(start.left, `page ${number}`).toBeLessThan(paper.right);
      expect(start.top, `page ${number}`).toBeGreaterThanOrEqual(paper.top - 1);
      expect(start.top, `page ${number}`).toBeLessThan(paper.bottom);
    }
    await setViewMode(page, 'read');
    await settle(page);
    expect(await pageCount(page), 'in Read').toBe(n);
  });

  test("the profile's own header and footer are drawn from its layout", async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    const texts = await papers(page).nth(2).locator('[data-box]').allTextContents();
    expect(texts.join('').trim().length, 'page 3 has running text').toBeGreaterThan(0);
  });
});
