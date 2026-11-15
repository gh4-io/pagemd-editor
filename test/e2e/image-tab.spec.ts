// P20 in a real browser (Chromium) with a pretend host: the Image tab. Selecting a picture (a plain image, an embed, a figure
// (also by its caption, AD-P20-03), an annotated image) puts the tab in the strip and brings it forward; clicking into text
// takes it out and the earlier tab comes back; a tab picked by hand is kept; a picture in a table cell gives Image, the cell's
// text Table (AD-P20-02); the keyboard reaches it (arrow onto the picture, Shift+F6, Tab, Enter; Esc keeps the picture
// selected); the focus never falls to the page when the tab goes; Print, Web, Draft and Split show it, Read, Code and Print
// Preview never; Size, Caption and Details work; P27 (R-252): Shapes and Edit picture are buttons at 1280 px, and a narrow window
// folds Details, Caption, Size, Shapes, then Edit picture.
// Run: npm run test:e2e (builds first).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { frames, quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const DOC = [
  '# Pictures', '', 'First para.', '',
  '![Plain](wide.png)', '',
  '![[wide.png|Embedded]]', '',
  '<!-- ::FIGURE src="wide.png" caption="Figure shot" -->', '',
  '::: annotated-image wide.png', 'markers:', '  - { id: 1, x: 25, y: 50, label: "Left" }', ':::', '',
  '| ![In cell](wide.png) | head two |', '|---|---|', '| text cell | b |', '',
  'End.', '',
].join('\n');


async function open(page: Page, mode = 'print') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await expect.poll(async () => (await sent(page)).some((m) => m.kind === 'event' && m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: DOC, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: '' },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (mode !== 'print') await setView(page, mode);
  await expect(page.locator('.pmd-canvas img').first()).toHaveJSProperty('complete', true);
  return errors;
}

const setView = (page: Page, mode: string) => fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
const ribbon = (page: Page) => page.locator('.pmd-ribbon');
const tab = (page: Page, name: string) => ribbon(page).getByRole('tab', { name, exact: true });
const strip = (page: Page) => ribbon(page).getByRole('tab').allTextContents();
const selectedTab = (page: Page) => ribbon(page).locator('.pmd-ribbon-tab[aria-selected="true"]').textContent();
const button = (page: Page, command: string) => ribbon(page).locator(`[data-command="${command}"]`);
const said = (page: Page) => page.evaluate(() => document.querySelector('.pmd-announcer')?.textContent ?? '');
const selectedNode = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { node?: { type: { name: string } } } } } } } }).__pmd.canvas.view.state.selection.node?.type.name ?? null);

const PICTURES = {
  image: (page: Page) => page.locator('.pmd-canvas img[alt="Plain"]'),
  embed: (page: Page) => page.locator('.pmd-canvas img.embedded-image'),
  figure: (page: Page) => page.locator('.pmd-canvas .pmd-figure img').first(),
  annotated: (page: Page) => page.locator('.pmd-canvas .pmd-annotated-image img').first(),
  cell: (page: Page) => page.locator('.pmd-canvas img[alt="In cell"]'),
} as const;
const NODE = { image: 'image', embed: 'pmd_embed', figure: 'pmd_figure', annotated: 'pmd_annotated_image', cell: 'image' } as const;

/** Clicks a picture near its top-left corner (off any shape) and waits until ProseMirror has it selected. */
async function pick(page: Page, which: keyof typeof PICTURES) {
  await PICTURES[which](page).click({ position: { x: 4, y: 4 } });
  await expect.poll(() => selectedNode(page)).toBe(NODE[which]);
}

/** Clicks into a block of text (the cursor, not a selected picture). */
async function textClick(locator: Locator, page: Page) {
  await locator.click();
  await expect.poll(() => selectedNode(page)).toBeNull();
}
const firstPara = (page: Page) => page.locator('.pmd-canvas p', { hasText: 'First para.' });

