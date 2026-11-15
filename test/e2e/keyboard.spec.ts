// P13b (amendment 8 and 10, acceptance 7): the keyboard-only journey. One run, no mouse event at all (counted in the page):
// open, move to the ribbon with F6, Bold, back to the text, into a table and out, onto a picture and into its shapes, out again,
// the Inspector with the alt text, save. After every step the focus is somewhere real (never `body`). Plus the keys on their own:
// the ribbon's one Tab stop with arrow keys, F6 / Shift+F6 round the regions, Escape out of the ribbon, the live region's words.
// Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Message = { kind: string; id?: number; name?: string; method?: string; params?: { edits?: Edit[] }; data?: { command?: string } };
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __toHost: Message[] }).__toHost);

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const DOC = [
  '# Journey', '', 'First paragraph here.', '', '| A | B |', '|---|---|', '| 1 | 2 |', '',
  '::: annotated-image wide.png', 'markers:', '  - { id: 1, x: 25, y: 50, label: "Left" }', '  - { id: 2, x: 75, y: 50, label: "Right" }', ':::', '',
  '<!-- ::FIGURE src="wide.png" alt="A wide picture" caption="Figure shot" -->', '', 'End.', '',
].join('\n');

type Edit = { from: number; to: number; text: string };

async function open(page: Page, text = DOC, mode?: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Counts every mouse or pointer event the page sees (a click made by the keyboard has no position: `detail` is 0).
  await page.addInitScript(() => {
    (window as unknown as { __mouse: string[] }).__mouse = [];
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick'])
      addEventListener(type, (e) => { if (type.startsWith('pointer') || type.startsWith('mouse') || type === 'dblclick' || (e as MouseEvent).detail > 0) (window as unknown as { __mouse: string[] }).__mouse.push(type); }, true);
  });
  await page.goto(pageUrl);
  await expect.poll(async () => (await sent(page)).some((m) => m.kind === 'event' && m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: '' },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (mode) await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
  return errors;
}

/** Answers every applyEdits as VS Code does and keeps the text the host now has. */
function host(page: Page, start = DOC) {
  let current = start;
  let answered = 0;
  const pump = async () => {
    const requests = (await sent(page)).filter((m) => m.method === 'applyEdits');
    for (; answered < requests.length; answered++) {
      const request = requests[answered]!;
      let out = '';
      let at = 0;
      for (const e of request.params!.edits!) {
        out += current.slice(at, e.from) + e.text;
        at = e.to;
      }
      current = out + current.slice(at);
      await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: answered + 2 } });
    }
    return current;
  };
  return { text: pump, until: async (match: RegExp) => expect.poll(pump, { timeout: 8000 }).toMatch(match) };
}

