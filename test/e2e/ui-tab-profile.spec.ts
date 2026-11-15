// Fix run "Group B" (UI polish) in a real browser (Chromium) with a pretend host: Tab order in the properties form, the Print Preview
// read-only note, and a profile change restyling the canvas. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { pathToFileURL } from 'node:url';
import { openInPrintLayout, PAGEMD_ROOT, settle, stylesFor } from './pagination-harness.ts';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const HINTS = { required: ['title', 'author'], shownOnPage: ['title', 'version'], profileFields: [], defaults: { author: 'TBD' } };
const DOC = ['---', '# The guide', 'title: Old title  # keep me', 'doc_id: X-1', '---', '', '# Heading', '', 'Last paragraph.', ''].join('\n');


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
    data: { protocol: PROTOCOL, text: options.text ?? DOC, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: HINTS }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (options.mode) await fromHost(page, { kind: 'event', name: 'setView', data: { mode: options.mode } });
  return errors;
}

const inspector = (page: Page) => page.locator('.pmd-inspector');
const ribbonButton = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const tab = (page: Page, name: string) => page.locator('.pmd-ribbon').getByRole('tab', { name, exact: true });
const property = (page: Page, key: string) => inspector(page).locator(`[data-property="${key}"]`);
async function openDocumentTab(page: Page) {
  await tab(page, 'View').click();
  await ribbonButton(page, 'view.inspector').click();
  await expect(inspector(page)).toBeVisible();
  await inspector(page).getByRole('tab', { name: /Document/ }).click();
}
const active = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    return `${a.tagName}|${a.getAttribute('aria-label') ?? ''}|${a.closest('[data-property]')?.getAttribute('data-property') ?? ''}`;
  });


test.describe('Tab order in the document-properties form', () => {
  test('Tab from a box goes to the next box, not to the little × button, and the × is still there for the mouse', async ({ page }) => {
    await open(page);
    await openDocumentTab(page);
    for (let i = 0; i < 5; i++) {
      await property(page, 'document_id').locator('input').click();
      await page.keyboard.press('Tab');
      expect(await active(page), `try ${i + 1}`).toMatch(/^INPUT\|\|author$/); // the next box (Author), however often it is tried
    }
    const remove = property(page, 'document_id').getByRole('button', { name: 'Remove Document ID' });
    await expect(remove).toHaveAttribute('tabindex', '-1');
    await expect(remove).toHaveAttribute('title', /Delete/);
    await expect(remove).toHaveAttribute('aria-description', /Delete/);
  });

  test('the form being drawn again while a box has the focus does not break Tab', async ({ page }) => {
    await open(page);
    await openDocumentTab(page);
    await property(page, 'document_id').locator('input').click();
    // the profile's hints change under the author's hands (a profile switch redraws the form)
    await fromHost(page, { kind: 'event', name: 'stylesChanged', data: { styles: null, gateDefaults: {}, notes: [], properties: { ...HINTS, shownOnPage: ['title', 'doc_id', 'version'] } } });
    await expect(property(page, 'document_id').locator('.pmd-props-badge')).toContainText(['On page']);
    expect(await active(page)).toBe('INPUT||document_id');
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatch(/^INPUT\|\|author$/);
  });

  test('typing a new value and pressing Tab: the change is saved and the focus still goes to the next box', async ({ page }) => {
    await open(page);
    await openDocumentTab(page);
    await property(page, 'document_id').locator('input').fill('X-2');
    await page.keyboard.press('Tab'); // leaving the box commits it, which draws the form again
    await expect(property(page, 'document_id').locator('input')).toHaveValue('X-2');
    await waitFor(page, (m) => m.method === 'applyEdits');
    expect(await active(page)).toMatch(/^INPUT\|\|author$/);
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatch(/^INPUT\|\|version$/);
  });

  test('Delete removes a property from the keyboard: from an empty box at once, from a box with text only with Alt', async ({ page }) => {
    await open(page);
    await openDocumentTab(page);
    const box = property(page, 'document_id').locator('input');
    await box.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Delete'); // deletes the "X" of "X-1": a letter, not the property
    await expect(box).toHaveValue('-1');
    await expect(property(page, 'document_id')).toHaveCount(1);
    await page.keyboard.press('Alt+Delete');
    await expect(property(page, 'document_id')).toHaveCount(0);
  });

  test('Delete on a list row removes that entry (the Element tab list, markers)', async ({ page }) => {
    const text = '::: annotated-image shot.png\nmarkers:\n  - { id: 1, x: 10, y: 20, label: "First" }\n  - { id: 2, x: 30, y: 40, label: "Second" }\n:::\n';
    await open(page, { text });
    await tab(page, 'View').click();
    await ribbonButton(page, 'view.inspector').click();
    await page.locator('.pmd-canvas .pmd-annotated-image').click();
    const rows = inspector(page).locator('[data-field="markers"] .pmd-insp-list-row');
    await expect(rows).toHaveCount(2);
    const remove = rows.nth(0).getByRole('button', { name: 'Remove Markers 1' });
    await expect(remove).toHaveAttribute('tabindex', '-1');
    await rows.nth(0).getByRole('button', { name: /Move Markers 1 down/ }).focus();
    await page.keyboard.press('Delete');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('input').nth(0)).toHaveValue('2');
  });
});

