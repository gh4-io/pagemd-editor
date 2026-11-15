// P19 acceptance in a real browser (Chromium), with the styles style-pagemd resolves from the real pagemd checkout:
// - Print Layout puts the columns of pagemd's example `16-table-column-widths.md` where pagemd's PDF has them (±2 pt), and the
//   long table's columns where the PDF has them on every page it runs over (scripts/table-widths-reference.mjs, stored with a
//   fingerprint: a stale reference fails here);
// - dragging a column border: two columns change on the page while the pointer moves, nothing is sent until release, then ONE
//   edit (one undo step in VS Code) writes the table's hidden `<!-- ::TABLE widths="…" -->` comment (round 3); Escape puts the
//   widths back and sends nothing;
//   off in Read;
// - the Table tab's Width buttons and the Inspector's Width (%) box (typed, Enter) write the widths.
// Run: npm run test:e2e (builds first).
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { frames, quiet } from '../support/quiet.ts';
// @ts-expect-error: a plain .mjs script without types
import { EXAMPLE, fingerprint, REFERENCE_FILE } from '../../scripts/table-widths-reference.mjs';
import { openInPrintLayout, PAGEMD_ROOT, settle } from './pagination-harness.ts';

interface Reference {
  pageWidth: number;
  probes: Record<string, { page: number; x: number }[]>;
  fingerprint: string;
}
const reference = JSON.parse(readFileSync(REFERENCE_FILE as string, 'utf8')) as Reference;
const PATH = `${PAGEMD_ROOT}/${EXAMPLE as string}`;
const TEXT = readFileSync(PATH, 'utf8');
/** How far (pt) a column may start from where pagemd's PDF starts it. */
const TOLERANCE_PT = 2;
const PT_PER_PX = 0.75;

type Edit = { from: number; to: number; text: string };
const editsSent = async (page: Page): Promise<Edit[][]> => (await sent(page)).filter((m) => m.method === 'applyEdits').map((m) => (m.params as { edits: Edit[] }).edits);
const apply = (text: string, edits: Edit[]): string => {
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.from) + e.text;
    at = e.to;
  }
  return out + text.slice(at);
};

/** The host's side: answers every edit request not answered yet (as VS Code does) and returns the text it now has. */
function pretendHost(page: Page): () => Promise<string> {
  let text = TEXT;
  let answered = 0;
  return async () => {
    const requests = (await sent(page)).filter((m) => m.method === 'applyEdits');
    for (; answered < requests.length; answered++) {
      const request = requests[answered]!;
      text = apply(text, (request.params as { edits: Edit[] }).edits);
      await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: answered + 2 } });
    }
    return text;
  };
}

async function open(page: Page): Promise<void> {
  expect(fingerprint(), 'the reference is stale: run npm run table-widths:reference').toBe(reference.fingerprint);
  await page.setViewportSize({ width: 1400, height: 1100 });
  await openInPrintLayout(page, PATH, TEXT, pathToFileURL(`${dirname(PATH)}/`).href);
}

/** Every place `word` starts a text on the canvas: x in pt from the paper's left edge. */
function wordXs(page: Page, word: string): Promise<number[]> {
  return page.evaluate(
    ([w, ptPerPx]) => {
      const canvas = document.querySelector('.pmd-canvas')!;
      const paper = canvas.querySelector('.pmd-pages > .pmd-page')!.getBoundingClientRect();
      const out: number[] = [];
      const walker = document.createTreeWalker(canvas.querySelector('.ProseMirror')!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue ?? '';
        const re = /\S+/g;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          if (m[0] !== w) continue;
          const range = document.createRange();
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          const r = range.getBoundingClientRect();
          if (r.width > 0) out.push((r.left - paper.left) * (ptPerPx as number));
        }
      }
      return out;
    },
    [word, PT_PER_PX] as const,
  );
}

const cell = (page: Page, text: string) => page.locator('.pmd-canvas td, .pmd-canvas th').filter({ hasText: new RegExp(`^${text}$`) }).first();
/** The `<col>` widths of the table holding the cell with `text` (as the style says, e.g. "50%"). */
const colWidths = (page: Page, text: string): Promise<string[]> => cell(page, text).evaluate((c) => [...c.closest('table')!.querySelectorAll(':scope > colgroup > col')].map((col) => (col as HTMLElement).style.width));
/** The document the canvas holds, as JSON (to see that a drag changes nothing until release). */
const docJson = (page: Page) => page.evaluate(() => JSON.stringify((window as unknown as { __pmd: { canvas: { view: { state: { doc: { toJSON(): unknown } } } } } }).__pmd.canvas.view.state.doc.toJSON()));
const pmdView = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { dom: HTMLElement } } } }).__pmd.canvas.view.dom.className);

/** Presses on the border to the right of the cell with `text`, moves the pointer by `dx` (screen px) and keeps it pressed. */
async function grab(page: Page, text: string, dx: number): Promise<void> {
  const box = (await cell(page, text).boundingBox())!;
  const x = box.x + box.width - 1;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 20, y);
  await page.mouse.move(x, y);
  await expect.poll(() => pmdView(page)).toContain('pmd-col-resize');
  await page.mouse.down();
  for (let k = 1; k <= 5; k++) await page.mouse.move(x + (dx * k) / 5, y);
}

