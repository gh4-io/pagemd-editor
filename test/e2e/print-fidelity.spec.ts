// P18 acceptance: Print Layout against pagemd's real PDF for template-driven documents. Two examples from the user's
// pagemd-examples repo are copied into fixtures/print-fidelity/ (the logo made smaller); their PDFs were built with the pagemd
// checkout's own CLI and read with `pdftotext -bbox` by scripts/print-fidelity-reference.mjs (stored, with a fingerprint: a stale
// reference fails here). Checked: the page count and size equal the PDF's, and words on page 1 are where the PDF has them (±12 pt,
// relative to the paper), a picture of page 1 is kept in the test's output folder. Also: the template frame shows in the views styled
// by the profile only, is not editable, is never saved, follows a property edit without moving the cursor, and runs no script.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { quiet } from '../support/quiet.ts';
// @ts-expect-error: a plain .mjs script without types
import { FIXTURE_DIR, fingerprint, REFERENCE_FILE } from '../../scripts/print-fidelity-reference.mjs';
import { openInPrintLayout, pageCount, settle, stylesFor } from './pagination-harness.ts';

interface Reference {
  documents: Record<string, { document: string; pdfPages: number; page: { width: number; height: number }; probes: Record<string, { x: number; y: number }>; fingerprint: string }>;
}
const reference = JSON.parse(readFileSync(REFERENCE_FILE as string, 'utf8')) as Reference;
/** How far (pt) a word may sit from where pagemd's PDF has it: font hinting, line boxes vs glyph boxes. */
const TOLERANCE_PT = 12;
const PT_PER_PX = 0.75;


function example(name: string) {
  const entry = reference.documents[name]!;
  const dir = `${FIXTURE_DIR as string}/${name}`;
  const path = `${dir}/${entry.document}`;
  return { entry, dir, path, text: readFileSync(path, 'utf8'), base: pathToFileURL(`${dir}/`).href };
}

async function open(page: Page, name: string) {
  const ex = example(name);
  expect(fingerprint(name), `the reference for ${name} is stale: run npm run print-fidelity:reference`).toBe(ex.entry.fingerprint);
  await page.setViewportSize({ width: 1400, height: 1100 });
  await openInPrintLayout(page, ex.path, ex.text, ex.base);
  return ex;
}

/**
 * Where `word` first appears on the canvas (text the author or the template wrote), in pt from page 1's paper's top left. The
 * same case as the PDF's word first (pdftotext matches exactly); in any case only when there is none, for words the profile
 * capitalises with CSS (the invitation's "INVITED" is "Invited" in the text). P19 round 3: with the case-insensitive match alone,
 * the brochure's "Seasonal" (a list item) was found as "seasonal" in the paragraph above it.
 */
function wordOnPageOne(page: Page, word: string) {
  return page.evaluate((w) => {
    const find = (exact: boolean) => {
    const canvas = document.querySelector('.pmd-canvas')!;
    const paper = canvas.querySelector('.pmd-pages > .pmd-page')!.getBoundingClientRect();
    const walker = document.createTreeWalker(canvas, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => ((n.parentElement?.closest('.pmd-pages, .pmd-chip, .pmd-fm-card, .pmd-page-marker') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue ?? '';
      const re = /\S+/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (exact ? m[0] !== w : m[0].toLowerCase() !== w.toLowerCase()) continue;
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const r = range.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // hidden
        return { x: r.left - paper.left, y: r.top - paper.top };
      }
    }
    return null;
    };
    return find(true) ?? find(false);
  }, word);
}

async function compareWithPdf(page: Page, name: string, info: { outputPath(name: string): string }) {
  const { entry } = example(name);
  const pages = await page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: Array<{ width: number; height: number; overflow: boolean }> } } } }).__pmd.pagination.layout.pages);
  expect(pages.length, `${name}: Print Layout ${pages.length} page(s), pagemd's PDF ${entry.pdfPages}`).toBe(entry.pdfPages);
  expect(Math.round(pages[0]!.width * PT_PER_PX), 'page width (pt)').toBe(Math.round(entry.page.width));
  expect(Math.round(pages[0]!.height * PT_PER_PX), 'page height (pt)').toBe(Math.round(entry.page.height));
  expect(pages.some((p) => p.overflow), 'no page overflows').toBe(false);
  const misses: string[] = [];
  for (const [word, at] of Object.entries(entry.probes)) {
    const found = await wordOnPageOne(page, word);
    if (!found) {
      misses.push(`"${word}" is not on the canvas`);
      continue;
    }
    const x = found.x * PT_PER_PX;
    const y = found.y * PT_PER_PX;
    if (Math.abs(x - at.x) > TOLERANCE_PT || Math.abs(y - at.y) > TOLERANCE_PT) misses.push(`"${word}" at (${x.toFixed(1)}, ${y.toFixed(1)}) pt, pagemd's PDF (${at.x}, ${at.y})`);
  }
  await page.locator('.pmd-canvas > .pmd-pages > .pmd-page').first().screenshot({ path: info.outputPath(`${name}-print-layout.png`) }).catch(() => undefined);
  expect(misses, `${name}: words away from where pagemd's PDF has them`).toEqual([]);
}

