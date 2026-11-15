// P21 acceptance in a real browser (Chromium), with the styles style-pagemd resolves from the real pagemd checkout:
// - Print Layout draws each page's own header and footer, page by page the same strings pagemd's PDF prints for the page-type
//   fixtures (test/e2e/fixtures/page-types/; scripts/page-types-reference.mjs, stored with a fingerprint: a stale reference
//   fails here), with the same page count and the same page type (its margins) on every page;
// - the one allowed difference is the sheet size of a page type that is not the plain page's size: pagemd's PDF prints it at
//   the plain size until C11. That is an explicit list (KNOWN_SIZE_MISMATCH), asserted both ways, so emptying it is part of C11;
// - those sheets get a tag above them in Print Layout (not in Read) and the status bar says it once;
// - Read view shows the same headers; Draft and Web Layout show none (as before).
// Run: npm run test:e2e (builds first).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { frames } from '../support/quiet.ts';
// @ts-expect-error: a plain .mjs script without types
import { DOCUMENTS, FIXTURE, fingerprint, REFERENCE_FILE } from '../../scripts/page-types-reference.mjs';
import { openInPrintLayout, settle } from './pagination-harness.ts';

type Boxes = { left: string; center: string; right: string };
interface ReferencePage {
  size: { width: number; height: number };
  textLeft: number;
  header: Boxes;
  footer: Boxes;
}
const reference = JSON.parse(readFileSync(REFERENCE_FILE as string, 'utf8')) as { documents: Record<string, ReferencePage[]>; fingerprint: string };
const PT_PER_MM = 72 / 25.4;

/** Page types drawn at their own size while pagemd's PDF prints them at the plain page's (until C11 makes the PDF follow the CSS). */
const KNOWN_SIZE_MISMATCH: Record<string, string[]> = { 'cascade.md': ['wide', 'legal'], 'clear.md': [], 'props.md': [] };


async function open(page: Page, doc: string): Promise<void> {
  expect(fingerprint(), 'the reference is stale: run npm run page-types:reference').toBe(reference.fingerprint);
  await page.setViewportSize({ width: 1400, height: 1100 });
  const path = `${FIXTURE as string}/${doc}`;
  await openInPrintLayout(page, path, readFileSync(path, 'utf8'), pathToFileURL(`${FIXTURE as string}/`).href);
}

interface CanvasPage {
  name: string;
  size: { width: number; height: number };
  marginLeft: number;
  header: Boxes | null;
  footer: Boxes | null;
  tag: string | null;
}

/** Every paper: its page type, size and left margin (pt), the header/footer boxes' text and the size tag. */
function canvasPages(page: Page): Promise<CanvasPage[]> {
  return page.evaluate((ptPerMm) => {
    const pmd = (window as unknown as { __pmd: { pagination: { layout: { pages: { name: string; geometry: { width: number; height: number; margins: { left: number } } }[] } | null } } }).__pmd;
    const pages = pmd.pagination.layout?.pages ?? [];
    const papers = [...document.querySelectorAll<HTMLElement>('.pmd-canvas > .pmd-pages > .pmd-page')];
    const boxes = (el: Element | null) =>
      el ? (Object.fromEntries(['left', 'center', 'right'].map((b) => [b, (el.querySelector(`[data-box="${b}"]`)?.textContent ?? '').replace(/\s+/g, ' ').trim()])) as { left: string; center: string; right: string }) : null;
    return papers.map((paper, i) => {
      const g = pages[i]!.geometry;
      return {
        name: pages[i]!.name,
        size: { width: Math.round(g.width * ptPerMm), height: Math.round(g.height * ptPerMm) },
        marginLeft: Math.round(g.margins.left * ptPerMm),
        header: boxes(paper.querySelector(':scope > .pmd-page-header')),
        footer: boxes(paper.querySelector(':scope > .pmd-page-footer')),
        tag: paper.querySelector(':scope > .pmd-page-size-tag')?.textContent ?? null,
      };
    });
  }, PT_PER_MM);
}

const EMPTY: Boxes = { left: '', center: '', right: '' };
const shown = (b: Boxes | null): Boxes => b ?? EMPTY;
const statusText = (page: Page) => page.locator('.pmd-status-bar').innerText();

