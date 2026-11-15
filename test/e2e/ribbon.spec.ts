// P7 in a real browser (Chromium) with a pretend host: the ribbon, the slash menu, the selection toolbar, shortcut
// keys, the View tab, and the gated-insert flow (ask / auto / warn; since P8 "Add property" is part of the insert's own
// edit, one undo step, R-161).
// Run: npm run test:e2e (builds first).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const PLAIN = { styles: null, gateDefaults: {}, notes: [] };
const TEXT = '# Title\n\nFirst para.\n\nSecond para.\n\n```\ncode\n```\n';


async function waitFor(page: Page, match: (m: Message) => boolean, nth = 0): Promise<Message> {
  let found: Message | undefined;
  await expect.poll(async () => (found = (await sent(page)).filter(match)[nth]), { timeout: 5000 }).toBeTruthy();
  return found!;
}

async function open(page: Page, options: { text?: string; gatedInsert?: 'ask' | 'auto' | 'warn'; mode?: string; gateDefaults?: Record<string, unknown> } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: options.text ?? TEXT, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { ...PLAIN, gateDefaults: options.gateDefaults ?? {} }, settings: { gatedInsert: options.gatedInsert ?? 'ask' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (options.mode) await fromHost(page, { kind: 'event', name: 'setView', data: { mode: options.mode } });
  return errors;
}

/** Answers an applyEdits request so the next one is computed against the new version. */
async function ack(page: Page, request: Message, version: number) {
  await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version } });
}

const ribbon = (page: Page) => page.locator('.pmd-ribbon');
const tab = (page: Page, name: string) => ribbon(page).getByRole('tab', { name, exact: true });
const button = (page: Page, command: string) => ribbon(page).locator(`[data-command="${command}"]`);
/** What ProseMirror's state says about the selection (it learns of a click one browser event later). */
const selection = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __pmd: { canvas: { view: { state: { selection: { empty: boolean; from: number; to: number; $from: { parent: { textContent: string; content: { size: number } }; parentOffset: number } } } } } } }).__pmd.canvas.view.state;
    const { $from } = state.selection;
    return { empty: state.selection.empty, text: $from.parent.textContent, atEnd: $from.parentOffset === $from.parent.content.size };
  });

/** Puts the cursor at the end of a paragraph's text, and waits until the editor knows it. */
async function cursorIn(locator: Locator, page: Page) {
  const text = (await locator.textContent()) ?? '';
  await locator.click();
  await expect.poll(async () => (await selection(page)).text).toBe(text);
  await page.keyboard.press('End');
  await expect.poll(async () => (await selection(page)).atEnd).toBe(true);
}

/** Selects a paragraph's whole text (a triple click) and waits until the editor knows it. */
async function selectAll(locator: Locator, page: Page) {
  await locator.click({ clickCount: 3 });
  await expect.poll(async () => (await selection(page)).empty).toBe(false);
}

const editor = (page: Page) => page.locator('.pmd-canvas .ProseMirror');
const options = (page: Page) => page.locator('.pmd-slash').getByRole('option');