test.describe('the invitation (a template around a short text)', () => {
  test("Print Layout: one Letter page, the template's logo, headline, details and RSVP box where the PDF has them", async ({ page }, info) => {
    await open(page, 'invitation-uofo');
    await compareWithPdf(page, 'invitation-uofo', info);
  });

  test('the frame shows in Web Layout, Print Layout, Read and Split, not in Draft; it is not editable', async ({ page }) => {
    await open(page, 'invitation-uofo');
    const headline = page.locator('.pmd-canvas .invitation-headline');
    for (const mode of ['web', 'read', 'split', 'print']) {
      await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
      await expect(headline, mode).toHaveCount(1);
    }
    expect(await headline.evaluate((el) => (el as HTMLElement).isContentEditable)).toBe(false);
    // the text area stands in for the template's `.invitation-body` (its classes reach it)
    await expect(page.locator('.pmd-canvas .ProseMirror.invitation-body')).toHaveCount(1);
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
    await expect(headline).toHaveCount(0);
    await expect(page.locator('.pmd-canvas > .ProseMirror')).toHaveCount(1);
  });

  test("typing in the text saves only the text's own line; the template's words are never written", async ({ page }) => {
    const ex = await open(page, 'invitation-uofo');
    await page.locator('.pmd-canvas .ProseMirror p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Bring a dish!');
    await expect.poll(async () => (await sent(page)).filter((m) => m.method === 'applyEdits').length, { timeout: 5000 }).toBeGreaterThan(0);
    const edits = JSON.stringify((await sent(page)).filter((m) => m.method === 'applyEdits').map((m) => m.params));
    expect(edits).toContain('Bring a dish!');
    for (const fromTemplate of ["You're Invited", 'RSVP', 'Please respond by', 'invitation']) expect(edits).not.toContain(fromTemplate);
    expect(ex.text).not.toContain('RSVP');
  });

  test('a property edit changes the frame without moving the text area or the cursor', async ({ page }) => {
    const ex = await open(page, 'invitation-uofo');
    await page.locator('.pmd-canvas .ProseMirror p').first().click();
    await page.keyboard.press('End');
    const headNow = () => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { head: number } } } } } }).__pmd.canvas.view.state.selection.head);
    await expect.poll(headNow).toBeGreaterThan(100); // (the selection follows the key after the browser's selectionchange)
    const before = await page.evaluate(() => {
      const w = window as unknown as { __pm: Element; __pmd: { canvas: { view: { dom: Element; state: { selection: { head: number } } } } } };
      w.__pm = w.__pmd.canvas.view.dom;
      return w.__pmd.canvas.view.state.selection.head;
    });
    const payload = await stylesFor(ex.path, ex.text.replace('"The UOFO Annual Harvest Celebration"', '"The Spring Planting Social"'));
    await fromHost(page, { kind: 'event', name: 'stylesChanged', data: payload });
    await expect(page.locator('.pmd-canvas .invitation-headline')).toHaveText('The Spring Planting Social');
    const after = await page.evaluate(() => {
      const w = window as unknown as { __pm: Element; __pmd: { canvas: { view: { dom: Element; state: { selection: { head: number } } } } } };
      return { same: w.__pm === w.__pmd.canvas.view.dom && w.__pm.isConnected, head: w.__pmd.canvas.view.state.selection.head, focused: w.__pm.contains(document.activeElement) };
    });
    expect(after).toEqual({ same: true, head: before, focused: true });
    await page.keyboard.type('!'); // the typing goes on where it was
    expect(await page.evaluate((at) => (window as unknown as { __pmd: { canvas: { view: { state: { doc: { textBetween(a: number, b: number): string } } } } } }).__pmd.canvas.view.state.doc.textBetween(at, at + 1), before)).toBe('!');
  });

  test("a template's script, event attributes and script addresses never reach the page", async ({ page }) => {
    const ex = await open(page, 'invitation-uofo');
    const payload = (await stylesFor(ex.path, ex.text)) as { styles: { template: { html: string } } };
    payload.styles.template.html = `<script>window.__evil = 1</script><img id="evil-img" src="data:," onerror="window.__evil = 2"><a id="evil-a" href=" javascript:window.__evil=3">x</a><iframe srcdoc="<script>parent.__evil=4</script>"></iframe>${payload.styles.template.html}`;
    await fromHost(page, { kind: 'event', name: 'stylesChanged', data: payload });
    await expect(page.locator('#evil-a')).toHaveCount(1);
    await quiet(page);
    const found = await page.evaluate(() => ({
      evil: (window as unknown as { __evil?: number }).__evil ?? null,
      scripts: document.querySelectorAll('.pmd-canvas script, .pmd-canvas iframe').length,
      onerror: document.querySelector('#evil-img')?.getAttribute('onerror') ?? null,
      href: document.querySelector('#evil-a')?.getAttribute('href') ?? null,
    }));
    expect(found).toEqual({ evil: null, scripts: 0, onerror: null, href: null });
  });
});

