// P6 acceptance (amendments 12, 13): Print Layout's pages against pagemd's real PDF. The reference counts come from
// Paged.js runs over pagemd's example documents (scripts/pagination-reference.mjs), counting only the pages that
// hold the document body (R-146: not the template's title/cover/contents pages, nor the generated index), with a
// fingerprint of each document and every stylesheet/profile/template it could use; a stale reference fails here.
// Our side: the webview bundle in the test harness (webview.html), fed the same text and the styles style-pagemd
// resolves from the real pagemd checkout (as style-parity.spec.ts does), switched to Print Layout. Since P18 the template is drawn
// around the text, so the pages holding the body are counted (PageInfo.body).
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error: a plain .mjs script without types
import { fingerprint, PAGEMD_ROOT, REFERENCE_FILE } from '../../scripts/pagination-reference.mjs';
import { bodyPageCount, openInPrintLayout, pageCount, settle } from './pagination-harness.ts';

interface Reference {
  documents: Record<string, { bodyPages: number; pdfPages: number; fingerprint: string }>;
}
const reference = JSON.parse(readFileSync(REFERENCE_FILE as string, 'utf8')) as Reference;

/** Documents whose body Print Layout can't show yet, with the reason (asked of the user; see P6.md). */
const NOT_COMPARABLE: Record<string, string> = {
  'tests/corpus/pagemd/examples/md/14-wiki-book.md': 'its body is !!!include()d files, drawn as chips on the canvas until includes are expanded',
  // 06-index-stress and 10-index-multipage-stress are comparable since P18 (P19 round 3 found it): a list item starting with an
  // INDEX marker is no longer a tall raw block (OQ-38's symptom), so their body pages now match pagemd's PDF.
  // 09-toc-stress is comparable since P18 (its template's own CSS reaches the canvas, OQ-39 → R-228).
  'tests/corpus/pagemd/examples/md/13-comprehensive-stress.md': "still 15 vs 17 after P18 drew its template and applied the template's CSS (OQ-39 → R-228); the rest is not found yet (it also has pagemd's generated TOC and index)",
};

