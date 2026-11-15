// P15 in a real browser (Chromium) with a pretend host (ADR-0018, R-193–R-196): shapes dragged and nudged on the canvas
// change only their own YAML line, in ONE edit each; the keyboard does everything the mouse does; Image ▸ Shapes (Insert ▸ Shapes before P20) adds a
// shape selected for editing and the Inspector's row follows. P27 (ADR-0019, R-248–R-252): Crop (Word's crop mode), Rotate, Flip, Redact and
// Reset picture write keys in the markdown in ONE edit each and never a file (the pretend host's writeAsset is never asked); Add shape converts
// any picture; redactions are opaque boxes on the canvas; shapes hidden by a crop are flagged. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
/** wide.png: 400 × 200, the left half red, the right half blue, a 10 × 10 green square in the top-left corner. */
const ANNOTATED = [
  '::: annotated-image wide.png',
  '# notes stay',
  'options: { caption: "The app" }',
  'markers:',
  '  - { id: 1, x: 25, y: 50, label: "Left" }',
  'boxes:',
  '  - { x: 60, y: 20, width: 20, height: 40, label: "Panel", id: 2 }',
  ':::',
];
const FIGURE = '<!-- ::FIGURE src="wide.png" caption="Figure shot" -->';
const DOC = ['# Shots', '', 'Intro.', '', ...ANNOTATED, '', FIGURE, '', 'End.', ''].join('\n');

type Edit = { from: number; to: number; text: string };

async function waitFor(page: Page, match: (m: Message) => boolean, nth = 0): Promise<Message> {
  let found: Message | undefined;
  await expect.poll(async () => (found = (await sent(page)).filter(match)[nth]), { timeout: 5000 }).toBeTruthy();
  return found!;
}

async function open(page: Page, options: { text?: string; mode?: string } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: options.text ?? DOC, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode: options.mode ?? 'draft' } });
  await expect(page.locator('.pmd-canvas img').first()).toHaveJSProperty('complete', true);
  return errors;
}

/** Answers every applyEdits as the host does; resolves with the text the host has once it matches. */
async function hostReaches(page: Page, expected: string | RegExp, text = DOC): Promise<{ text: string; batches: Edit[][] }> {
  let current = text;
  let answered = 0;
  const batches: Edit[][] = [];
  await expect
    .poll(
      async () => {
        const requests = (await sent(page)).filter((m) => m.method === 'applyEdits');
        for (; answered < requests.length; answered++) {
          const request = requests[answered]!;
          const edits = (request.params as { edits: Edit[] }).edits;
          batches.push(edits);
          let out = '';
          let at = 0;
          for (const e of edits) {
            out += current.slice(at, e.from) + e.text;
            at = e.to;
          }
          current = out + current.slice(at);
          await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: answered + 2 } });
        }
        return typeof expected === 'string' ? current : expected.test(current);
      },
      { timeout: 5000 },
    )
    .toBe(typeof expected === 'string' ? expected : true);
  return { text: current, batches };
}

/** The lines of `text` that differ from DOC's (same number of lines). */
function changedLines(text: string, before = DOC): string[] {
  const a = before.split('\n');
  const b = text.split('\n');
  expect(b).toHaveLength(a.length);
  return b.filter((line, i) => line !== a[i]);
}



const RED = [255, 0, 0, 255];
const BLACK = [0, 0, 0, 255];

const annotated = (page: Page) => page.locator('.pmd-canvas .pmd-annotated-image');
const overlay = (page: Page) => annotated(page).locator('.pmd-shape-overlay');
const shape = (page: Page, list: string, index: number) => overlay(page).locator(`[data-list="${list}"][data-index="${index}"]`);
const ribbonButton = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const status = (page: Page) => page.locator('.pmd-status-bar');

/** The selected node's name (ProseMirror learns of a click one event later). */
const selectedNode = (page: Page) =>
  page.evaluate(() => {
    const sel = (window as unknown as { __pmd: { canvas: { view: { state: { selection: { node?: { type: { name: string } } } } } } } }).__pmd.canvas.view.state.selection;
    return sel.node?.type.name ?? null;
  });