test('control: without its template the invitation is only the text (the check above can fail)', async ({ page }) => {
  const ex = await open(page, 'invitation-uofo');
  const payload = (await stylesFor(ex.path, ex.text)) as { styles: { template?: unknown } };
  delete payload.styles.template;
  await fromHost(page, { kind: 'event', name: 'stylesChanged', data: payload });
  await settle(page);
  expect(await pageCount(page)).toBe(1);
  expect(await wordOnPageOne(page, 'RSVP')).toBeNull();
  const join = (await wordOnPageOne(page, 'join'))!;
  // without the template the text starts at the top of the page, far above where the PDF has it
  expect(Math.abs(join.y * PT_PER_PX - reference.documents['invitation-uofo']!.probes['join']!.y)).toBeGreaterThan(TOLERANCE_PT);
});

test.describe('the brochure (one landscape sheet in three panels: SECTION boxes, R-229)', () => {
  test("Print Layout: one 11 × 8.5 in sheet, the three panels side by side where the PDF has them", async ({ page }, info) => {
    await open(page, 'brochure-uofo');
    await expect(page.locator('.pmd-canvas .ProseMirror.brochure-content > .panel')).toHaveCount(3);
    await compareWithPdf(page, 'brochure-uofo', info);
  });

  test('a raw HTML block is drawn as pagemd draws it; its source shows while the cursor is in it, and in Draft', async ({ page }) => {
    await open(page, 'brochure-uofo');
    const view = page.locator('.pmd-canvas .pmd-html-view').first();
    await expect(view.locator('.pmd-html-preview .contact-label').first()).toBeVisible();
    await expect(view.locator('pre.pmd-html-block')).toBeHidden();
    // the cursor into the block (as an arrow key or a click would put it): the source shows, ready to edit
    await page.evaluate(() => {
      const { canvas } = (window as unknown as { __pmd: { canvas: { view: { state: { doc: { descendants(f: (n: { type: { name: string } }, p: number) => boolean | void): void } }; dispatch(tr: unknown): void }; reveal(pos: number, focus?: boolean): void } } }).__pmd;
      let at = -1;
      canvas.view.state.doc.descendants((n, p) => {
        if (at < 0 && n.type.name === 'html_block') at = p + 1;
        return at < 0;
      });
      canvas.reveal(at, true);
    });
    await expect(view.locator('pre.pmd-html-block')).toBeVisible();
    await expect(view.locator('.pmd-html-preview')).toBeHidden();
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
    await page.locator('.pmd-canvas .ProseMirror h2').first().click();
    await expect(view.locator('pre.pmd-html-block')).toBeVisible();
  });

  test('typing inside a panel saves only that paragraph; the boxes are never written', async ({ page }) => {
    const ex = await open(page, 'brochure-uofo');
    await page.locator('.pmd-canvas .panel-2 p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Since 1998.');
    await expect.poll(async () => (await sent(page)).filter((m) => m.method === 'applyEdits').length, { timeout: 5000 }).toBeGreaterThan(0);
    const params = (await sent(page)).filter((m) => m.method === 'applyEdits').map((m) => m.params as { edits: Array<{ from: number; to: number; text: string }> });
    const edits = params.flatMap((p) => p.edits);
    expect(edits).toHaveLength(1);
    const paragraph = ex.text.indexOf('Uncertified Organic Farmers Org grows');
    expect(edits[0]!.from).toBeGreaterThanOrEqual(paragraph);
    expect(edits[0]!.to).toBeLessThanOrEqual(ex.text.indexOf('- Seasonal'));
    expect(edits[0]!.text).not.toMatch(/SECTION|panel/);
  });
});

test('control: the brochure without boxes is one column that does not fit the sheet (the check above can fail)', async ({ page }) => {
  const ex = example('brochure-uofo');
  // the same document with its section markers turned into plain comments pagemd ignores: no boxes, the panels' CSS has nothing to style
  const flat = ex.text.replace(/<!-- ::SECTION_(START|END)[^>]*-->/g, '<!-- section -->');
  await page.setViewportSize({ width: 1400, height: 1100 });
  await openInPrintLayout(page, ex.path, flat, ex.base);
  await expect(page.locator('.pmd-canvas .panel')).toHaveCount(0);
  const what = (await wordOnPageOne(page, 'What'))!;
  expect(Math.abs(what.x * PT_PER_PX - reference.documents['brochure-uofo']!.probes['What']!.x)).toBeGreaterThan(TOLERANCE_PT);
});