test.describe('table column widths (P19)', () => {
  test("Print Layout starts each column where pagemd's PDF does, on every page of a long table", async ({ page }) => {
    await open(page);
    const misses: string[] = [];
    for (const [word, places] of Object.entries(reference.probes)) {
      const xs = await wordXs(page, word);
      if (xs.length === 0) {
        misses.push(`"${word}" is not on the canvas`);
        continue;
      }
      // The canvas draws one table (every row at the same x); the PDF has a split table on several pages: each must agree.
      const x = xs[0]!;
      for (const p of places) if (Math.abs(x - p.x) > TOLERANCE_PT) misses.push(`"${word}" at ${x.toFixed(1)} pt, pagemd's PDF page ${p.page}: ${p.x} pt`);
    }
    expect(misses).toEqual([]);
    // control: the columns really are set (equal columns would start "Replace" at 2/3 of the 468 pt text width, not at 50 % + 15 %)
    expect(Math.abs((await wordXs(page, 'Replace'))[0]! - (72 + 468 * (2 / 3) + 8.2))).toBeGreaterThan(5);
  });

  test('dragging a border: two columns change while the pointer moves, nothing is sent; release sends ONE edit of the {…} line', async ({ page }) => {
    await open(page);
    expect(await colWidths(page, 'Part')).toEqual(['50%', '15%', '35%']);
    const before = (await editsSent(page)).length;
    const doc = await docJson(page);
    const table = (await cell(page, 'Part').evaluate((c) => c.closest('table')!.getBoundingClientRect().width)) as number;
    await grab(page, 'Part', table * 0.1); // +10 % of the table
    const live = (await colWidths(page, 'Part')).map((w) => Math.round(parseFloat(w)));
    expect(live).toEqual([60, 5, 35]); // Qty can't go below 5 %
    expect((await editsSent(page)).length).toBe(before);
    expect(await docJson(page), 'the document does not change while the pointer moves').toBe(doc);
    await page.mouse.up();
    await expect.poll(async () => (await editsSent(page)).length).toBe(before + 1);
    await quiet(page);
    const batches = (await editsSent(page)).slice(before);
    expect(batches).toHaveLength(1); // one change sent: one undo step in VS Code
    const after = apply(TEXT, batches[0]!);
    expect(after).toContain('<!-- ::TABLE widths="60% 5% 35%" -->');
    // only the first table's lines change
    const changed = TEXT.split('\n').filter((line, i) => after.split('\n')[i] !== line);
    expect(changed.every((line) => line.startsWith('|') || line.startsWith('{') || line.startsWith('<!-- ::TABLE'))).toBe(true);
    await expect.poll(() => colWidths(page, 'Part')).toEqual(['60%', '5%', '35%']);
  });

  test('Escape during a drag puts the widths back and sends nothing; Read has no handle', async ({ page }) => {
    await open(page);
    const before = (await editsSent(page)).length;
    await grab(page, 'Part', 40);
    expect(parseFloat((await colWidths(page, 'Part'))[0]!)).toBeGreaterThan(50);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await colWidths(page, 'Part')).toEqual(['50%', '15%', '35%']);
    await quiet(page);
    expect((await editsSent(page)).length).toBe(before);
    // a table without widths: Escape takes the preview's <colgroup> away again
    const short = cell(page, 'Short');
    expect(await short.evaluate((c) => c.closest('table')!.querySelector(':scope > colgroup'))).toBeNull();
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'read' } });
    await settle(page);
    const box = (await cell(page, 'Part').boundingBox())!;
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
    await frames(page);
    expect(await pmdView(page)).not.toContain('pmd-col-resize');
  });

  test('the Width buttons and the Inspector\'s Width (%) box write the widths', async ({ page }) => {
    await open(page);
    const host = pretendHost(page);
    await host();
    await cell(page, 'Bolts').click();
    await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Table', exact: true }).click();
    await page.locator('.pmd-ribbon [data-command="table.column-wider"]').click();
    await expect.poll(host).toContain('<!-- ::TABLE widths="55% 10% 35%" -->');
    // the Inspector: type a width for the first column and press Enter (keyboard only)
    await page.evaluate(() => {
      const api = (window as unknown as { __pmd: { view: { set(v: unknown): void }; inspector: { show(t: string): void } } }).__pmd;
      api.view.set({ panels: { inspector: true } });
      api.inspector.show('element');
    });
    await cell(page, 'Bolts').click();
    const box = page.locator('.pmd-inspector [data-field="columns.0.width"] input');
    await expect(box).toHaveValue('55');
    await box.fill('40');
    await box.press('Enter');
    await expect.poll(host).toContain('<!-- ::TABLE widths="40% 10% 35%" -->');
    // Equal widths, then Automatic
    await cell(page, 'Bolts').click();
    await page.locator('.pmd-ribbon [data-command="table.equal-widths"]').click();
    await expect.poll(host).toContain('| Gasket | 1 | Replace at every service |\n<!-- ::TABLE widths="equal" -->');
    await expect(page.locator('.pmd-ribbon [data-command="table.equal-widths"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.pmd-ribbon [data-command="table.reset-widths"]').click();
    await expect.poll(host).toContain('| Gasket | 1 | Replace at every service |\n\n## Equal Widths');
  });
});
