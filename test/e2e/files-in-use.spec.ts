// P25 acceptance in a real browser (Chromium) with a pretend host and the styles and Files in Use report style-pagemd makes from the real
// files (test/e2e/fixtures/files-in-use/: `docs/report.md` uses `report-child`, which extends `report-base`, which extends pagemd's
// `standard_letter`; `report.css` next to the profiles, `report-layout.css` in the project's styles/, the document's `styles:` file
// `extra.css` next to it; `.pagemdrc` makes the folder the project folder):
// - Document ▸ Files in Use (the `link` icon) opens the panel; it lists every file in priority order and says why each was chosen;
// - a row's Open and Reveal, and a rule's place, send `openFile` (the host opens it); nothing is ever written (no applyEdits);
// - `stylesChanged` makes the panel read the files again (another profile);
// - "where did this come from" for a heading names the rule CSS picks (the file, the line), matching what the browser draws;
// - keyboard (F6, arrows, Enter, Shift+Enter) and a narrow window. Run: npm run test:e2e (builds first).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import type { FilesInUse } from '@pagemd-editor/core';
import { answerFilesInUse, filesReportFor, openInPrintLayout, stylesFor } from './pagination-harness.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/files-in-use/', import.meta.url)).replace(/\/$/, '');
const DOC_PATH = `${FIXTURE}/docs/report.md`;
const DOC = readFileSync(DOC_PATH, 'utf8');

const panel = (page: Page) => page.locator('aside.pmd-files');
const ribbonButton = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const documentTab = (page: Page) => page.locator('.pmd-ribbon').getByRole('tab', { name: 'Document', exact: true }).click();
const openFiles = (page: Page) => page.evaluate(async () => (await (window as unknown as { __toHost: Message[] }).__toHost).filter((m) => m.kind === 'event' && m.name === 'openFile').map((m) => m.data));

let report: FilesInUse;

async function open(page: Page, width = 1400): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await openInPrintLayout(page, DOC_PATH, DOC, pathToFileURL(`${FIXTURE}/docs/`).href);
  report ??= await filesReportFor(DOC_PATH, DOC);
  return errors;
}

/** Opens the panel with the Document tab's button and answers the report. */
async function showPanel(page: Page): Promise<void> {
  await documentTab(page);
  await ribbonButton(page, 'document.files-in-use').click();
  await answerFilesInUse(page, report);
  await expect(panel(page).locator('.pmd-files-row').first()).toBeVisible();
}

const rowNames = (page: Page) => panel(page).locator('.pmd-files-row .pmd-files-name').allTextContents();