/** Clicks a picture (near its top-left corner, off any shape) and waits until it is the selected node. */
async function select(page: Page, which: 'annotated' | 'figure' | 'image') {
  const target = which === 'annotated' ? annotated(page).locator('img').first() : which === 'figure' ? page.locator('.pmd-canvas .pmd-figure img').first() : page.locator('.pmd-canvas p img:not(.ProseMirror-separator)').first();
  await target.click({ position: { x: 4, y: 4 } });
  await expect.poll(() => selectedNode(page)).toBe(which === 'annotated' ? 'pmd_annotated_image' : which === 'figure' ? 'pmd_figure' : 'image');
}

/** P20: the image tools are on the Image tab, which comes forward by itself once a picture is selected. */
async function imageTab(page: Page) {
  await expect(page.locator('.pmd-ribbon').getByRole('tab', { name: 'Image', exact: true })).toHaveAttribute('aria-selected', 'true');
}

test.describe('shapes on the canvas (D3, D11, D12, D26)', () => {
  test('a double-click starts editing; dragging a marker changes only its line, in ONE edit, the comment and style kept', async ({ page }) => {
    const errors = await open(page);
    await expect(overlay(page)).toBeHidden();
    await annotated(page).locator('img').dblclick({ position: { x: 4, y: 4 } });
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toBeFocused();
    await expect(overlay(page)).toHaveAttribute('role', 'application');
    const box = (await overlay(page).boundingBox())!;
    const marker = (await shape(page, 'markers', 0).boundingBox())!;
    const start = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + box.width * 0.1, start.y, { steps: 5 });
    await page.mouse.up();
    const { text, batches } = await hostReaches(page, /x: 35, y: 50, label: "Left"/);
    expect(changedLines(text)).toEqual(['  - { id: 1, x: 35, y: 50, label: "Left" }']);
    expect(batches).toHaveLength(1);
    await expect(shape(page, 'markers', 0)).toHaveAttribute('aria-pressed', 'true');
    // still editing after the change; Escape ends it and gives the canvas the focus back
    await expect(overlay(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('.pmd-canvas .ProseMirror')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('a box corner dragged resizes it with the opposite corner fixed; nothing is sent while dragging', async ({ page }) => {
    await open(page);
    await annotated(page).locator('img').dblclick({ position: { x: 4, y: 4 } });
    const box = (await overlay(page).boundingBox())!;
    // the box's edge (it has no fill: its outline is what takes the pointer)
    await page.mouse.click(box.x + box.width * 0.6 + 1, box.y + box.height * 0.4);
    await expect(shape(page, 'boxes', 0)).toHaveAttribute('aria-pressed', 'true');
    const handles = overlay(page).locator('.pmd-shape-handle');
    await expect(handles).toHaveCount(4);
    await expect(handles.nth(3)).toHaveAttribute('aria-label', 'Bottom-right corner of Box 2 (Panel)');
    const corner = (await handles.nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.8, { steps: 6 });
    await quiet(page); // longer than the typing pause: a drag in progress is not sent
    expect((await sent(page)).filter((m) => m.method === 'applyEdits')).toHaveLength(0);
    await page.mouse.up();
    const { text, batches } = await hostReaches(page, /width: 30, height: 60/);
    expect(changedLines(text)).toEqual(['  - { x: 60, y: 20, width: 30, height: 60, label: "Panel", id: 2 }']);
    expect(batches).toHaveLength(1);
  });

  test('keyboard only: Enter starts editing, Tab selects, held arrow keys nudge as ONE edit, Delete removes, Esc ends', async ({ page }) => {
    await open(page);
    await select(page, 'annotated');
    await page.keyboard.press('Enter');
    await expect(overlay(page)).toBeFocused();
    await expect(shape(page, 'markers', 0)).toHaveAttribute('aria-pressed', 'true');
    await expect(annotated(page).locator('.pmd-shape-status')).toHaveText('Marker 1 (Left) selected');
    await page.keyboard.press('Tab');
    await expect(shape(page, 'boxes', 0)).toHaveAttribute('aria-pressed', 'true');
    // Shift + a held ArrowDown (repeats) is one change when the key is let go
    const box = (await overlay(page).boundingBox())!;
    await page.keyboard.down('Shift');
    await page.keyboard.down('ArrowDown');
    await page.keyboard.down('ArrowDown');
    await page.keyboard.up('ArrowDown');
    await page.keyboard.up('Shift');
    const moved = Math.round((20 + (20 / box.height) * 100) * 100) / 100;
    const first = await hostReaches(page, new RegExp(`x: 60, y: ${String(moved).replace('.', '\\.')}, width: 20`));
    expect(first.batches).toHaveLength(1);
    await page.keyboard.press('Delete');
    const second = await hostReaches(page, /boxes:\n:::|^(?![\s\S]*Panel)/, first.text);
    expect(second.text).not.toContain('Panel');
    expect(second.text).toContain('  - { id: 1, x: 25, y: 50, label: "Left" }');
    expect(second.text).toContain('# notes stay');
    await expect(shape(page, 'markers', 0)).toHaveAttribute('aria-pressed', 'true'); // the selection moved on
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toBeHidden();
    expect(await selectedNode(page)).toBe('pmd_annotated_image');
  });

  test('in Read nothing can be edited: a double-click starts no shape editing', async ({ page }) => {
    await open(page, { mode: 'read' });
    // Read's own window lies over the page and takes the pointer: double-click where the picture is
    const img = (await annotated(page).locator('img').boundingBox())!;
    await page.mouse.dblclick(img.x + 4, img.y + 4);
    await quiet(page);
    await expect(overlay(page)).toBeHidden();
  });
});

test.describe('Image ▸ Shapes and the Inspector (D4, D6 in step, D7; P20: on the Image tab)', () => {
  test('Add arrow: a new arrow, selected for editing; its Inspector row is marked; focusing another row selects that shape', async ({ page }) => {
    await open(page);
    await select(page, 'annotated');
    await imageTab(page);
    await ribbonButton(page, 'annotated-image.add-arrow').click(); // P27 (R-252): Shapes are buttons
    await page.locator('.pmd-draw-catcher').click(); // FIX-S50 (OQ-63): draw mode; a click places the usual arrow around the point
    const { text } = await hostReaches(page, /arrows:\n {2}- \{ x1: [\d.]+, y1: [\d.]+, x2: [\d.]+, y2: [\d.]+ \}/);
    expect(text).toContain('  - { id: 1, x: 25, y: 50, label: "Left" }');
    await expect(overlay(page)).toBeVisible();
    await expect(shape(page, 'arrows', 0)).toHaveAttribute('aria-pressed', 'true');
    await expect(overlay(page).locator('.pmd-shape-handle')).toHaveCount(2);
    await page.evaluate(() => (window as unknown as { __pmd: { inspector: { show(tab: string): void } } }).__pmd.inspector.show('element'));
    await expect(page.locator('.pmd-inspector [data-row="arrows.0"]')).toHaveClass(/pmd-insp-row-marked/);
    await page.locator('.pmd-inspector [data-row="markers.0"] input').first().focus();
    await expect(shape(page, 'markers', 0)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pmd-inspector [data-row="markers.0"]')).toHaveClass(/pmd-insp-row-marked/);
    await expect(page.locator('.pmd-inspector [data-row="markers.0"] input').first()).toBeFocused(); // the Inspector keeps the focus
  });

  test('Renumber markers is greyed out when they are in order; Add marker on a lone plain image makes it an annotated image', async ({ page }) => {
    const text = '# T\n\n![Shot](wide.png)\n\nEnd.\n';
    await open(page, { text });
    await select(page, 'image');
    await imageTab(page);
    await expect(ribbonButton(page, 'annotated-image.renumber')).toHaveAttribute('aria-disabled', 'true');
    await ribbonButton(page, 'annotated-image.add-marker').click();
    const done = await hostReaches(page, /::: annotated-image wide\.png\noptions:\n {2}alt: "Shot"\nmarkers:\n {2}- \{ id: 1, x: 50, y: 50, label: "Marker 1" \}\n:::/, text);
    expect(done.batches).toHaveLength(1);
  });
});

/** No file was written and no picture read by the image tools (R-249: keys only; the stand-in host's writeAsset is never asked). */
async function noFiles(page: Page) {
  expect((await sent(page)).filter((m) => m.method === 'writeAsset' || m.method === 'readAsset')).toEqual([]);
}

/** The color of the screen pixel at (x, y) (page coordinates). */
async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  const png = (await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } })).toString('base64');
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }, png);
}