test.describe('body page count within ±1 of pagemd\'s PDF (amendments 12, 13)', () => {
  for (const [name, expected] of Object.entries(reference.documents)) {
    test(name, async ({ page }) => {
      test.fixme(name in NOT_COMPARABLE, NOT_COMPARABLE[name]);
      test.setTimeout(120_000);
      const path = `${PAGEMD_ROOT as string}/${name}`;
      expect(fingerprint(path), `the reference for ${name} is stale: run npm run pagination:reference`).toBe(expected.fingerprint);
      const text = readFileSync(path, 'utf8');
      await openInPrintLayout(page, path, text, pathToFileURL(`${dirname(path)}/`).href);
      // P18: the template is drawn too, so a page may hold only the template's parts (a title page): the body's pages are counted.
      const pages = await bodyPageCount(page);
      expect(Math.abs(pages - expected.bodyPages), `${name}: Print Layout ${pages} body pages (${await pageCount(page)} in all), pagemd's PDF body ${expected.bodyPages} (${expected.pdfPages} in all)`).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('page breaks', () => {
  const doc = (body: string) => `# Title\n\nFirst paragraph.\n\n${body}\n\nLast paragraph.\n`;
  const fixtureDir = dirname(REFERENCE_FILE as string);

  async function open(page: Page, text: string) {
    await openInPrintLayout(page, `${fixtureDir}/pagination.md`, text, pathToFileURL(`${fixtureDir}/`).href);
    return pageCount(page);
  }

  test('PAGEBREAK forces a new page; the paragraph after it starts page 2', async ({ page }) => {
    expect(await open(page, doc('<!-- ::PAGEBREAK -->'))).toBe(2);
    const second = await page.evaluate(() => {
      const pages = (window as unknown as { __pmd: { pagination: { layout: { pages: Array<{ top: number }> } } } }).__pmd.pagination.layout.pages;
      const last = [...document.querySelectorAll('.pmd-canvas p')].pop()!;
      const canvas = document.querySelector('.pmd-canvas')!.getBoundingClientRect();
      return { pageTop: pages[1]!.top, paragraphTop: last.getBoundingClientRect().top - canvas.top };
    });
    // The paragraph sits on page 2's paper, below its top margin (1 in = 96 px on pagemd's default Letter page).
    expect(second.paragraphTop).toBeGreaterThan(second.pageTop + 90);
    expect(second.paragraphTop).toBeLessThan(second.pageTop + 96 + 40);
  });

  test('control: the same document without PAGEBREAK has one page', async ({ page }) => {
    expect(await open(page, 'Middle paragraph.')).toBe(1);
  });

  test('the incremental re-measure (from the edited page on) gives the same pages as measuring everything', async ({ page }) => {
    const path = `${PAGEMD_ROOT as string}/tests/corpus/pagemd/examples/md/12-user-guide-multipage.md`;
    await openInPrintLayout(page, path, readFileSync(path, 'utf8'), pathToFileURL(`${dirname(path)}/`).href);
    const result = await page.evaluate(() => {
      type Layout = { pages: Array<{ pos: number | null; top: number }> };
      const { canvas, pagination } = (window as unknown as { __pmd: { canvas: { typeAtEndOfBlock(i: number, t: string): void; view: { state: { doc: { childCount: number } } } }; pagination: { run(o?: { full?: boolean }): Layout | null } } }).__pmd;
      const sig = (l: Layout | null) => JSON.stringify(l?.pages.map((p) => [p.pos, Math.round(p.top)]));
      const middle = Math.floor(canvas.view.state.doc.childCount / 2);
      const out: Array<[string, string]> = [];
      for (let k = 0; k < 5; k++) {
        canvas.typeAtEndOfBlock(middle + k, ' Some more words typed here to change where the lines and pages break.'.repeat(4));
        const incremental = sig(pagination.run());
        out.push([incremental, sig(pagination.run({ full: true }))]);
      }
      return out;
    });
    for (const [incremental, full] of result) expect(incremental).toBe(full);
  });

  test("D17: a very tall image can't split: it gets a page of its own, marked as overflowing; the text after it moves on", async ({ page }) => {
    // pagemd's PDF (checked in P6 Part 1): heading + "Before." on page 1, an empty page 2 (a Paged.js quirk), the
    // image cut off at the bottom of page 3, "After the image." on page 4. Print Layout: 3 pages, no blank page.
    expect(await open(page, doc('![tall](tall.svg)'))).toBe(3);
    const pages = await page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: Array<{ overflow: boolean }> } } } }).__pmd.pagination.layout.pages.map((p) => p.overflow));
    expect(pages).toEqual([false, true, false]);
  });

  test('D17: pages are laid out again when an image finishes loading (no run asked for)', async ({ page }) => {
    expect(await open(page, doc('![small](pic.png)'))).toBe(1);
    await page.evaluate(() => document.querySelector<HTMLImageElement>('.pmd-canvas img')!.setAttribute('src', 'tall.svg'));
    await expect.poll(() => pageCount(page), { timeout: 5000 }).toBe(3);
  });

  test('typing keeps the pages: a long document gains a page as text is added', async ({ page }) => {
    const before = await open(page, Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} with some words in it to fill a line or two of text on the page.`).join('\n\n'));
    await page.evaluate(() => {
      const { canvas } = (window as unknown as { __pmd: { canvas: { typeAtEndOfBlock(i: number, t: string): void } } }).__pmd;
      for (let i = 0; i < 30; i++) canvas.typeAtEndOfBlock(2, ' More words to make this paragraph long enough to move what follows onto the next page.');
    });
    await settle(page);
    expect(await pageCount(page)).toBeGreaterThan(before);
  });
});