test.describe('the button and the list', () => {
  test('Document ▸ Files in Use (the chain-link icon) opens and closes the panel; every file in priority order', async ({ page }) => {
    const errors = await open(page);
    await documentTab(page);
    const button = ribbonButton(page, 'document.files-in-use');
    await expect(button).toBeVisible();
    await expect(button.locator('.codicon-link')).toHaveCount(1);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(panel(page)).toBeHidden();
    await button.click();
    await answerFilesInUse(page, report);
    await expect(panel(page)).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await rowNames(page)).toEqual([
      'report.md',
      'report-child.json',
      'report-base.json',
      'standard_letter.json',
      'standard_letter.html',
      'extra.css', // the document's styles: (highest)
      'report.css', // the profile's CSS
      'shiki-base.css',
      'report-layout.css',
      'primary.css',
      'base.css', // pagemd's base (lowest)
    ]);
    // the stylesheets are numbered from 1 (wins) down, and say why they were chosen
    await expect(panel(page).locator('.pmd-files-row[data-role="stylesheet"] .pmd-files-label').first()).toHaveText("1. The document's styles: file");
    const why = (name: string) => panel(page).locator('.pmd-files-row', { has: page.locator('.pmd-files-name', { hasText: name }) }).locator('.pmd-files-why');
    await expect(why('report-child.json')).toContainText('the project folder (workspace root) (search step 3 of 6');
    await expect(why('report-base.json')).toContainText('The profile "report-child" extends it.');
    await expect(why('report.css')).toContainText('Named by the profile "report-child". Found by its name "report.css" in the profile\'s folder (search step 2 of 5');
    await expect(why('report-layout.css')).toContainText('Named by the profile "report-base".');
    await expect(why('extra.css')).toContainText("Listed in this document's styles:. Found by its name \"extra.css\" in the document's folder (search step 1 of 5");
    await expect(panel(page).locator('.pmd-files-row', { has: page.locator('.pmd-files-name', { hasText: 'base.css' }) }).last().locator('.pmd-files-bundled')).toContainText("pagemd's own file");
    // closing: the button, then the panel's own close button
    await button.click();
    await expect(panel(page)).toBeHidden();
    await button.click();
    await answerFilesInUse(page, report, 1); // opened again: read again
    await panel(page).getByRole('button', { name: 'Close Files in Use' }).click();
    await expect(panel(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Open, Reveal and a duplicate name: openFile events with the row\'s path; nothing is written', async ({ page }) => {
    await open(page);
    await showPanel(page);
    await panel(page).getByRole('button', { name: /^Open report\.css / }).click();
    await panel(page).getByRole('button', { name: 'Reveal report.css in the Explorer' }).click();
    expect(await openFiles(page)).toEqual([{ path: `${FIXTURE}/profiles/report.css` }, { path: `${FIXTURE}/profiles/report.css`, reveal: true }]);
    // the generated or missing rows have no Open (not a file)
    expect((await sent(page)).filter((m) => m.method === 'applyEdits')).toEqual([]);
  });

  test('problems: a missing styles: file is listed with its message, the rest of the trace stays', async ({ page }) => {
    await open(page);
    const broken = DOC.replace('styles: [extra.css]', 'styles: [extra.css, nope.css]');
    const brokenReport = await filesReportFor(DOC_PATH, broken);
    await documentTab(page);
    await ribbonButton(page, 'document.files-in-use').click();
    await answerFilesInUse(page, brokenReport);
    await expect(panel(page).locator('.pmd-files-problems')).toContainText('Resource not found: nope.css');
    await expect(panel(page).locator('.pmd-files-row[data-problem="true"] .pmd-files-name')).toHaveText('nope.css');
    await expect(panel(page).locator('.pmd-files-status')).toContainText('plain styles');
    expect(await rowNames(page)).toContain('report-child.json');
  });

  test('stylesChanged (the frontmatter names another profile): the panel reads the files again and shows the new chain', async ({ page }) => {
    await open(page);
    await showPanel(page);
    const sop = DOC.replace('profile: report-child', 'profile: sop');
    await fromHost(page, { kind: 'event', name: 'stylesChanged', data: await stylesFor(DOC_PATH, sop) });
    await answerFilesInUse(page, await filesReportFor(DOC_PATH, sop), 1);
    await expect(panel(page).locator('.pmd-files-row[data-role="profile"] .pmd-files-name')).toHaveText(['sop.json', 'standard_letter.json']);
  });
});

test.describe('where did this come from', () => {
  test('a heading: each property names the rule CSS picks, with the value the page shows; a click opens that line', async ({ page }) => {
    const errors = await open(page);
    await showPanel(page);
    await page.locator('.pmd-canvas .ProseMirror h2').click();
    const where = panel(page).locator('.pmd-files-where');
    await expect(where.locator('.pmd-files-chip').first()).toHaveText('Heading 2 (h2)');
    const source = (property: string) => where.locator(`dd[data-property="${property}"]`);
    const shown = (property: string) => where.locator(`dt[data-property="${property}"] .pmd-files-value`);
    // color: the document's styles: file (a higher layer) beats the profile's rule of the same strength
    await expect(source('color').locator('.pmd-files-rule').first()).toContainText('extra.css:1 h2 color: rgb(0, 128, 0)');
    await expect(shown('color')).toHaveText('rgb(0, 128, 0)');
    await expect(source('color').locator('.pmd-files-beaten summary')).toContainText('lost');
    await source('color').locator('.pmd-files-beaten summary').click();
    await expect(source('color').locator('.pmd-files-beaten .pmd-files-rule').first()).toContainText('report.css:2 h2 color: rgb(200, 0, 0)');
    // alignment and space after: the profile's own rule
    await expect(source('text-align').locator('.pmd-files-rule').first()).toContainText('report.css:2');
    await expect(shown('text-align')).toHaveText('center');
    await expect(source('margin-bottom').locator('.pmd-files-rule').first()).toContainText('report.css:2');
    await expect(shown('margin-bottom')).toHaveText('21px');
    // the font: inherited from an element around the heading (no rule on the heading sets it), or pagemd's base
    await expect(source('font-family')).toHaveAttribute('data-source', /inherited|rule/);
    // every value named from a rule written in px or rgb() is the value the browser draws
    const checks = await where.evaluate((el) =>
      [...el.querySelectorAll('dd[data-source="rule"]')].map((dd) => {
        const property = (dd as HTMLElement).dataset['property']!;
        const decl = dd.querySelector('.pmd-files-rule-decl')?.textContent ?? '';
        return { property, written: decl.slice(decl.indexOf(':') + 1).trim(), shown: el.querySelector(`dt[data-property="${property}"] .pmd-files-value`)?.textContent ?? '' };
      }),
    );
    for (const c of checks.filter((c) => /^(-?\d+(\.\d+)?px|rgb\([^)]*\)|center|left|right|justify|bold|normal|italic)$/.test(c.written))) expect(c.shown, c.property).toBe(c.written);
    // a click on the rule opens its file at the line
    await source('text-align').locator('.pmd-files-rule').first().click();
    expect((await openFiles(page)).at(-1)).toEqual({ path: `${FIXTURE}/profiles/report.css`, line: 2 });
    // another block: the first paragraph's first-line indent from report.css line 3
    await page.locator('.pmd-canvas .ProseMirror p', { hasText: 'Opening paragraph' }).click();
    await expect(where.locator('.pmd-files-chip').first()).toHaveText('Paragraph (p)');
    await expect(source('text-indent').locator('.pmd-files-rule').first()).toContainText('report.css:3 p text-indent: 12px');
    await expect(shown('text-indent')).toHaveText('12px');
    expect((await sent(page)).filter((m) => m.method === 'applyEdits')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a table cell: the blocks around the cursor can be looked at one by one', async ({ page }) => {
    await open(page);
    await showPanel(page);
    await page.locator('.pmd-canvas td').first().click();
    const chips = panel(page).locator('.pmd-files-where .pmd-files-chip');
    await expect(chips.first()).toHaveText(/\(p\)|\(td\)/);
    const labels = await chips.allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['Cell (td)', 'Table (table)']));
    await chips.filter({ hasText: 'Table (table)' }).click();
    await expect(chips.filter({ hasText: 'Table (table)' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('Draft, Code and Print Preview say why it is off; the list stays', async ({ page }) => {
    await open(page);
    await showPanel(page);
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
    await expect(panel(page).locator('.pmd-files-where-note')).toContainText("Draft shows the text in VS Code's colors");
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'code' } });
    await expect(panel(page).locator('.pmd-files-where-note')).toContainText('Shown where the page is');
    await expect(panel(page).locator('.pmd-files-row').first()).toBeVisible();
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'web' } });
    await page.locator('.pmd-canvas .ProseMirror h1').click();
    await expect(panel(page).locator('.pmd-files-chip').first()).toHaveText('Heading 1 (h1)');
  });
});