/** What has the focus, in words (and a failure when it is the page itself). */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return 'BODY';
    const label = el.getAttribute('aria-label') ?? el.getAttribute('data-command') ?? el.textContent?.trim().slice(0, 30) ?? '';
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''} "${label}"`;
  });
const inside = (page: Page, selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);
const said = (page: Page) => page.evaluate(() => document.querySelector('.pmd-announcer')?.textContent ?? '');
/** The text of the block the cursor is in, as ProseMirror knows it (it learns of a keyboard move one browser event later: wait for it). */
const cursorBlock = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $from: { parent: { textContent: string } } } } } } } }).__pmd.canvas.view.state.selection.$from.parent.textContent);
const press = async (page: Page, ...keys: string[]) => {
  for (const key of keys) await page.keyboard.press(key);
};

test('the keyboard-only journey: ribbon, Bold, a table, a picture\'s shapes, the Inspector, save: no mouse, the focus never lost', async ({ page }) => {
  const errors = await open(page);
  const pump = host(page);
  const trail: string[] = [];
  const here = async (step: string) => {
    const where = await focused(page);
    trail.push(`${step}: ${where}`);
    expect(where, `the focus is lost after "${step}" (${trail.join(' | ')})`).not.toBe('BODY');
    return where;
  };

  // 1. open: the text has the focus; select the word "First"
  await here('open');
  expect(await inside(page, '.pmd-canvas')).toBe(true);
  await press(page, 'Control+Home', 'ArrowDown', 'Home', 'Shift+Control+ArrowRight');
  // (ProseMirror learns of a keyboard selection one browser event later)
  await expect.poll(() => page.evaluate(() => { const v = (window as unknown as { __pmd: { canvas: { view: { state: { doc: { textBetween(a: number, b: number): string }; selection: { from: number; to: number } } } } } }).__pmd.canvas.view; return v.state.doc.textBetween(v.state.selection.from, v.state.selection.to).trim(); })).toBe('First');
  await here('select a word');

  // 2. Shift+F6 moves back to the ribbon (its tab; the ribbon is the first region), Tab to the first button, the arrow keys along;
  //    Save is the first button of Home (Quick access: Save, Undo, Redo, AD-FIX-S50-10); Bold comes further along
  await press(page, 'Shift+F6');
  await expect.poll(() => inside(page, '.pmd-ribbon')).toBe(true);
  expect(await focused(page)).toContain('[tab]');
  await expect.poll(() => said(page)).toBe('Ribbon');
  await press(page, 'Tab');
  expect(await focused(page)).toContain('file.save');
  await press(page, 'ArrowRight');
  expect(await focused(page)).toContain('history.undo');
  await press(page, 'ArrowLeft');
  expect(await focused(page)).toContain('file.save');
  await here('in the ribbon');
  // ONE Tab stop for the whole panel (not one per button): the next Tab leaves the ribbon
  const stops = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.pmd-ribbon-panel button')].filter((b) => b.tabIndex === 0 && b.offsetParent !== null).length);
  expect(stops).toBe(1);

  // 3. the arrow keys walk along Home to Bold (bounded); Enter presses Bold; the focus is back in the text, with the word bold
  for (let i = 0; i < 20 && !(await focused(page)).includes('strong.toggle'); i++) await press(page, 'ArrowRight');
  expect(await focused(page)).toContain('strong.toggle');
  await press(page, 'Enter');
  await expect.poll(() => inside(page, '.pmd-canvas')).toBe(true);
  await pump.until(/\*\*First\*\* paragraph here\./);
  await here('Bold');

  // 4. into the table (arrow keys), across it (Tab), and out (arrow past the last cell)
  await press(page, 'ArrowDown');
  await expect.poll(() => cursorBlock(page)).toBe('A');
  expect(await page.evaluate(() => document.querySelectorAll('.pmd-canvas td, .pmd-canvas th').length)).toBe(4);
  for (const cell of ['B', '1', '2']) {
    await press(page, 'Tab'); // along the cells: A, B, 1, 2
    await expect.poll(() => cursorBlock(page)).toBe(cell);
  }
  await here('in the table');
  // (Tab selects a cell's text, and with a range selected ArrowDown moves the browser's own way, over the picture: the arrow key
  // first puts the cursor at the end of the cell, then ArrowDown selects the picture. ProseMirror's rule for atoms.)
  await press(page, 'ArrowRight');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { empty: boolean } } } } } }).__pmd.canvas.view.state.selection.empty)).toBe(true);
  await press(page, 'ArrowDown'); // out of the last cell: onto the picture
  await here('out of the table');

  // 5. the picture: selected by the arrow key (and said), Enter starts its shapes, Tab to the next, an arrow nudges, Delete removes, Escape ends
  await expect.poll(() => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { node?: { type: { name: string } } } } } } } }).__pmd.canvas.view.state.selection.node?.type.name)).toBe('pmd_annotated_image');
  await expect.poll(() => said(page)).toContain('Picture with shapes selected. Press Enter to edit its shapes.');
  await press(page, 'Enter');
  const overlay = page.locator('.pmd-shape-overlay');
  await expect(overlay).toBeFocused();
  await expect(page.locator('.pmd-shape-status')).toHaveText('Marker 1 (Left) selected');
  await press(page, 'Tab');
  await expect(page.locator('.pmd-shape-status')).toHaveText('Marker 2 (Right) selected');
  await press(page, 'ArrowRight');
  await pump.until(/x: 75\.25, y: 50, label: "Right"/);
  await here('nudged a shape');
  await press(page, 'Delete');
  await pump.until(/^(?![\s\S]*label: "Right")[\s\S]*label: "Left"/);
  await press(page, 'Escape');
  await expect(overlay).toBeHidden();
  await expect(page.locator('.pmd-canvas .ProseMirror')).toBeFocused();
  await here('back from the shapes');

  // 6. the figure after it: its alt text is in the Inspector. View > Inspector with the keyboard, then F6 into it, Tab to the alt text.
  await press(page, 'ArrowDown'); // onto the figure
  await expect.poll(() => said(page)).toContain('A wide picture');
  await press(page, 'Shift+F6');
  await expect.poll(() => inside(page, '.pmd-ribbon')).toBe(true);
  await press(page, 'ArrowRight', 'ArrowRight'); // Home, Insert, then Table or Layout... walk to the View tab by name
  for (let i = 0; i < 8 && !((await focused(page)).includes('"View"')); i++) await press(page, 'ArrowRight');
  expect(await focused(page)).toContain('"View"');
  await press(page, 'Tab');
  for (let i = 0; i < 40 && !((await focused(page)).includes('view.inspector')); i++) await press(page, 'ArrowRight');
  expect(await focused(page)).toContain('view.inspector');
  await press(page, 'Enter');
  await expect(page.locator('.pmd-inspector')).toBeVisible();
  await here('Inspector opened');
  await press(page, 'F6');
  await expect.poll(() => inside(page, '.pmd-inspector')).toBe(true);
  await expect.poll(() => said(page)).toBe('Inspector');
  let reached = false;
  for (let i = 0; i < 25 && !reached; i++) {
    await press(page, 'Tab');
    reached = await page.evaluate(() => /\balt\b/i.test(document.activeElement?.closest('[data-field]')?.getAttribute('data-field') ?? ''));
  }
  expect(reached, `the alt text field is not reachable by Tab from the Inspector (${await focused(page)})`).toBe(true);
  await page.keyboard.type('Wide'); // (Tab into a field selects its text: this replaces it)
  await press(page, 'Enter');
  await pump.until(/alt="Wide"/);
  await here('alt text typed');

  // 7. F6 on round the regions and back to the text; then save (Ctrl+S sends the typing, then the host's save)
  await press(page, 'F6');
  await expect.poll(() => inside(page, '.pmd-status-bar')).toBe(true);
  await here('status bar');
  await press(page, 'Shift+F6', 'Shift+F6');
  await expect.poll(() => inside(page, '.pmd-canvas')).toBe(true);
  // (the figure is selected: Chrome's Ctrl+End scrolls instead of moving the caret while the page can still scroll, so the Down arrow goes to the last line first, FIX-ADT)
  await press(page, 'ArrowDown', 'Control+End');
  await expect.poll(() => cursorBlock(page)).toBe('End.'); // (wait until the cursor really is in the last line)
  await page.keyboard.type('!');
  await press(page, 'Control+s');
  await expect.poll(async () => (await pump.text(), (await sent(page)).some((m) => m.name === 'runCommand' && m.data?.command === 'save'))).toBe(true); // (the pretend host answers the typing first)
  expect(await pump.text()).toContain('End.!');
  await here('saved');

  expect(await page.evaluate(() => (window as unknown as { __mouse: string[] }).__mouse)).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe('the keys on their own', () => {
  test('Tab visits the ribbon once, then the text, in screen order; Escape leaves the ribbon for the text', async ({ page }) => {
    await open(page);
    await press(page, 'Shift+F6');
    expect(await focused(page)).toContain('[tab]');
    await press(page, 'Tab');
    expect(await inside(page, '.pmd-ribbon-panel')).toBe(true);
    await press(page, 'Escape');
    await expect.poll(() => inside(page, '.pmd-canvas')).toBe(true);
    // from the text, Shift+Tab goes back to the ribbon's single Tab stop, never to one of its 20 buttons in turn
    await press(page, 'Shift+Tab');
    expect(await inside(page, '.pmd-ribbon-panel')).toBe(true); // the buttons' one Tab stop (not the last of twenty)
    await press(page, 'Shift+Tab');
    expect(await focused(page)).toContain('[tab]');
  });

  test('F6 and Shift+F6 go round the open regions in screen order, and hand the key to VS Code past the ends', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as unknown as { __pmd: { view: { set(v: unknown): void } } }).__pmd.view.set({ panels: { outline: true, inspector: true } }));
    await expect(page.locator('.pmd-outline')).toBeVisible();
    const order: string[] = [];
    await press(page, 'Control+Home');
    for (let i = 0; i < 5; i++) {
      await press(page, 'F6');
      order.push(await page.evaluate(() => ['.pmd-ribbon', '.pmd-outline', '.pmd-canvas', '.pmd-inspector', '.pmd-status-bar'].find((s) => document.activeElement?.closest(s)) ?? 'none'));
    }
    // from the text: the Inspector, then the status bar; then the key is not taken (it goes to VS Code), so the focus stays
    expect(order).toEqual(['.pmd-inspector', '.pmd-status-bar', '.pmd-status-bar', '.pmd-status-bar', '.pmd-status-bar']);
    const defaultPrevented = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(defaultPrevented, 'F6 on the last region must be left to VS Code').toBe(false);
    const backwards: string[] = [];
    for (let i = 0; i < 5; i++) {
      await press(page, 'Shift+F6');
      backwards.push(await page.evaluate(() => ['.pmd-ribbon', '.pmd-outline', '.pmd-canvas', '.pmd-inspector', '.pmd-status-bar'].find((s) => document.activeElement?.closest(s)) ?? 'none'));
    }
    expect(backwards).toEqual(['.pmd-inspector', '.pmd-canvas', '.pmd-outline', '.pmd-ribbon', '.pmd-ribbon']);
  });

  test('F6 gets a keyboard user out of a list and a table, where Tab belongs to the text', async ({ page }) => {
    await open(page, '- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
    await press(page, 'Control+Home', 'End'); // in the list: Tab would indent the item
    await press(page, 'F6');
    expect(await inside(page, '.pmd-canvas')).toBe(false);
    await press(page, 'Shift+F6');
    expect(await inside(page, '.pmd-canvas')).toBe(true);
  });

  test('the canvas is a labelled text box, read-only in Read; the page has a main landmark and a live region', async ({ page }) => {
    await open(page);
    const box = page.getByRole('textbox', { name: 'Document' });
    await expect(box).toHaveAttribute('aria-multiline', 'true');
    await expect(box).toHaveAttribute('aria-readonly', 'false');
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.locator('.pmd-announcer')).toHaveAttribute('aria-live', 'polite');
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'read' } });
    await expect(box).toHaveAttribute('aria-readonly', 'true');
  });

  test('Split view: F6 goes by the screen (code, then page), and from the find bar it still counts as the page', async ({ page }) => {
    await open(page, DOC, 'split');
    await press(page, 'Control+Home');
    await press(page, 'F6');
    await expect.poll(() => inside(page, '.pmd-status-bar')).toBe(true); // the page is after the code pane: next is the status bar
    await press(page, 'Shift+F6');
    await expect.poll(() => inside(page, '.pmd-canvas')).toBe(true);
    await press(page, 'Shift+F6');
    await expect.poll(() => inside(page, '.pmd-split-code')).toBe(true);
    // the find bar is inside the page's pane: F6 from it goes on to the status bar, not back to the ribbon
    await page.locator('.pmd-canvas .ProseMirror').focus();
    await press(page, 'Control+f');
    await expect(page.getByRole('textbox', { name: 'Find' })).toBeFocused();
    await press(page, 'F6');
    await expect.poll(() => inside(page, '.pmd-status-bar')).toBe(true);
  });
});