test.describe('the ribbon', () => {
  test('has the seven tabs (P16: Table; P20: no Image tab without a picture), a tab list for keyboard and screen readers, no More tab; Insert has no image tools (P20)', async ({ page }) => {
    const errors = await open(page);
    await expect(ribbon(page).getByRole('tablist')).toBeVisible();
    await expect(ribbon(page).getByRole('tab')).toHaveText(['Home', 'Insert', 'Table', 'Layout', 'Document', 'Review', 'View']);
    await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');
    await expect(ribbon(page).getByRole('tabpanel')).toBeVisible();
    await tab(page, 'Insert').click();
    await expect(page.locator('.pmd-ribbon-group-label', { hasText: 'Pictures' })).toHaveCount(1);
    await expect(page.locator('.pmd-ribbon-group-label', { hasText: 'Image tools' })).toHaveCount(0);
    await expect(button(page, 'image.crop')).toHaveCount(0); // P20: on the Image tab, which shows with a picture selected
    await expect(ribbon(page).getByRole('tab', { name: 'More' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the arrow keys, Home and End move between tabs', async ({ page }) => {
    await open(page);
    await tab(page, 'Home').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Insert')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Insert')).toBeFocused();
    await page.keyboard.press('End');
    await expect(tab(page, 'View')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'View')).toBeFocused();
  });

  test('Bold: shows its shortcut, applies to the selection, and shows pressed inside bold text', async ({ page }) => {
    await open(page);
    await expect(button(page, 'strong.toggle')).toHaveAttribute('title', 'Bold (Ctrl+B)');
    await selectAll(page.locator('.pmd-canvas p').first(), page);
    await button(page, 'strong.toggle').click();
    const edit = await waitFor(page, (m) => m.method === 'applyEdits');
    expect(JSON.stringify(edit.params)).toContain('**First para.**');
    await expect(button(page, 'strong.toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.pmd-canvas p').nth(1).click();
    await expect(button(page, 'strong.toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('keeps the editor focused and the selection while a button is pressed', async ({ page }) => {
    await open(page);
    await selectAll(page.locator('.pmd-canvas p').first(), page);
    await button(page, 'emphasis.toggle').click();
    await expect(editor(page)).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('First para.');
  });

  test('a button the state does not allow is aria-disabled and does nothing (a bold mark inside a code block)', async ({ page }) => {
    await open(page);
    await page.locator('.pmd-canvas pre').click();
    await expect.poll(async () => (await selection(page)).text).toBe('code');
    await expect(button(page, 'strong.toggle')).toHaveAttribute('aria-disabled', 'true'); // a code block takes no marks
    await expect(button(page, 'heading.h1')).toHaveAttribute('aria-disabled', 'false');
    const before = (await sent(page)).length;
    await button(page, 'strong.toggle').click({ force: true });
    await quiet(page);
    expect((await sent(page)).length).toBe(before);
  });

  test('Heading buttons show the current level', async ({ page }) => {
    await open(page);
    await page.locator('.pmd-canvas h1').click();
    await expect(button(page, 'heading.h1')).toHaveAttribute('aria-current', 'true');
    await ribbon(page).getByRole('button', { name: /Styles/ }).click();
    await expect(button(page, 'heading.h1')).toHaveAttribute('aria-current', 'true');
    await expect(button(page, 'heading.h2')).not.toHaveAttribute('aria-current', 'true');
  });

  test('a group with many commands is a drop-down menu that opens with the keyboard and closes with Escape', async ({ page }) => {
    await open(page);
    await tab(page, 'Insert').click();
    const menuButton = ribbon(page).getByRole('button', { name: /^Box/ });
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await menuButton.focus();
    await page.keyboard.press('ArrowDown');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(ribbon(page).getByRole('menu', { name: 'Box' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Box: Details' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Box: Summary' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton).toBeFocused();
  });

  test('Insert > Box > Tip wraps the paragraph in a ::: tip box', async ({ page }) => {
    await open(page);
    await cursorIn(page.locator('.pmd-canvas p').first(), page);
    await tab(page, 'Insert').click();
    await ribbon(page).getByRole('button', { name: /^Box/ }).click();
    await page.getByRole('menuitem', { name: 'Box: Tip' }).click();
    const edit = await waitFor(page, (m) => m.method === 'applyEdits');
    expect(JSON.stringify(edit.params)).toContain('::: tip\\nFirst para.\\n:::');
    await expect(page.locator('.pmd-canvas .container-tip')).toBeVisible();
  });

  test('Insert > Table inserts a table below the paragraph', async ({ page }) => {
    await open(page);
    await cursorIn(page.locator('.pmd-canvas p').first(), page);
    await tab(page, 'Insert').click();
    await button(page, 'table.insert').click();
    await expect(page.locator('.pmd-canvas table')).toHaveCount(1);
    const edit = await waitFor(page, (m) => m.method === 'applyEdits');
    expect(JSON.stringify(edit.params)).toContain('| --- |');
  });

  test('Ctrl+B and Ctrl+I run the commands; a shortcut hint is not just a hint (R-158: Word-style keys win in the document)', async ({ page }) => {
    await open(page);
    await selectAll(page.locator('.pmd-canvas p').first(), page);
    await page.keyboard.press('Control+b');
    await expect.poll(async () => JSON.stringify((await sent(page)).filter((m) => m.method === 'applyEdits').at(-1)?.params ?? '')).toContain('**First para.**');
    await ack(page, await waitFor(page, (m) => m.method === 'applyEdits'), 2);
    await page.keyboard.press('Control+i');
    const second = await waitFor(page, (m) => m.method === 'applyEdits', 1);
    expect(JSON.stringify(second.params)).toMatch(/\*\*\*First para\.\*\*\*|_\*\*First para\.\*\*_/);
  });
});

test.describe('pressed state (R-157 review)', () => {
  test('only toggles say pressed or not pressed; a one-shot button like Insert Table says nothing', async ({ page }) => {
    await open(page);
    await expect(button(page, 'strong.toggle')).toHaveAttribute('aria-pressed', 'false');
    await tab(page, 'Insert').click();
    await expect(button(page, 'table.insert')).not.toHaveAttribute('aria-pressed', /.*/);
    await expect(button(page, 'figure.insert')).not.toHaveAttribute('aria-pressed', /.*/);
    await expect(button(page, 'code_block.toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Word-style keys win in the document (R-158)', () => {
  /** What VS Code's webview does: a bubble `keydown` listener on the page's window forwards every key that reaches it to the workbench. */
  async function watchForwarding(page: Page) {
    await page.evaluate(() => {
      const w = window as unknown as { __forwarded: string[] };
      w.__forwarded = [];
      window.addEventListener('keydown', (e) => !['Control', 'Shift', 'Alt', 'Meta'].includes(e.key) && w.__forwarded.push(`${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${e.key}`));
    });
    return () => page.evaluate(() => (window as unknown as { __forwarded: string[] }).__forwarded);
  }

  test('a key the editor handles (Ctrl+B, Ctrl+K, Ctrl+E, Ctrl+Shift+X) never reaches the page window, so VS Code never sees it; other keys still do', async ({ page }) => {
    await open(page);
    const forwarded = await watchForwarding(page);
    await selectAll(page.locator('.pmd-canvas p').first(), page);
    for (const keys of ['Control+b', 'Control+k', 'Control+e', 'Control+Shift+x']) await page.keyboard.press(keys);
    await page.keyboard.press('Control+p'); // not ours: VS Code's quick open must still get it
    expect(await forwarded()).toEqual(['Ctrl+p']);
  });

  test('a bound key owns itself even where its command cannot run (Ctrl+B in a code block), and is VS Code\'s again in Read', async ({ page }) => {
    await open(page);
    const forwarded = await watchForwarding(page);
    await page.locator('.pmd-canvas pre').click();
    await expect.poll(async () => (await selection(page)).text).toBe('code');
    await page.keyboard.press('Control+b');
    expect(await forwarded()).toEqual([]);
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'read' } });
    await expect(button(page, 'view.read')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.pmd-canvas p').first().click();
    await page.keyboard.press('Control+b');
    expect(await forwarded()).toEqual(['Ctrl+b']); // read-only: VS Code toggles its sidebar as usual
  });
});

test.describe('shortcuts with Shift', () => {
  test('Ctrl+Shift+8 makes a bulleted list and Ctrl+Alt+2 a level-2 heading', async ({ page }) => {
    await open(page);
    await cursorIn(page.locator('.pmd-canvas p').first(), page);
    await page.keyboard.press('Control+Shift+8');
    await expect(page.locator('.pmd-canvas ul')).toHaveCount(1);
    await page.keyboard.press('Control+Shift+8'); // again: back out of the list
    await expect(page.locator('.pmd-canvas ul')).toHaveCount(0);
    await page.keyboard.press('Control+Alt+2');
    await expect(page.locator('.pmd-canvas h2')).toHaveText('First para.');
  });
});

test.describe('the View tab and Read', () => {
  test('View > Draft asks the host for the same command the status bar uses; the host\'s setView then switches the view', async ({ page }) => {
    await open(page);
    await tab(page, 'View').click();
    await expect(button(page, 'view.print')).toHaveAttribute('aria-pressed', 'true');
    await button(page, 'view.draft').click();
    expect(await waitFor(page, (m) => m.name === 'runCommand')).toEqual({ kind: 'event', name: 'runCommand', data: { command: 'pagemd.draft' } });
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
    await expect(button(page, 'view.draft')).toHaveAttribute('aria-pressed', 'true');
    await expect(button(page, 'view.vertical')).toHaveAttribute('aria-disabled', 'true'); // Draft has no pages
  });

  test('page arrangement, fit, zoom and the ruler follow the buttons', async ({ page }) => {
    await open(page);
    await tab(page, 'View').click();
    await button(page, 'view.side-by-side').click();
    await expect(page.locator('.pmd-status-arrangement option:checked')).toHaveText('Side by side');
    await button(page, 'view.zoom-in').click();
    await expect(page.locator('.pmd-status-zoom option:checked')).toHaveText('125 %');
    await button(page, 'view.fit-page-width').click();
    await expect(page.locator('.pmd-status-zoom option:checked')).toHaveText('Page width');
    await expect(button(page, 'view.ruler')).toHaveAttribute('aria-pressed', 'true');
    await button(page, 'view.ruler').click();
    await expect(button(page, 'view.ruler')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Read shows the View tab only; no slash menu and no selection toolbar there', async ({ page }) => {
    await open(page, { mode: 'read' });
    await expect(ribbon(page).getByRole('tab')).toHaveText(['View']);
    await expect(button(page, 'view.read')).toHaveAttribute('aria-pressed', 'true');
    await selectAll(page.locator('.pmd-canvas p').first(), page);
    await quiet(page);
    await expect(page.locator('.pmd-selection-toolbar')).toBeHidden();
    await expect(page.locator('.pmd-slash')).toBeHidden();
    // Back to an editing view: every tab is back.
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'print' } });
    await expect(ribbon(page).getByRole('tab')).toHaveCount(7);
  });
});

test.describe('the slash menu', () => {
  async function typeSlash(page: Page, text: string) {
    await cursorIn(page.locator('.pmd-canvas p').first(), page);
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
  }

  test('opens on "/" with a labelled list, filters as you type, and closes when the text no longer fits', async ({ page }) => {
    await open(page);
    await typeSlash(page, '/');
    const list = page.getByRole('listbox', { name: 'Insert' });
    await expect(list).toBeVisible();
    await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.type('tab');
    await expect(options(page).first()).toHaveText('Table');
    await expect(editor(page)).toHaveAttribute('aria-activedescendant', /pmd-slash-option-0/);
    await page.keyboard.type('xyzq');
    await expect(list).toBeHidden();
  });

  test('the editing area is a combobox while the list is open, and a text box again after (P13b: the canvas names its role)', async ({ page }) => {
    await open(page);
    await typeSlash(page, '/tab');
    const area = editor(page);
    await expect(area).toHaveAttribute('role', 'combobox');
    await expect(area).toHaveAttribute('aria-expanded', 'true');
    await expect(area).toHaveAttribute('aria-controls', 'pmd-slash-list');
    await expect(area).toHaveAttribute('aria-haspopup', 'listbox');
    await expect(page.locator('#pmd-slash-list')).toHaveAttribute('role', 'listbox');
    await page.keyboard.press('Escape');
    await expect(area).toHaveAttribute('role', 'textbox');
    await expect(area).toHaveAttribute('aria-label', 'Document');
    await expect(area).not.toHaveAttribute('aria-expanded', /.*/);
    await expect(area).not.toHaveAttribute('aria-activedescendant', /.*/);
  });

  test('Enter inserts the highlighted entry and removes the typed "/query" in one transaction', async ({ page }) => {
    await open(page);
    await typeSlash(page, '/tab');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __tr: number; __pmd: { canvas: { view: { props: { dispatchTransaction(tr: unknown): void }; setProps(p: unknown): void } } } };
      const view = w.__pmd.canvas.view;
      const original = view.props.dispatchTransaction;
      w.__tr = 0;
      view.setProps({ dispatchTransaction: (tr: unknown) => (w.__tr++, original(tr)) });
    });
    await page.keyboard.press('Enter');
    await expect(page.locator('.pmd-canvas table')).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __tr: number }).__tr)).toBe(1);
    await expect(editor(page)).not.toContainText('/tab');
    const edit = await waitFor(page, (m) => m.method === 'applyEdits');
    expect(JSON.stringify(edit.params)).not.toContain('/tab');
  });

  test('the arrow keys move the highlight, Escape closes it, and the text stays', async ({ page }) => {
    await open(page);
    await typeSlash(page, '/head');
    const items = options(page);
    await expect(items.first()).toHaveText('Heading 1');
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp'); // wraps to the last entry
    await expect(items.last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(editor(page)).toContainText('/head');
  });

  test('a click picks an entry; "box" lists every box kind', async ({ page }) => {
    await open(page);
    await typeSlash(page, '/box');
    await expect(options(page)).toHaveCount(12); // the first twelve of 16
    await options(page).filter({ hasText: 'Box: Warning' }).click();
    await expect(page.locator('.pmd-canvas .container-warning')).toBeVisible();
  });

  test('does not open inside a code block', async ({ page }) => {
    await open(page);
    await page.locator('.pmd-canvas pre').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' /tab');
    await quiet(page);
    await expect(page.getByRole('listbox')).toBeHidden();
  });

  test('a gated entry says what it needs', async ({ page }) => {
    await open(page);
    await typeSlash(page, '/lettered');
    await expect(options(page).first()).toContainText('needs fancy_lists');
  });
});

