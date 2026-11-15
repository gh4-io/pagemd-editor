// P9 in a real browser (Chromium) with a pretend host: the Outline panel (entries, jump, Move up / Move down, drag), the
// Code view (its typing reaches the host as one minimal edit after a pause, then the canvas; outside changes reach it;
// undo is VS Code's), and Split view (both sides, cursors kept in the same block, no edit echoed back and forth).
// Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const HINTS = { required: [], shownOnPage: [], profileFields: [], defaults: {} };
const DOC = [
  '---',
  'title: The guide',
  '---',
  '',
  'Intro paragraph.',
  '',
  '# Alpha',
  '',
  'Alpha text with **bold** words.',
  '',
  '<!-- ::FIGURE src="shot.png" caption="Login" -->',
  '',
  '## Alpha one',
  'Tight paragraph under it.',
  '',
  '# Beta',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '# Gamma',
  '',
  'Gamma text.',
  '',
].join('\n');

type Edit = { from: number; to: number; text: string };
const edits = async (page: Page) => (await sent(page)).filter((m) => m.method === 'applyEdits');

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
  if (options.mode) await setView(page, options.mode);
  return errors;
}

const setView = (page: Page, mode: string) => fromHost(page, { kind: 'event', name: 'setView', data: { mode } });

/** Answers every applyEdits request as the host would and resolves with the text the host has once `count` were answered. */
async function answer(page: Page, count: number, text = DOC): Promise<string> {
  let current = text;
  let answered = 0;
  await expect
    .poll(
      async () => {
        const requests = await edits(page);
        for (; answered < requests.length; answered++) {
          const request = requests[answered]!;
          current = apply(current, (request.params as { edits: Edit[] }).edits);
          await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: answered + 2 } });
        }
        return answered;
      },
      { timeout: 5000 },
    )
    .toBe(count);
  return current;
}

function apply(text: string, list: Edit[]): string {
  let out = '';
  let at = 0;
  for (const e of list) {
    out += text.slice(at, e.from) + e.text;
    at = e.to;
  }
  return out + text.slice(at);
}

const outline = (page: Page) => page.locator('.pmd-outline');
const entry = (page: Page, text: string) => outline(page).locator('.pmd-outline-entry', { hasText: text });
const ribbonButton = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const tab = (page: Page, name: string) => page.locator('.pmd-ribbon').getByRole('tab', { name, exact: true });
const codeText = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { code?: { text: string } } }).__pmd.code?.text ?? null);
const canvasText = (page: Page) => page.locator('.pmd-canvas .ProseMirror').innerText();

async function openOutline(page: Page) {
  await tab(page, 'View').click();
  await ribbonButton(page, 'view.outline').click();
  await expect(outline(page)).toBeVisible();
}

/** The lines of DOC with Beta's section moved before Alpha's (the blank line between them stays between them). */
const BETA_FIRST = [
  '---',
  'title: The guide',
  '---',
  '',
  'Intro paragraph.',
  '',
  '# Beta',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '# Alpha',
  '',
  'Alpha text with **bold** words.',
  '',
  '<!-- ::FIGURE src="shot.png" caption="Login" -->',
  '',
  '## Alpha one',
  'Tight paragraph under it.',
  '',
  '# Gamma',
  '',
  'Gamma text.',
  '',
].join('\n');