test.describe('the Image tab follows the selected picture', () => {
  test('each kind of picture brings it forward; clicking into text removes it (not merely greyed out) and the earlier tab returns', async ({ page }) => {
    const errors = await open(page);
    expect(await strip(page)).not.toContain('Image');
    await tab(page, 'Insert').click();
    // The negative in the same test: a click into text shows no Image tab.
    await textClick(firstPara(page), page);
    expect(await strip(page)).not.toContain('Image');
    for (const which of ['image', 'embed', 'figure', 'annotated'] as const) {
      await pick(page, which);
      await expect(tab(page, 'Image'), which).toHaveAttribute('aria-selected', 'true');
      expect(await strip(page)).toEqual(['Home', 'Insert', 'Table', 'Image', 'Layout', 'Document', 'Review', 'View']);
      await textClick(firstPara(page), page);
      await expect(tab(page, 'Image'), which).toHaveCount(0);
      expect(await selectedTab(page), which).toBe('Insert');
    }
    expect(errors).toEqual([]);
  });

  test("a click on a figure's caption selects the figure, so the tab shows (AD-P20-03: the caption is part of the picture)", async ({ page }) => {
    await open(page);
    await page.locator('.pmd-canvas .pmd-figure figcaption').first().click();
    await expect.poll(() => selectedNode(page)).toBe('pmd_figure');
    await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
  });

  test('a tab picked by hand is kept while the picture stays selected and after it is unselected (the Image tab then goes)', async ({ page }) => {
    await open(page);
    await pick(page, 'figure');
    await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'Layout').click();
    await pick(page, 'figure');
    expect(await selectedTab(page)).toBe('Layout');
    expect(await strip(page)).toContain('Image');
    await textClick(firstPara(page), page);
    await expect(tab(page, 'Image')).toHaveCount(0);
    expect(await selectedTab(page)).toBe('Layout');
  });

  test('a picture in a table cell: Image wins while it is selected, Table on the cell text, and leaving the table gives the tab from before', async ({ page }) => {
    await open(page);
    expect(await selectedTab(page)).toBe('Home');
    await textClick(page.locator('.pmd-canvas td', { hasText: 'text cell' }), page);
    await expect.poll(() => selectedTab(page)).toBe('Table');
    await pick(page, 'cell');
    await expect.poll(() => selectedTab(page)).toBe('Image');
    await textClick(page.locator('.pmd-canvas td', { hasText: 'text cell' }), page);
    await expect.poll(() => selectedTab(page)).toBe('Table');
    expect(await strip(page)).not.toContain('Image');
    await textClick(firstPara(page), page);
    await expect.poll(() => selectedTab(page)).toBe('Home');
  });
});

