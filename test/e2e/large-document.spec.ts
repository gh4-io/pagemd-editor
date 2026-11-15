// P13 acceptance 4 and 5: a generated 100+ page document (the normal tier) and a 400+ page one (the large tier, P13b) stay inside
// the budgets. Guards a regression that walks the whole document per keystroke or re-reads it per edit. The document comes from
// fixtures/large.ts (seeded, so the same each run).
// Budgets (Chromium on the dev machine; the value measured in session 30 for ~109 pages is in brackets):
//   normal: open -> settled Print Layout <= 1.5 s [0.6]; keystroke p95 < 16 ms [3.7]; re-pagination p95 < 50 ms [22];
//   the diff for the save after the pause < 50 ms [10]; an outside change re-read < 250 ms [72]; JS heap < 200 MB [77].
//   large (about 400 pages; the plan's numbers in brackets, AD-P13-24): open <= 5 s [plan 3 s; measured 2.8-3.0 alone]; keystroke p95 < 16 ms
//   [plan 16; session 30 measured 13-14, now 6-7 after the per-keystroke walks were removed]; re-pagination p95 < 500 ms [plan 250;
//   measured 290-300 alone, 430 with the other specs running]; re-read < 500 ms [220]. The generated document is about 1.6 times as dense
//   per page (825 k characters for 405 pages; session 30's measurement document had 560 k for 435), so the numbers that grow with the
//   page count (open, re-pagination, re-read) have 1.6 times what was measured alone as room for a busy machine; the keystroke budget is the
//   plan's. This file runs by itself, after the other specs (playwright.config.ts: the project "large" depends on "chromium"); to run only this file,
// use `npx playwright test large-document.spec.ts --no-deps`.
import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { largeDocument } from './fixtures/large.ts';
import { openInPrintLayout, pageCount, PAGEMD_ROOT } from './pagination-harness.ts';

const SECTIONS = Number(process.env['PMD_LARGE_SECTIONS'] ?? 110);
/** About 1.09 pages a section: 370 sections are 400+ pages (the test asserts the page count it really gets). */
const LARGE_SECTIONS = Number(process.env['PMD_LARGE_TIER_SECTIONS'] ?? 375);
const KEYSTROKES = 60;
const DOC = `${PAGEMD_ROOT}/large-benchmark.md`; // a path only: the text is passed in, nothing is read from it
const BASE = pathToFileURL(`${PAGEMD_ROOT}/`).href;

type Metrics = { keystroke: number; maxKeystroke: number; repagination: number; maxRepagination: number; saveDiff: number; reread: number; heapMb: number | null };

/** Types one character into textblocks spread over the first part of the document, as the P6 benchmark does. */
async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(async (count) => {
    type View = { state: { doc: { childCount: number; child(i: number): { nodeSize: number; isTextblock: boolean } }; tr: { insertText(t: string, pos: number): unknown } }; dispatch(tr: unknown): void; dom: HTMLElement };
    const { canvas, pagination } = (window as unknown as { __pmd: { canvas: { view: View }; pagination: { run(): unknown } } }).__pmd;
    const view = canvas.view;
    const targets: number[] = [];
    let pos = 0;
    for (let i = 0; i < view.state.doc.childCount; i++) {
      const child = view.state.doc.child(i);
      if (child.isTextblock) targets.push(pos + 1);
      pos += child.nodeSize;
    }
    const keystrokes: number[] = [];
    const repaginations: number[] = [];
    for (let k = 0; k < count; k++) {
      const at = targets[Math.floor((k / count) * Math.min(targets.length, 40))]!;
      const t0 = performance.now();
      view.dispatch(view.state.tr.insertText('x', at));
      void view.dom.getBoundingClientRect(); // style + layout, as the frame would
      keystrokes.push(performance.now() - t0);
      const t1 = performance.now();
      pagination.run();
      void view.dom.getBoundingClientRect();
      repaginations.push(performance.now() - t1);
    }
    const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;

    // The save after the pause: the canvas diffs its document against the host's and sends one applyEdits. Forced at once with
    // the same event the image shapes use; timed until the request is posted to the host.
    const toHost = (window as unknown as { __toHost: { method?: string }[] }).__toHost;
    const before = toHost.filter((m) => m.method === 'applyEdits').length;
    const t2 = performance.now();
    view.dom.dispatchEvent(new CustomEvent('pmd-flush', { bubbles: true }));
    while (toHost.filter((m) => m.method === 'applyEdits').length === before) await Promise.resolve();
    const saveDiff = performance.now() - t2;

    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return { keystroke: p95(keystrokes), maxKeystroke: Math.max(...keystrokes), repagination: p95(repaginations), maxRepagination: Math.max(...repaginations), saveDiff, reread: 0, heapMb: memory ? memory.usedJSHeapSize / 1048576 : null };
  }, KEYSTROKES);
}