const cropLayer = (page: Page) => page.locator('.pmd-crop-mode');
const figureImg = (page: Page) => page.locator('.pmd-canvas .pmd-figure img').first();

/** Drags from the centre of `from` by (dx, dy) screen px. */
async function dragBy(page: Page, from: { x: number; y: number; width: number; height: number }, dx: number, dy: number) {
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

test.describe('P27 crop mode (Word\'s crop; R-249: keys in %, never pixels; amendment 2)', () => {
  test('handles crop, Enter keeps: crop-x in ONE edit; again, dragging the picture shifts it under the window: pos-x', async ({ page }) => {
    const errors = await open(page);
    await select(page, 'figure');
    await imageTab(page);
    const shown = (await figureImg(page).boundingBox())!;
    await ribbonButton(page, 'image.crop').click();
    await expect(cropLayer(page)).toBeVisible();
    await expect(cropLayer(page)).toBeFocused();
    await expect(cropLayer(page).locator('.pmd-crop-handle')).toHaveCount(8);
    await dragBy(page, (await cropLayer(page).locator('.pmd-crop-e').boundingBox())!, -shown.width / 2, 0);
    await page.keyboard.press('Enter');
    await expect(cropLayer(page)).toHaveCount(0);
    const first = await hostReaches(page, /crop-x/);
    expect(changedLines(first.text)).toEqual(['<!-- ::FIGURE src="wide.png" caption="Figure shot" crop-x="50" -->']);
    expect(first.batches).toHaveLength(1);
    // crop mode on the cropped figure shows the whole picture; the picture dragged left by a quarter of it
    await select(page, 'figure');
    await ribbonButton(page, 'image.crop').click();
    const full = (await cropLayer(page).locator('> .pmd-crop-full').boundingBox())!;
    expect(Math.round(full.width)).toBe(Math.round(shown.width)); // the whole picture, not the cropped half
    await dragBy(page, (await cropLayer(page).locator('.pmd-crop-window').boundingBox())!, -full.width / 4, 0);
    await page.keyboard.press('Enter');
    const second = await hostReaches(page, /pos-x/); // (it replays every edit from the start)
    expect(changedLines(second.text)).toEqual(['<!-- ::FIGURE src="wide.png" caption="Figure shot" crop-x="50" pos-x="-25%" -->']);
    await noFiles(page);
    expect(errors).toEqual([]);
  });

  test('Escape cancels (nothing sent); a click away keeps (as in Word); the keyboard crops too (Alt + arrows)', async ({ page }) => {
    await open(page);
    await select(page, 'figure');
    await imageTab(page);
    const shown = (await figureImg(page).boundingBox())!;
    await ribbonButton(page, 'image.crop').click();
    await dragBy(page, (await cropLayer(page).locator('.pmd-crop-s').boundingBox())!, 0, -shown.height / 2);
    await page.keyboard.press('Escape');
    await expect(cropLayer(page)).toHaveCount(0);
    await quiet(page);
    expect((await sent(page)).filter((m) => m.method === 'applyEdits')).toHaveLength(0);
    // a click away keeps
    await select(page, 'figure');
    await ribbonButton(page, 'image.crop').click();
    await dragBy(page, (await cropLayer(page).locator('.pmd-crop-s').boundingBox())!, 0, -shown.height / 2);
    await page.locator('.pmd-canvas p', { hasText: 'Intro.' }).click();
    const kept = await hostReaches(page, /crop-y/);
    expect(changedLines(kept.text)).toEqual(['<!-- ::FIGURE src="wide.png" caption="Figure shot" crop-y="50" -->']);
    // keyboard only: Shift + Alt + ArrowLeft moves the right edge by 10 px a press
    await select(page, 'figure');
    await page.keyboard.press('Shift+F6');
    await page.keyboard.press('Tab');
    for (let i = 0; i < 16 && !(await ribbonButton(page, 'image.crop').evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(cropLayer(page)).toBeFocused();
    for (let i = 0; i < Math.round(shown.width / 20); i++) await page.keyboard.press('Shift+Alt+ArrowLeft');
    await expect(cropLayer(page).locator('[role="status"]')).toContainText('Showing');
    await page.keyboard.press('Enter');
    const keyboard = await hostReaches(page, /crop-x="\d/);
    expect(changedLines(keyboard.text)[0]).toMatch(/^<!-- ::FIGURE src="wide.png" caption="Figure shot" crop-x="(4[5-9]|5[0-5])(\.\d+)?" crop-y="50" -->$/);
    await noFiles(page);
  });
});

test.describe('P27 Rotate, Flip, Redact, Reset picture: keys, one edit each, no file (R-249, R-251)', () => {
  test('Rotate right on an annotated image: rotate, every shape moved, in ONE edit', async ({ page }) => {
    await open(page);
    await select(page, 'annotated');
    await imageTab(page);
    await ribbonButton(page, 'image.rotate-right').click();
    const { text, batches } = await hostReaches(page, /rotate: 90/);
    expect(changedLines(text)).toEqual(['options: { caption: "The app", rotate: 90 }', '  - { id: 1, x: 50, y: 25, label: "Left" }', '  - { x: 40, y: 60, width: 40, height: 20, label: "Panel", id: 2 }']);
    expect(batches).toHaveLength(1);
    await noFiles(page);
  });

  test('Flip on a plain picture in a sentence: its own picture line with a FIGURE flip="h" comment under it (R-253), one edit', async ({ page }) => {
    const text = '# T\n\nSee ![x](wide.png) here.\n';
    await open(page, { text });
    await select(page, 'image');
    await imageTab(page);
    await ribbonButton(page, 'image.flip-horizontal').click();
    const done = await hostReaches(page, '# T\n\nSee\n\n![x](wide.png)\n<!-- ::FIGURE flip="h" -->\n\nhere.\n', text);
    expect(done.batches).toHaveLength(1);
    await expect(page.locator('.pmd-canvas .pmd-figure img').first()).toHaveAttribute('style', /scaleX\(-1\)/);
    await noFiles(page);
  });

  test('Redact: the note first (and in the tooltip); an opaque black box over the picture on the canvas; a second one without the note', async ({ page }) => {
    await open(page);
    await select(page, 'annotated');
    await imageTab(page);
    await expect(ribbonButton(page, 'image.redact')).toHaveAttribute('title', /It is not removed from your picture file, git history, pagemd archive, or markdown viewers such as GitHub/);
    await ribbonButton(page, 'image.redact').click();
    const dialog = page.getByRole('dialog', { name: 'Redact' });
    await expect(dialog).toContainText('Covered on the page and in Print Preview, and blacked out in exported HTML, PDF and pictures: pagemd bakes a covered copy when it builds.');
    await dialog.getByRole('button', { name: 'Redact' }).click();
    await page.locator('.pmd-draw-catcher').click(); // FIX-S50: the box is drawn (a click: the usual size around the point)
    const first = await hostReaches(page, /redact:/);
    expect(first.text).toMatch(/redact:\n {2}- \{ x: [\d.]+, y: [\d.]+, width: 30, height: 10 \}\n:::/);
    expect(first.batches).toHaveLength(1);
    // the canvas: the box is drawn, opaque black, over the red/blue picture; never the "not prepared" placeholder
    const box = annotated(page).locator('rect.annotation-redact');
    await expect(box).toHaveCount(1);
    await expect(annotated(page)).not.toContainText('Redacted picture not prepared');
    await page.keyboard.press('Escape'); // the redaction is selected for editing: leave the overlay
    const r = (await box.boundingBox())!;
    expect(await pixelAt(page, r.x + r.width / 2, r.y + r.height / 2)).toEqual(BLACK);
    const pic = (await annotated(page).locator('img').boundingBox())!;
    expect(await pixelAt(page, pic.x + pic.width * 0.1, pic.y + pic.height * 0.1)).toEqual(RED); // the rest of the picture shows
    // a second redaction: no note again
    await select(page, 'annotated');
    await ribbonButton(page, 'image.redact').click();
    await page.locator('.pmd-draw-catcher').click();
    await hostReaches(page, /height: 10 \}\n {2}- \{ x: [\d.]+/);
    await expect(dialog).toHaveCount(0);
    await noFiles(page);
  });

  test('Reset picture: after a turn, a crop and a redaction, one edit puts the YAML back exactly', async ({ page }) => {
    const text = '# T\n\n::: annotated-image wide.png\noptions: { caption: "C" }\nmarkers:\n  - { id: 1, x: 12.5, y: 30, label: "A" }\n:::\n';
    const edited = '# T\n\n::: annotated-image wide.png\noptions: { caption: "C", crop-x: 50, rotate: 90, flip: "v" }\nmarkers:\n  - { id: 1, x: 70, y: 87.5, label: "A" }\nredact:\n  - { x: 1, y: 2, width: 3, height: 4 }\n:::\n';
    await open(page, { text: edited });
    await select(page, 'annotated');
    await imageTab(page);
    await expect(ribbonButton(page, 'image.reset')).toHaveAttribute('aria-disabled', 'false');
    await ribbonButton(page, 'image.reset').click();
    const done = await hostReaches(page, /^(?![\s\S]*rotate)/, edited);
    expect(done.batches).toHaveLength(1);
    // rotate 90 then flip v put (12.5, 30) at (70, 87.5); Reset undoes the flip, then the turn: the shapes exactly as before. (pagemd-common's
    // YAML writer leaves an empty line where the last list, `redact:`, was removed; it reads back the same: AD-P15-12, AD-P27-12)
    expect(done.text.replace(/\n\n:::\n$/, '\n:::\n')).toBe(text);
    await expect(ribbonButton(page, 'image.reset')).toHaveAttribute('aria-disabled', 'true');
    await noFiles(page);
  });

  test('shapes hidden by a crop: the canvas says how many, the Inspector marks their rows', async ({ page }) => {
    const text = '# T\n\n::: annotated-image wide.png\noptions: { crop-x: 50 }\nmarkers:\n  - { id: 1, x: 10, y: 10, label: "In" }\n  - { id: 2, x: 80, y: 10, label: "Out" }\nboxes:\n  - { x: 70, y: 60, width: 10, height: 10 }\n:::\n';
    await open(page, { text });
    await expect(annotated(page).locator('.pmd-hidden-shapes')).toHaveText('2 shapes hidden by the crop');
    await select(page, 'annotated');
    await page.evaluate(() => (window as unknown as { __pmd: { inspector: { show(tab: string): void } } }).__pmd.inspector.show('element'));
    await expect(page.locator('.pmd-inspector .pmd-insp-row-flagged')).toHaveCount(2);
    await expect(page.locator('.pmd-inspector [data-row="markers.1"]')).toContainText('Hidden by the crop');
    await expect(page.locator('.pmd-inspector [data-row="markers.0"]')).not.toHaveClass(/pmd-insp-row-flagged/);
  });
});

test.describe('P27 Add shape converts automatically (R-248, amendment 1); no Convert anywhere', () => {
  test('a cropped FIGURE: Add box makes it an annotated image that keeps its crop, in ONE edit', async ({ page }) => {
    const text = '# T\n\n<!-- ::FIGURE src="wide.png" caption="C" crop-x="50" pos-x="-25%" -->\n\nEnd.\n';
    await open(page, { text });
    await select(page, 'figure');
    await imageTab(page);
    await ribbonButton(page, 'annotated-image.add-box').click();
    await page.locator('.pmd-draw-catcher').click();
    const done = await hostReaches(page, /annotated-image/, text);
    expect(done.text).toMatch(/^# T\n\n::: annotated-image wide\.png\noptions:\n {2}caption: "C"\n {2}crop-x: 50\n {2}pos-x: -25\nboxes:\n {2}- \{ x: [\d.]+, y: [\d.]+, width: 20, height: 20 \}\n:::\n\nEnd\.\n$/);
    expect(done.batches).toHaveLength(1);
    await noFiles(page);
  });

  test('the Convert buttons are gone from the ribbon and the slash menu', async ({ page }) => {
    await open(page);
    await select(page, 'figure');
    await imageTab(page);
    await expect(page.locator('.pmd-ribbon [data-command$=".convert"]')).toHaveCount(0);
    await expect(page.locator('.pmd-ribbon').getByText(/^Convert|To figure|To annotated/)).toHaveCount(0);
    await page.locator('.pmd-canvas p', { hasText: 'End.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/convert');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
  });
});