test.describe('the keyboard reaches it (AD-P20-04)', () => {
  test('an arrow key onto a figure selects it; Shift+F6 lands on the Image tab; Tab and arrows to Rotate right; Enter turns it (one edit, P27); Esc keeps the picture', async ({ page }) => {
    await open(page);
    // From the first paragraph, ArrowDown past the plain image and the embed onto the figure (a block picture). (ProseMirror
    // learns of a cursor move by the browser one event later: wait after each key.)
    await textClick(firstPara(page), page);
    await page.keyboard.press('End');
    for (let i = 0; i < 8 && (await selectedNode(page)) !== 'pmd_figure'; i++) {
      await page.keyboard.press('ArrowDown');
      await frames(page);
    }
    expect(await selectedNode(page)).toBe('pmd_figure');
    await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => said(page)).toContain('Image tools available on the Image tab.');
    await page.keyboard.press('Shift+F6');
    await expect(tab(page, 'Image')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(button(page, 'annotated-image.add-marker')).toBeFocused(); // P27: Shapes is the first group
    for (let i = 0; i < 16 && !(await button(page, 'image.rotate-right').evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('ArrowRight');
    await expect(button(page, 'image.rotate-right')).toBeFocused();
    await page.keyboard.press('Enter');
    // P27: the turn is a key in the markdown (rotate="90"), one edit, no file
    await expect.poll(async () => JSON.stringify((await sent(page)).filter((m) => m.method === 'applyEdits').map((m) => m.params))).toContain('rotate=\\"90\\"');
    expect((await sent(page)).filter((m) => m.method === 'writeAsset' || m.method === 'readAsset')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pmd-canvas .ProseMirror')).toBeFocused();
    expect(await selectedNode(page)).toBe('pmd_figure');
    await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
  });

  test('an arrow key onto a plain image in its own paragraph selects it as an object, so the tab shows', async ({ page }) => {
    await open(page);
    await textClick(firstPara(page), page);
    await page.keyboard.press('End');
    for (let i = 0; i < 4 && (await selectedNode(page)) !== 'image'; i++) {
      await page.keyboard.press('ArrowRight');
      await frames(page);
    }
    expect(await selectedNode(page)).toBe('image');
    await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
  });

  test('the picture deleted while the focus is on the Image tab\'s buttons: the focus goes to the restored tab, never to the page', async ({ page }) => {
    await open(page);
    // (A plain image: deleting a FIGURE would select the next picture, the annotated image, and the tab would rightly stay.)
    await pick(page, 'image');
    await page.keyboard.press('Shift+F6');
    await page.keyboard.press('Tab');
    await expect(button(page, 'annotated-image.add-marker')).toBeFocused();
    await page.evaluate(() => {
      const view = (window as unknown as { __pmd: { canvas: { view: { state: { tr: { deleteSelection(): unknown } }; dispatch(tr: unknown): void } } } }).__pmd.canvas.view;
      view.dispatch(view.state.tr.deleteSelection());
    });
    await expect(tab(page, 'Image')).toHaveCount(0);
    await expect(tab(page, 'Home')).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });
});

test.describe('the views', () => {
  for (const mode of ['print', 'web', 'draft', 'split'] as const) {
    test(`${mode}: selecting a figure shows the tab`, async ({ page }) => {
      await open(page, mode);
      expect(await strip(page)).not.toContain('Image');
      await pick(page, 'figure');
      await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
    });
  }

  test('Read, Code and Print Preview never show it, even with a picture selected on the canvas behind; back in Print Layout it is there again', async ({ page }) => {
    await open(page);
    await pick(page, 'figure');
    await expect(tab(page, 'Image')).toHaveCount(1);
    for (const mode of ['read', 'code', 'preview'] as const) {
      await setView(page, mode);
      await expect.poll(() => strip(page), mode).not.toContain('Image');
    }
    await setView(page, 'read');
    await page.locator('.pmd-canvas .pmd-figure img').first().click({ position: { x: 4, y: 4 } }); // a click in Read
    await quiet(page);
    expect(await strip(page)).toEqual(['View']);
    await setView(page, 'print');
    await pick(page, 'figure');
    await expect(tab(page, 'Image')).toHaveCount(1);
  });
});

test.describe('Size, Caption and Details', () => {
  test('Half writes width="half" in one edit; Edit caption, Alt text and Change picture focus their Inspector box', async ({ page }) => {
    await open(page);
    await pick(page, 'figure');
    const before = (await sent(page)).filter((m) => m.method === 'applyEdits').length;
    await button(page, 'picture.width-half').click();
    await expect.poll(async () => (await sent(page)).filter((m) => m.method === 'applyEdits').length).toBe(before + 1);
    const edit = (await sent(page)).filter((m) => m.method === 'applyEdits').at(-1)!;
    expect(JSON.stringify(edit.params)).toContain('<!-- ::FIGURE src=\\"wide.png\\" caption=\\"Figure shot\\" width=\\"half\\" -->');
    await quiet(page);
    expect((await sent(page)).filter((m) => m.method === 'applyEdits').length).toBe(before + 1); // one edit
    await expect(button(page, 'picture.width-half')).toHaveAttribute('aria-pressed', 'true');
    for (const [command, field] of [['picture.caption', 'caption'], ['picture.alt', 'alt'], ['picture.path', 'src']] as const) {
      await button(page, command).click();
      await expect(page.locator('.pmd-inspector')).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-field]')?.getAttribute('data-field') ?? null), command).toBe(field);
      await pick(page, 'figure'); // back to the picture (the tab stays)
    }
  });

  test('a plain image (Word-style, AD-FIX-WS-03/04): Size and Caption are on, as are Alt text and Change picture', async ({ page }) => {
    await open(page);
    await pick(page, 'image');
    for (const id of ['picture.width-half', 'picture.caption', 'picture.alt', 'picture.path']) await expect(button(page, id)).toHaveAttribute('aria-disabled', 'false');
  });
});

test.describe('the width of the ribbon (P17 fold; P27, R-252: Shapes and Edit picture are buttons unless the ribbon is too narrow)', () => {
  const FOLD_ORDER = ['Details', 'Caption', 'Size', 'Shapes', 'Edit picture'];
  const foldedGroups = (page: Page) => ribbon(page).locator('.pmd-ribbon-group', { has: page.locator('.pmd-ribbon-menu-button') }).evaluateAll((groups) => groups.map((g) => g.getAttribute('aria-label')!));

  test('1280 px: every group, Shapes (eight) and Edit picture (seven) included, is buttons; nothing is a drop-down', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    await pick(page, 'figure');
    await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
    await frames(page);
    expect(await foldedGroups(page)).toEqual([]);
    for (const id of ['annotated-image.add-highlight', 'annotated-image.renumber', 'image.crop', 'image.redact', 'image.reset']) await expect(button(page, id), id).toBeVisible();
    expect(await ribbon(page).getByRole('menuitem').count()).toBe(0);
  });

  for (const width of [600, 360]) {
    test(`${width} px: no sideways page scroll, Details, Caption, Size, Shapes fold first, every command still reachable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await open(page);
      await pick(page, 'figure');
      await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
      await frames(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const folded = await foldedGroups(page);
      expect(folded.length).toBeGreaterThan(0);
      expect(FOLD_ORDER.slice(0, folded.length).sort()).toEqual([...folded].sort());
      if (width === 360) expect(folded).toEqual(expect.arrayContaining(['Details', 'Shapes']));
      const commands = await ribbon(page).locator('.pmd-ribbon-panel [data-command]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
      expect(new Set(commands).size).toBe(25);
      // A folded group lists its commands.
      const shapes = ribbon(page).locator('.pmd-ribbon-group[aria-label="Shapes"]');
      if (await shapes.locator('.pmd-ribbon-menu-button').count()) {
        await shapes.locator('.pmd-ribbon-menu-button').click();
        await expect(shapes.getByRole('menuitem')).toHaveCount(8);
        await page.keyboard.press('Escape');
      }
    });
  }
});