test.describe('the selection toolbar', () => {
  test('appears over selected text with the formatting buttons, applies one, and goes away with the selection', async ({ page }) => {
    await open(page);
    const bar = page.getByRole('toolbar', { name: 'Text formatting' });
    await expect(bar).toBeHidden();
    await selectAll(page.locator('.pmd-canvas p').first(), page);
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Bold' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Link', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Heading 2' })).toHaveText('H2');
    const box = await bar.boundingBox();
    const text = await page.locator('.pmd-canvas p').first().boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(text!.y + 2); // above the selection
    await bar.getByRole('button', { name: 'Bold' }).click();
    await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    const edit = await waitFor(page, (m) => m.method === 'applyEdits');
    expect(JSON.stringify(edit.params)).toContain('**First para.**');
    await page.keyboard.press('ArrowRight');
    await expect(bar).toBeHidden();
  });

  test('does not show over code, and its buttons move with the arrow keys', async ({ page }) => {
    await open(page);
    await page.locator('.pmd-canvas pre').click({ clickCount: 3 });
    await quiet(page);
    await expect(page.getByRole('toolbar')).toBeHidden();
    await selectAll(page.locator('.pmd-canvas p').first(), page);
    const bar = page.getByRole('toolbar', { name: 'Text formatting' });
    await expect(bar).toBeVisible();
    await bar.getByRole('button').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(bar.getByRole('button').nth(1)).toBeFocused();
  });
});