for (const doc of DOCUMENTS as string[]) {
  test(`${doc}: every page's header and footer are the PDF's, page by page (Print Layout)`, async ({ page }) => {
    await open(page, doc);
    const pdf = reference.documents[doc]!;
    const canvas = await canvasPages(page);
    expect(canvas.length, 'page count').toBe(pdf.length);
    canvas.forEach((c, i) => {
      const at = `${doc} page ${i + 1} (${c.name || 'plain'})`;
      expect(shown(c.header), `${at}: header`).toEqual(pdf[i]!.header);
      expect(shown(c.footer), `${at}: footer`).toEqual(pdf[i]!.footer);
      // The page type: its margins are honoured by the PDF, so the text starts where the canvas's margin is
      expect(Math.abs(c.marginLeft - pdf[i]!.textLeft), `${at}: left margin`).toBeLessThanOrEqual(2);
      // The sheet size: the same, except the listed page types (pagemd's PDF prints them at the plain size until C11)
      const mismatch = KNOWN_SIZE_MISMATCH[doc]!.includes(c.name);
      if (mismatch) expect(c.size, `${at}: listed as a known size mismatch, so it must still differ`).not.toEqual(pdf[i]!.size);
      else expect(c.size, `${at}: size`).toEqual(pdf[i]!.size);
      // The tag above such a sheet, and only there
      expect(c.tag, `${at}: size tag`).toBe(mismatch ? `PDF prints this page at 8.5 × 11 in, portrait` : null);
    });
    if (KNOWN_SIZE_MISMATCH[doc]!.length) {
      await expect(page.locator('.pmd-status-bar')).toContainText(`drawn as your layout says; pagemd's PDF currently prints every page at the plain page's size (8.5 × 11 in, portrait)`);
    } else {
      expect(await statusText(page)).not.toContain('drawn as your layout says');
    }
  });
}

test('cascade.md: the PDF table (pages 3, 4, 5) and a second run of wide pages starting again with WIDE FIRST', async ({ page }) => {
  await open(page, 'cascade.md');
  const canvas = await canvasPages(page);
  expect([canvas[2]!.header?.left, canvas[2]!.header?.right, canvas[2]!.footer?.center]).toEqual(['WIDE FIRST', 'MAIN RIGHT', 'Wide page 3']);
  expect([canvas[3]!.header?.left, canvas[3]!.header?.right, canvas[3]!.footer?.center]).toEqual(['WIDE HEADER', 'MAIN RIGHT', 'Wide page 4']);
  expect([canvas[4]!.header?.left, canvas[4]!.header?.right, canvas[4]!.footer?.center]).toEqual(['MAIN HEADER', 'MAIN RIGHT', 'Page 5 of 8']);
  expect(canvas[5]!.header?.left).toBe('WIDE FIRST');
  expect(canvas[6]!.header?.left).toBe('WIDE HEADER');
  // The header text stays out of the screen reader's way, as before; the tag is not focusable and hidden from it
  expect(await page.locator('.pmd-page-header').first().evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  const tag = page.locator('.pmd-page-size-tag').first();
  await expect(tag).toHaveAttribute('aria-hidden', 'true');
  expect(await tag.evaluate((el) => (el as HTMLElement).tabIndex)).toBe(-1);
  // Outside the paper: above its top edge
  const [paperTop, tagBottom] = await tag.evaluate((el) => [el.parentElement!.getBoundingClientRect().top, el.getBoundingClientRect().bottom]);
  expect(tagBottom).toBeLessThanOrEqual(paperTop!);
});

test('Read view shows the same page headers (no size tags); Draft and Web Layout show none', async ({ page }) => {
  await open(page, 'cascade.md');
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'read' } });
  await frames(page);
  await settle(page);
  const read = await canvasPages(page);
  // The same papers as Print Layout: page by page the PDF's strings
  expect(read.map((p) => [shown(p.header), shown(p.footer)])).toEqual(reference.documents['cascade.md']!.map((p) => [p.header, p.footer]));
  expect(read.every((p) => p.tag === null)).toBe(true);
  await expect(page.locator('.pmd-status-bar')).toContainText('drawn as your layout says');
  for (const mode of ['draft', 'web']) {
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
    await frames(page);
    await expect(page.locator('.pmd-page-header, .pmd-page-footer, .pmd-page-size-tag')).toHaveCount(0);
    expect(await statusText(page)).not.toContain('drawn as your layout says');
  }
});