test.describe('the Outline panel', () => {
  test('closed at first; View ▸ Outline opens it with the title, headings, numbered figure and table; remembered', async ({ page }) => {
    const errors = await open(page);
    await expect(outline(page)).toBeHidden();
    await openOutline(page);
    await expect(outline(page).locator('.pmd-outline-entry')).toHaveText(['The guide', 'Alpha', 'Figure 1: Login', 'Alpha one', 'Beta', 'Table', 'Gamma']);
    await expect(entry(page, 'Alpha one')).toHaveAttribute('aria-level', '2');
    await page.reload();
    await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
    await fromHost(page, { kind: 'event', name: 'init', data: { protocol: PROTOCOL, text: DOC, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: HINTS }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href } });
    await expect(outline(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('clicking an entry puts the cursor there', async ({ page }) => {
    await open(page);
    await openOutline(page);
    await entry(page, 'Gamma').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $head: { parent: { textContent: string } } } } } } } }).__pmd.canvas.view.state.selection.$head.parent.textContent)).toBe('Gamma');
  });

  test('Move up sends ONE edit: exactly those lines moved; the canvas shows the new order', async ({ page }) => {
    await open(page);
    await openOutline(page);
    await entry(page, 'Beta').click();
    await outline(page).getByRole('button', { name: 'Move up' }).click();
    const request = await waitFor(page, (m) => m.method === 'applyEdits');
    expect((request.params as { edits: Edit[] }).edits).toHaveLength(1);
    expect(await answer(page, 1)).toBe(BETA_FIRST);
    await expect(outline(page).locator('.pmd-outline-entry')).toHaveText(['The guide', 'Beta', 'Table', 'Alpha', 'Figure 1: Login', 'Alpha one', 'Gamma']);
    await expect.poll(() => canvasText(page)).toMatch(/Beta[\s\S]*Alpha[\s\S]*Gamma/);
    await quiet(page);
    expect(await edits(page)).toHaveLength(1); // the canvas re-read it: nothing sent back
  });

  test('Alt+Down on an entry moves its section down (the keyboard route); a sub-section can’t leave its parent', async ({ page }) => {
    await open(page);
    await openOutline(page);
    await entry(page, 'Alpha one').click();
    await expect(outline(page).getByRole('button', { name: 'Move down' })).toBeDisabled();
    await expect(outline(page).getByRole('button', { name: 'Move up' })).toBeDisabled();
    await entry(page, 'Alpha').first().focus();
    await entry(page, 'Alpha').first().press('Alt+ArrowDown');
    expect(await answer(page, 1)).toBe(BETA_FIRST);
  });

  test('dragging a heading onto another moves the section there', async ({ page }) => {
    await open(page);
    await openOutline(page);
    await entry(page, 'Beta').dragTo(entry(page, 'Alpha').first());
    expect(await answer(page, 1)).toBe(BETA_FIRST);
  });

  test('a move that would change how the text reads is refused (below a fence never closed)', async ({ page }) => {
    const text = '# One\n\nOne.\n\n# Two\n\n```\nnever closed\n';
    await open(page, { text });
    await openOutline(page);
    await entry(page, 'One').click();
    await outline(page).getByRole('button', { name: 'Move down' }).click();
    await expect(page.locator('.pmd-status-bar')).toContainText('wasn’t moved');
    expect(await edits(page)).toHaveLength(0);
  });

  test('in Read entries still jump (to their page), nothing moves', async ({ page }) => {
    await open(page, { mode: 'read', text: DOC.replace('# Gamma', '<!-- ::PAGEBREAK -->\n\n# Gamma') });
    await openOutline(page);
    await expect(page.locator('.pmd-status-bar')).toContainText('Page 1 of 2');
    await entry(page, 'Gamma').click();
    await expect(page.locator('.pmd-status-bar')).toContainText('Page 2 of 2');
    await entry(page, 'Beta').click();
    await expect(page.locator('.pmd-status-bar')).toContainText('Page 1 of 2');
    await expect(outline(page).getByRole('button', { name: 'Move up' })).toBeDisabled();
    await expect(entry(page, 'Beta')).not.toHaveAttribute('draggable', 'true');
  });
});

test.describe('the Code view', () => {
  test('shows the text exactly, colored and foldable by the canvas’s blocks', async ({ page }) => {
    const errors = await open(page, { mode: 'code' });
    await expect(page.locator('.pmd-code .cm-editor')).toBeVisible();
    await expect(page.locator('.pmd-canvas')).toBeHidden();
    expect(await codeText(page)).toBe(DOC);
    // A heading line and the table's lines carry the highlight style's classes; headings fold their section.
    const classes = (text: string) => page.locator('.cm-line', { hasText: text }).first().evaluate((el) => [...el.classList].filter((c) => !c.startsWith('cm-')));
    const headingClass = await classes('# Beta');
    expect(headingClass).toHaveLength(1);
    expect(await classes('| 1 | 2 |')).toHaveLength(1);
    expect(await classes('| 1 | 2 |')).not.toEqual(headingClass);
    expect(await classes('Gamma text.')).toEqual([]); // a paragraph is plain text
    expect(await classes('title: The guide')).toHaveLength(1); // the frontmatter
    // Folding Alpha's heading hides its whole section (its sub-section too), up to Beta.
    await page.locator('.cm-line', { hasText: '# Alpha' }).first().click();
    await page.keyboard.press('Control+Shift+BracketLeft'); // CodeMirror's fold key
    await expect(page.locator('.cm-line', { hasText: 'Tight paragraph under it.' })).toHaveCount(0);
    await expect(page.locator('.cm-line', { hasText: '# Beta' })).toHaveCount(1);
    // The ribbon shows the Document and View tabs only (the cohesion matrix).
    await expect(page.locator('.pmd-ribbon-tab')).toHaveText(['Document', 'View']);
    expect(errors).toEqual([]);
  });

  test('typing reaches the host as ONE minimal edit after the pause; the canvas reads it; nothing comes back', async ({ page }) => {
    await open(page, { mode: 'code' });
    await page.locator('.cm-line', { hasText: 'Gamma text.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' More');
    const request = await waitFor(page, (m) => m.method === 'applyEdits');
    expect((request.params as { edits: Edit[] }).edits).toEqual([{ from: DOC.indexOf('Gamma text.') + 'Gamma text.'.length, to: DOC.indexOf('Gamma text.') + 'Gamma text.'.length, text: ' More' }]);
    expect(await answer(page, 1)).toBe(DOC.replace('Gamma text.', 'Gamma text. More'));
    await setView(page, 'web');
    await expect(page.locator('.pmd-canvas')).toContainText('Gamma text. More');
    await quiet(page);
    expect(await edits(page)).toHaveLength(1); // no echo from the canvas
  });

  test('Ctrl+Z is VS Code’s undo (after the typing is sent), not CodeMirror’s', async ({ page }) => {
    await open(page, { mode: 'code' });
    await page.locator('.cm-line', { hasText: 'Gamma text.' }).click();
    await page.keyboard.type('X');
    await page.keyboard.press('Control+z');
    await answer(page, 1);
    await waitFor(page, (m) => m.kind === 'event' && m.name === 'runCommand' && (m.data as { command: string }).command === 'undo');
    expect(await codeText(page)).toContain('X'); // the view didn't undo it itself: VS Code will, and tell us
  });

  test('a change from outside (VS Code’s undo, another editor) shows in the Code view; nothing is sent', async ({ page }) => {
    await open(page, { mode: 'code' });
    const changed = DOC.replace('Gamma text.', 'Gamma changed.');
    await fromHost(page, { kind: 'event', name: 'externalChange', data: { text: changed, version: 2 } });
    await expect.poll(() => codeText(page)).toBe(changed);
    await quiet(page);
    expect(await edits(page)).toHaveLength(0);
  });

  test('the canvas’s edits reach the Code view (the Inspector edits the properties while in Code)', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as unknown as { __pmd: { canvas: { typeAtEndOfBlock(i: number, t: string): void } } }).__pmd.canvas.typeAtEndOfBlock(1, ' Added'));
    const host = await answer(page, 1);
    await setView(page, 'code');
    await expect.poll(() => codeText(page)).toBe(host);
    expect(host).toContain('Intro paragraph. Added');
  });
});