test.describe('gated inserts (ADR-0016 M3, R-154; one undo step since P8, R-161)', () => {

  async function clickLettered(page: Page) {
    await cursorIn(page.locator('.pmd-canvas p').first(), page);
    await button(page, 'fancy-lists.lower-alpha').click();
  }

  /** The text edits of every applyEdits request sent so far. */
  const editRequests = async (page: Page) => (await sent(page)).filter((m) => m.method === 'applyEdits').map((m) => (m.params as { edits: { from: number; to: number; text: string }[] }).edits);

  test('ask: the prompt names the item; "Add" sends the property and the insert as ONE edit (one undo step)', async ({ page }) => {
    await open(page);
    await expect(button(page, 'fancy-lists.lower-alpha')).toHaveAttribute('data-gated', 'true');
    await clickLettered(page);
    const ask = await waitFor(page, (m) => m.method === 'confirmGatedInsert');
    expect(ask.params).toEqual({ label: 'Lettered list (a. b. c.)', field: 'fancy_lists', value: true });
    await fromHost(page, { kind: 'response', id: ask.id, ok: true, result: 'add' });
    const edits = await waitFor(page, (m) => m.method === 'applyEdits');
    // One request: the new frontmatter at the start and the lettered list, together (VS Code makes it one undo step).
    expect((edits.params as { edits: unknown[] }).edits).toEqual([
      { from: 0, to: 0, text: '---\nfancy_lists: true\n---\n\n' },
      { from: 9, to: 20, text: 'a. First para.' },
    ]);
    await ack(page, edits, 2);
    await quiet(page);
    expect(await editRequests(page)).toHaveLength(1); // nothing follows
    expect((await sent(page)).some((m) => m.method === 'addFrontmatterField')).toBe(false); // gone in protocol v5
    await expect(page.locator('.pmd-canvas ol.list-lower-alpha')).toHaveCount(1);
    await expect(page.locator('.pmd-canvas .pmd-fm-card')).toHaveCount(1);
    await expect(button(page, 'fancy-lists.lower-alpha')).not.toHaveAttribute('data-gated', 'true');
    // The cursor stays in the list item it was in: the frontmatter added above it moved everything down.
    await expect.poll(async () => (await selection(page)).text).toBe('First para.');
  });

  test('settingsChanged ("Don\'t Ask Again" switched the setting to auto) takes effect at once', async ({ page }) => {
    await open(page);
    await fromHost(page, { kind: 'event', name: 'settingsChanged', data: { gatedInsert: 'auto' } });
    await clickLettered(page);
    const edits = await waitFor(page, (m) => m.method === 'applyEdits');
    expect(JSON.stringify(edits.params)).toContain('fancy_lists: true');
    expect((await sent(page)).some((m) => m.method === 'confirmGatedInsert')).toBe(false);
  });

  test('a profile that switches the gate on counts too (the gate defaults)', async ({ page }) => {
    await open(page, { gateDefaults: { fancy_lists: true } });
    await expect(button(page, 'fancy-lists.lower-alpha')).not.toHaveAttribute('data-gated', 'true');
  });
});