test.describe('Print Preview is read-only and says so', () => {
  test('the Document tab shows a short note, the boxes cannot be typed in, and nothing can be added or removed', async ({ page }) => {
    await open(page);
    await openDocumentTab(page);
    await expect(inspector(page).locator('.pmd-insp-readonly-note')).toHaveCount(0); // editable: no note
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'preview' } });
    const note = inspector(page).locator('.pmd-props .pmd-insp-readonly-note');
    await expect(note).toHaveText('Print Preview is read-only. Switch to Print Layout to edit.');
    await expect(property(page, 'title').locator('input')).toHaveAttribute('readonly', '');
    await expect(inspector(page).getByRole('combobox', { name: 'Add property' })).toHaveCount(0);
    await expect(property(page, 'document_id').getByRole('button', { name: /Remove/ })).toHaveCount(0);
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'print' } });
    await expect(inspector(page).locator('.pmd-insp-readonly-note')).toHaveCount(0);
    await expect(property(page, 'title').locator('input')).not.toHaveAttribute('readonly', '');
  });

  test('Read says the same about itself', async ({ page }) => {
    await open(page, { mode: 'read' });
    await openDocumentTab(page);
    await expect(inspector(page).locator('.pmd-props .pmd-insp-readonly-note')).toHaveText('Read is read-only. Switch to Print Layout to edit.');
  });
});

// "Choosing another profile does not seem to change the look": the host sends the new styles (host-styles.test.ts); here the canvas must
// apply them in both layouts. Finding: standard_letter, sop and technical-report share one template, layout and stylesheet, so the canvas
// look is the same for them (sop adds its running header/footer defaults); book-wiki is a different look.
const PROFILE_DOC = (profile: string) => `---\ntitle: Guide\nprofile: ${profile}\n---\n\n# Heading one\n\n## Heading two\n\nA paragraph of text.\n`;
const FILE = `${PAGEMD_ROOT}/tests/corpus/pagemd/examples/md/profile-switch.md`;
const look = (page: Page) =>
  page.evaluate(() => {
    const read = (selector: string) => {
      const s = getComputedStyle(document.querySelector(selector)!);
      return `${s.fontFamily.slice(0, 40)}|${s.fontSize}|${s.fontWeight}|${s.color}|${s.marginTop}|${s.marginBottom}`;
    };
    return { h1: read('.pmd-canvas h1'), h2: read('.pmd-canvas h2'), p: read('.pmd-canvas p') };
  });

for (const mode of ['print', 'web'] as const) {
  test(`choosing another profile restyles the canvas in ${mode === 'print' ? 'Print' : 'Web'} Layout`, async ({ page }) => {
    await openInPrintLayout(page, FILE, PROFILE_DOC('standard_letter'), fixtures);
    if (mode === 'web') await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'web' } });
    await settle(page);
    const before = await look(page);
    const results: Record<string, unknown> = { standard_letter: before };
    for (const profile of ['book-wiki', 'sop', 'technical-report', 'standard_letter']) {
      await fromHost(page, { kind: 'event', name: 'stylesChanged', data: await stylesFor(FILE, PROFILE_DOC(profile)) });
      await settle(page);
      results[profile] = await look(page);
    }
    // book-wiki is a different look (fonts, sizes, colors); the other three share pagemd's stylesheet
    expect(results['book-wiki']).not.toEqual(results['standard_letter']);
    expect(results['sop']).toEqual(results['standard_letter']);
    expect(results['technical-report']).toEqual(results['standard_letter']);
    // and switching back restores the first look exactly (the old profile's CSS is gone, not stacked)
    expect(await look(page)).toEqual(before);
    console.log(`LOOK ${mode}`, JSON.stringify(results));
  });
}