test.describe('Split view', () => {
  test('both sides; the canvas’s typing reaches the Code view; one edit each way, no echo', async ({ page }) => {
    await open(page, { mode: 'split' });
    await expect(page.locator('.pmd-code .cm-editor')).toBeVisible();
    await expect(page.locator('.pmd-canvas')).toBeVisible();
    await page.locator('.pmd-canvas p', { hasText: 'Gamma text.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    expect(await answer(page, 1)).toBe(DOC.replace('Gamma text.', 'Gamma text.!'));
    await expect.poll(() => codeText(page)).toBe(DOC.replace('Gamma text.', 'Gamma text.!'));
    // Now type in the Code view: one edit, and the canvas follows.
    await page.locator('.cm-line', { hasText: 'Intro paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('?');
    expect(await answer(page, 2, DOC)).toBe(DOC.replace('Gamma text.', 'Gamma text.!').replace('Intro paragraph.', 'Intro paragraph.?'));
    await expect(page.locator('.pmd-canvas')).toContainText('Intro paragraph.?');
    await quiet(page);
    expect(await edits(page)).toHaveLength(2);
  });

  test('the cursors stay in the same block: canvas → Code and Code → canvas', async ({ page }) => {
    await open(page, { mode: 'split' });
    await page.locator('.pmd-canvas p', { hasText: 'Alpha text' }).click();
    // The Code view marks the lines of the block the canvas's cursor is in, and puts its cursor inside that block.
    await expect(page.locator('.cm-line.pmd-code-synced')).toHaveText(['Alpha text with **bold** words.']);
    const head = await page.evaluate(() => (window as unknown as { __pmd: { code: { cursor: number } } }).__pmd.code.cursor);
    const from = DOC.indexOf('Alpha text');
    expect(head).toBeGreaterThanOrEqual(from);
    expect(head).toBeLessThanOrEqual(from + 'Alpha text with **bold** words.'.length);
    // Code → canvas.
    await page.locator('.cm-line', { hasText: 'Gamma text.' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $head: { parent: { textContent: string } } } } } } } }).__pmd.canvas.view.state.selection.$head.parent.textContent)).toBe('Gamma text.');
    expect(await edits(page)).toHaveLength(0);
  });

  test('View ▸ Stacked puts the Code view on top', async ({ page }) => {
    await open(page, { mode: 'split' });
    await tab(page, 'View').click();
    await ribbonButton(page, 'view.stacked').click();
    await expect(page.locator('.pmd-split')).toHaveAttribute('data-arrangement', 'stacked');
    const code = await page.locator('.pmd-split-code').boundingBox();
    const canvas = await page.locator('.pmd-split-canvas').boundingBox();
    expect(code!.y + code!.height).toBeLessThanOrEqual(canvas!.y + 1);
  });
});