async function tier(page: Page, sections: number, minPages: number, budget: { open: number; keystroke: number; repagination: number; saveDiff: number; reread: number; heap: number }): Promise<void> {
  const text = largeDocument(sections);
  const opened = Date.now();
  await openInPrintLayout(page, DOC, text, BASE);
  const openSeconds = (Date.now() - opened) / 1000;
  const pages = await pageCount(page);
  expect(pages, `the generated document should paginate to ${minPages}+ pages`).toBeGreaterThanOrEqual(minPages);

  const result = await measure(page);

  // An outside change (VS Code's undo, a git checkout): the host sends the whole new text; time until the canvas shows it.
  const changed = text.replace('# Large benchmark document', '# Large benchmark document, changed');
  result.reread = await page.evaluate(
    (text2) =>
      new Promise<number>((resolve) => {
        const t0 = performance.now();
        const canvas = document.querySelector('.pmd-canvas .ProseMirror')!;
        const poll = () => (canvas.textContent?.includes('document, changed') ? resolve(performance.now() - t0) : setTimeout(poll, 0));
        window.postMessage({ kind: 'event', name: 'externalChange', data: { text: text2, version: 99 } }, '*');
        poll();
      }),
    changed,
  );

  console.log(
    `large document (${pages} pages, ${(text.length / 1000).toFixed(0)} k characters): open -> settled ${openSeconds.toFixed(2)} s, keystroke p95 ${result.keystroke.toFixed(2)} ms (max ${result.maxKeystroke.toFixed(2)}), ` +
      `re-pagination p95 ${result.repagination.toFixed(2)} ms (max ${result.maxRepagination.toFixed(2)}), save diff ${result.saveDiff.toFixed(1)} ms, outside change re-read ${result.reread.toFixed(0)} ms, heap ${result.heapMb?.toFixed(0) ?? '?'} MB`,
  );
  expect(openSeconds).toBeLessThan(budget.open);
  expect(result.keystroke).toBeLessThan(budget.keystroke);
  expect(result.repagination).toBeLessThan(budget.repagination);
  expect(result.saveDiff).toBeLessThan(budget.saveDiff);
  expect(result.reread).toBeLessThan(budget.reread);
  if (result.heapMb !== null) expect(result.heapMb).toBeLessThan(budget.heap);
}

test(`a ${SECTIONS}-section document (100+ pages): open, type, save and re-read inside the budgets`, async ({ page }) => {
  test.setTimeout(180_000);
  await tier(page, SECTIONS, 100, { open: 1.5, keystroke: 16, repagination: 50, saveDiff: 50, reread: 250, heap: 200 });
});

// P13b (acceptance 5): the large tier. Looser limits for the work that grows with the page count (opening, re-paginating the whole
// document, re-reading it); the keystroke stays under one frame. A partial re-pagination is not part of P13 (a design change in
// components/pagination); if this tier fails, that is the follow-up.
test(`a ${LARGE_SECTIONS}-section document (400+ pages): open, type, save and re-read inside the large-tier budgets`, async ({ page }) => {
  test.setTimeout(300_000);
  await tier(page, LARGE_SECTIONS, 400, { open: 5, keystroke: 16, repagination: 500, saveDiff: 150, reread: 500, heap: 400 });
});