test.describe('keyboard and narrow windows', () => {
  test('F6 reaches the panel; arrows move between rows (one Tab stop); Enter opens, Shift+Enter reveals', async ({ page }) => {
    await open(page);
    await showPanel(page);
    await page.locator('.pmd-canvas .ProseMirror p').first().click();
    for (let i = 0; i < 4 && !(await panel(page).evaluate((el) => el.contains(document.activeElement))); i++) await page.keyboard.press('F6');
    expect(await panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expect(panel(page).locator('.pmd-files-open[tabindex="0"]')).toHaveCount(1);
    await panel(page).locator('.pmd-files-open[tabindex="0"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(':focus')).toHaveAccessibleName(/^Open report-child\.json /);
    await page.keyboard.press('End');
    await expect(page.locator(':focus')).toHaveAccessibleName(/^Open base\.css /);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Enter');
    const base = report.files.at(-1)!.path!;
    expect((await openFiles(page)).slice(-2)).toEqual([{ path: base }, { path: base, reveal: true }]);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(':focus')).toHaveAccessibleName('Reveal base.css in the Explorer');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator(':focus')).toHaveAccessibleName(/^Open base\.css /);
  });

  for (const width of [600, 360]) {
    test(`${width} px wide: no sideways scrolling, the panel at most half the window, paths wrap`, async ({ page }) => {
      await open(page, width);
      // (in a narrow window the Document tab's groups fold into drop-down buttons: the panel is opened directly)
      await page.evaluate(() => (window as unknown as { __pmd: { view: { set(c: unknown): void } } }).__pmd.view.set({ panels: { files: true } }));
      await answerFilesInUse(page, report);
      await expect(panel(page).locator('.pmd-files-row').first()).toBeVisible();
      const box = await panel(page).boundingBox();
      expect(box!.width).toBeLessThanOrEqual(width / 2 + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      expect(await panel(page).locator('.pmd-files-body').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});
