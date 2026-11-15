// Fix run word-style-tables-pictures (AD-FIX-WS-03, AD-FIX-WS-04), Word's way for pictures: Size works on a plain image (it
// writes pagemd's class `{.width-half}`, which the document's own profile CSS draws, so the width really shows on the canvas)
// and on an embed (it becomes a figure with the width); Caption on a plain image makes it a figure in one edit and puts the
// cursor in the caption box, as Word's Insert Caption wraps a picture. Uses the real profile CSS (the print-fidelity harness).
// Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { sent, type Message } from '../support/host.ts';
import { quiet } from '../support/quiet.ts';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: a plain .mjs script without types
import { FIXTURE_DIR, REFERENCE_FILE } from '../../scripts/print-fidelity-reference.mjs';
import { openInPrintLayout } from './pagination-harness.ts';

const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const reference = JSON.parse(readFileSync(REFERENCE_FILE as string, 'utf8')) as { documents: Record<string, { document: string }> };
const first = Object.keys(reference.documents)[0]!;
const PATH = `${FIXTURE_DIR as string}/${first}/word-style.md`;
const DOC = 'First para.\n\n![Plain](wide.png)\n\n![[wide.png|Embedded]]\n\nEnd.\n';

const edits = async (page: Page) => (await sent(page)).filter((m) => m.method === 'applyEdits');
const button = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const img = (page: Page, selector: string) => page.locator(`.pmd-canvas ${selector}`);
const widthOf = async (page: Page, selector: string) => (await img(page, selector).boundingBox())!.width;
const selectedNode = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { node?: { type: { name: string } } } } } } } }).__pmd.canvas.view.state.selection.node?.type.name ?? null);

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openInPrintLayout(page, PATH, DOC, fixtures);
  await expect(img(page, 'img[alt="Plain"]')).toHaveJSProperty('complete', true);
  return errors;
}

async function select(page: Page, selector: string, node: string) {
  await img(page, selector).click({ position: { x: 4, y: 4 } });
  await expect.poll(() => selectedNode(page)).toBe(node);
}

test.describe('Size on a plain image', () => {
  test('Half, Quarter and Original change the picture on the canvas and write the class, one edit each', async ({ page }) => {
    const errors = await open(page);
    const plain = 'img[alt="Plain"]';
    const natural = await widthOf(page, plain);
    const column = (await img(page, 'p:has(img[alt="Plain"])').boundingBox())!.width;
    await select(page, plain, 'image');
    await expect(button(page, 'picture.width-half')).toHaveAttribute('aria-disabled', 'false');
    const before = (await edits(page)).length;
    await button(page, 'picture.width-half').click();
    await expect.poll(async () => (await edits(page)).length).toBe(before + 1);
    expect(JSON.stringify((await edits(page)).at(-1)!.params)).toContain('![Plain](wide.png){.width-half}');
    await expect.poll(() => widthOf(page, plain)).toBeLessThan(column * 0.55);
    expect(await widthOf(page, plain)).toBeGreaterThan(column * 0.45);
    await expect(button(page, 'picture.width-half')).toHaveAttribute('aria-pressed', 'true');
    await select(page, plain, 'image');
    await button(page, 'picture.width-quarter').click();
    // (The pretend host does not answer, so the next edit waits; the canvas itself shows the result.)
    await expect(img(page, plain)).toHaveClass(/width-quarter/);
    await expect.poll(() => widthOf(page, plain)).toBeLessThan(column * 0.3);
    await select(page, plain, 'image');
    await button(page, 'picture.width-original').click();
    await expect(img(page, plain)).not.toHaveClass(/width-/);
    await expect.poll(() => widthOf(page, plain)).toBeCloseTo(natural, 0);
    expect(errors).toEqual([]);
  });

  test('on an embed, Size makes it a figure with the width in one edit', async ({ page }) => {
    const errors = await open(page);
    await select(page, 'img.embedded-image', 'pmd_embed');
    const before = (await edits(page)).length;
    await button(page, 'picture.width-third').click();
    await expect.poll(async () => (await edits(page)).length).toBe(before + 1);
    expect(JSON.stringify((await edits(page)).at(-1)!.params)).toContain('width=\\"third\\"');
    await quiet(page);
    expect((await edits(page)).length).toBe(before + 1);
    await expect(img(page, '.pmd-figure')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});

test.describe('Caption on a plain image', () => {
  test('makes it a figure in one edit and the caption box takes the cursor', async ({ page }) => {
    const errors = await open(page);
    await select(page, 'img[alt="Plain"]', 'image');
    await expect(button(page, 'picture.caption')).toHaveAttribute('aria-disabled', 'false');
    const before = (await edits(page)).length;
    await button(page, 'picture.caption').click();
    await expect.poll(async () => (await edits(page)).length).toBe(before + 1);
    // R-253 / AD-FIX-RF-01: with no caption yet the picture stays the plain line `![Plain](wide.png)` (no comment line: nothing to hold)
    expect(JSON.stringify((await edits(page)).at(-1)!.params)).toContain('![Plain](wide.png)');
    expect(JSON.stringify((await edits(page)).at(-1)!.params)).not.toContain('::FIGURE');
    await expect(img(page, '.pmd-figure')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-field]')?.getAttribute('data-field') ?? null)).toBe('caption');
    // (Typing the caption and the title plus bare marker it writes are covered in paste-find.spec.ts; this pretend host does not answer, so a second edit would wait.)
    expect(errors).toEqual([]);
  });
});

// FIX-PGF (item 2d, AD-FIX-PGF-08), P27 (R-248): Add shape on a picture in the middle of a sentence (no Convert buttons any more). Word
// keeps such a picture in line; a pagemd annotated image is a block, so the sentence is split around it ("Top and bottom" wrapping) and
// the picture converted with its first shape, as ONE edit.
test.describe('Add shape on a picture inside a sentence (P27)', () => {
  test('Add marker splits the paragraph around it: one edit; the canvas shows text, the annotated image, text', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openInPrintLayout(page, PATH, 'Before the ![Inline](wide.png) and after.\n', fixtures);
    await expect(img(page, 'img[alt="Inline"]')).toHaveJSProperty('complete', true);
    await select(page, 'img[alt="Inline"]', 'image');
    await expect(button(page, 'annotated-image.add-marker')).toHaveAttribute('aria-disabled', 'false');
    await expect(button(page, 'figure.convert')).toHaveCount(0);
    const before = (await edits(page)).length;
    await button(page, 'annotated-image.add-marker').click();
    await expect.poll(async () => (await edits(page)).length).toBe(before + 1);
    await quiet(page);
    expect((await edits(page)).length).toBe(before + 1); // one edit
    const written = JSON.stringify((await edits(page)).at(-1)!.params);
    expect(written).toContain('Before the\\n\\n::: annotated-image wide.png\\noptions:\\n  alt: \\"Inline\\"\\nmarkers:\\n  - { id: 1, x: 50, y: 50, label: \\"Marker 1\\" }\\n:::\\n\\nand after.');
    await expect(img(page, '.ProseMirror > p')).toHaveText(['Before the', 'and after.']);
    await expect(img(page, '.pmd-annotated-image')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});