test.describe('the gate is decided when the button is used (R-157 review)', () => {
  const lettered = (page: Page) => button(page, 'fancy-lists.lower-alpha');

  test('a button drawn as allowed asks when the property has just been removed from the document', async ({ page }) => {
    await open(page, { text: '---\nfancy_lists: true\n---\n\nFirst para.\n' });
    await cursorIn(page.locator('.pmd-canvas p').first(), page);
    await expect(lettered(page)).not.toHaveAttribute('data-gated', 'true');
    // The property goes away and the very next thing is a click, before the ribbon has redrawn (one frame).
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { kind: 'event', name: 'externalChange', data: { text: 'First para.\n', version: 2 } } }));
      (document.querySelector('[data-command="fancy-lists.lower-alpha"]') as HTMLElement).click();
    });
    await waitFor(page, (m) => m.method === 'confirmGatedInsert');
  });

  test('a slash pick that waits for the prompt does nothing if its "/query" is gone by then', async ({ page }) => {
    await open(page);
    await cursorIn(page.locator('.pmd-canvas p').first(), page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('/lettered');
    await expect(options(page).first()).toContainText('Lettered');
    await page.keyboard.press('Enter');
    const ask = await waitFor(page, (m) => m.method === 'confirmGatedInsert');
    // While the prompt is open the document changes under it (the host's text wins over typing not yet sent).
    await fromHost(page, { kind: 'event', name: 'externalChange', data: { text: `${TEXT}\nAdded outside.\n`, version: 5 } });
    await expect(editor(page)).not.toContainText('/lettered');
    await fromHost(page, { kind: 'response', id: ask.id, ok: true, result: 'add' });
    await quiet(page);
    const all = await sent(page);
    expect(all.filter((m) => m.method === 'applyEdits')).toEqual([]);
    await expect(page.locator('.pmd-canvas ol')).toHaveCount(0);
  });
});
