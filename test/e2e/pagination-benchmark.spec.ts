// P6 acceptance (amendment 12): typing stays responsive in Print Layout on a 30-page document.
// - Keystroke: one typed character as ProseMirror applies it (a transaction), plus the style and layout work the
//   browser must do before it can paint it. Pagination isn't part of it: it runs after that frame (paginator.ts).
//   Limit: < 16 ms (95th percentile), one frame at 60 Hz.
// - Re-pagination after the keystroke: measure + layout + drawing the gaps, plus the layout that follows.
//   Limit: < 50 ms (95th percentile), so pages settle within a few frames.
// The document: pagemd's 10-index-multipage-stress example, from its checkout. pagemd's PDF has 35 pages: 23 of the document's
// own text and 12 pagemd makes itself (the contents page and the generated subject index), which the canvas doesn't draw. Print
// Layout showed 38 until P18 only because list items starting with an INDEX marker were tall raw blocks (OQ-38); since P18 it
// shows 22-23, as the PDF's body. So the page count is checked against the stored PDF reference (±1, as pagination.spec.ts), not
// "at least 30" (P19 round 3: the old number held only because of that bug).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { bodyPageCount, openInPrintLayout, PAGEMD_ROOT } from './pagination-harness.ts';
// @ts-expect-error: a plain .mjs script without types
import { REFERENCE_FILE } from '../../scripts/pagination-reference.mjs';

const REFERENCE = (JSON.parse(readFileSync(REFERENCE_FILE as string, 'utf8')) as { documents: Record<string, { bodyPages: number }> }).documents['tests/corpus/pagemd/examples/md/10-index-multipage-stress.md']!;

const DOC = `${PAGEMD_ROOT}/tests/corpus/pagemd/examples/md/10-index-multipage-stress.md`;
const KEYSTROKES = 60;

for (const arrangement of ['vertical', 'side-by-side'] as const) test(`typing on a 23-page document (${arrangement}): < 16 ms per keystroke, < 50 ms to re-paginate (95th percentile)`, async ({ page }) => {
  test.setTimeout(120_000);
  await openInPrintLayout(page, DOC, readFileSync(DOC, 'utf8'), pathToFileURL(`${PAGEMD_ROOT}/tests/corpus/pagemd/examples/md/`).href);
  expect(Math.abs((await bodyPageCount(page)) - REFERENCE.bodyPages), "the document's body pages, as pagemd's PDF has them (±1)").toBeLessThanOrEqual(1);
  // Side by side (Part 2): every run puts the columns back into one for the measuring, then lays them out again.
  if (arrangement === 'side-by-side') await page.locator('.pmd-status-arrangement').selectOption('side-by-side');

  const result = await page.evaluate((count) => {
    type View = { state: { doc: { childCount: number; child(i: number): { nodeSize: number; isTextblock: boolean } }; tr: { insertText(t: string, pos: number): unknown } }; dispatch(tr: unknown): void; dom: HTMLElement };
    const { canvas, pagination } = (window as unknown as { __pmd: { canvas: { view: View }; pagination: { run(): { ms: number } | null } } }).__pmd;
    const view = canvas.view;
    const keystrokes: number[] = [];
    const repaginations: number[] = [];
    // Type into textblocks spread over the document (near the start is the worst case: everything after moves).
    const targets: number[] = [];
    let pos = 0;
    for (let i = 0; i < view.state.doc.childCount; i++) {
      const child = view.state.doc.child(i);
      if (child.isTextblock) targets.push(pos + 1);
      pos += child.nodeSize;
    }
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
    return { keystroke: p95(keystrokes), repagination: p95(repaginations), maxKeystroke: Math.max(...keystrokes), maxRepagination: Math.max(...repaginations) };
  }, KEYSTROKES);

  console.log(`pagination benchmark, ${arrangement} (${KEYSTROKES} keystrokes): keystroke p95 ${result.keystroke.toFixed(2)} ms (max ${result.maxKeystroke.toFixed(2)}), re-pagination p95 ${result.repagination.toFixed(2)} ms (max ${result.maxRepagination.toFixed(2)})`);
  expect(result.keystroke).toBeLessThan(16);
  expect(result.repagination).toBeLessThan(50);
});
