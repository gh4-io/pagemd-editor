// P12 in a real browser (Chromium) with a pretend host: review comments (ADR-0015, R-178–R-181). A new comment adds exactly one
// anchor line and a thread in the side file; Reply, Resolve, Delete; the lists of orphans; a side file that cannot be read is
// never written; the anchor takes no room on the page. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const DOC = '# Guide\n\nFirst paragraph.\n\nSecond paragraph\nover two lines.\n\n- one\n- two\n\nLast.\n';

type Edit = { from: number; to: number; text: string };

const thread = (id: string, over: Record<string, unknown> = {}) => ({ id, quote: 'quoted', resolved: false, created: '2026-10-05T10:00:00.000Z', comments: [{ author: 'Ann', created: '2026-10-05T10:00:00.000Z', text: `Note ${id}` }], ...over });
const file = (...threads: unknown[]) => ({ version: 1, threads });

/** The pretend host: keeps the text and the side file, answers every request the page sends. */
class Host {
  text: string;
  /** What the side file holds: undefined = no file; an Error = it cannot be read. */
  sidecar: unknown;
  readonly batches: Edit[][] = [];
  readonly writes: unknown[] = [];
  #answered = 0;
  #version = 1;
  constructor(text: string, sidecar?: unknown) {
    this.text = text;
    this.sidecar = sidecar;
  }
  async pump(page: Page): Promise<void> {
    const requests = (await sent(page)).filter((m) => m.kind === 'request');
    for (; this.#answered < requests.length; this.#answered++) {
      const request = requests[this.#answered]!;
      if (request.method === 'applyEdits') {
        const edits = (request.params as { edits: Edit[] }).edits;
        this.batches.push(edits);
        let out = '';
        let at = 0;
        for (const e of edits) {
          out += this.text.slice(at, e.from) + e.text;
          at = e.to;
        }
        this.text = out + this.text.slice(at);
        await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: ++this.#version } });
      } else if (request.method === 'readSidecar') {
        if (this.sidecar instanceof Error) await fromHost(page, { kind: 'response', id: request.id, ok: false, error: this.sidecar.message });
        else await fromHost(page, { kind: 'response', id: request.id, ok: true, result: this.sidecar ?? null });
      } else if (request.method === 'writeSidecar') {
        this.sidecar = (request.params as { data: unknown }).data;
        this.writes.push(this.sidecar);
        await fromHost(page, { kind: 'response', id: request.id, ok: true, result: null });
      }
    }
  }
  /** Keeps answering until `check` holds. */
  async until(page: Page, check: (host: Host) => boolean | Promise<boolean>): Promise<void> {
    await expect.poll(async () => (await this.pump(page), await check(this))).toBe(true);
  }
}

async function open(page: Page, host: Host, options: { mode?: string; panel?: boolean } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await expect.poll(async () => (await sent(page)).some((m) => m.kind === 'event' && m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: host.text, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (options.mode) await fromHost(page, { kind: 'event', name: 'setView', data: { mode: options.mode } });
  await host.until(page, async () => (await sent(page)).some((m) => m.method === 'readSidecar'));
  if (options.panel !== false) await page.evaluate(() => (window as unknown as { __pmd: { view: { set(c: unknown): void } } }).__pmd.view.set({ panels: { comments: true } }));
  return errors;
}

const canvas = (page: Page) => page.locator('.pmd-canvas .ProseMirror');
const panel = (page: Page) => page.locator('.pmd-comments');
const card = (page: Page, id: string) => panel(page).locator(`[data-thread="${id}"]`);
const ribbonButton = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const caretIn = async (page: Page, text: string) => {
  await canvas(page).getByText(text, { exact: false }).first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $from: { parent: { textContent: string } } } } } } } }).__pmd.canvas.view.state.selection.$from.parent.textContent)).toContain(text);
};
const reviewTab = (page: Page) => page.locator('.pmd-ribbon').getByRole('tab', { name: 'Review', exact: true }).click();

test.describe('a new comment', () => {
  test('adds exactly one anchor line above the block and one thread to the side file', async ({ page }) => {
    const host = new Host(DOC);
    const errors = await open(page, host, { panel: false });
    await caretIn(page, 'First paragraph');
    await reviewTab(page);
    await ribbonButton(page, 'comments.new').click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('.pmd-comments-compose')).toBeVisible();
    await expect(panel(page).locator('.pmd-comments-compose textarea')).toBeFocused();
    await page.keyboard.type('Please check this.');
    await panel(page).getByRole('button', { name: 'Comment', exact: true }).click();
    await host.until(page, (h) => h.writes.length === 1 && h.batches.length === 1);
    // the document: exactly one new line
    expect(host.text).toBe(DOC.replace('First paragraph.', '<!-- ::COMMENT id="c1" -->\nFirst paragraph.'));
    expect(host.batches[0]).toEqual([{ from: 9, to: 9, text: '<!-- ::COMMENT id="c1" -->\n' }]);
    expect(host.text.split('\n').length - DOC.split('\n').length).toBe(1);
    // the side file
    expect(host.sidecar).toEqual({
      version: 1,
      threads: [{ id: 'c1', quote: 'First paragraph.', resolved: false, created: expect.any(String), comments: [{ author: 'Test Author', created: expect.any(String), text: 'Please check this.' }] }],
    });
    // the page: the thread in the panel, the block tinted, a flag, and the compose box closed
    await expect(card(page, 'c1')).toContainText('Please check this.');
    await expect(card(page, 'c1')).toContainText('“First paragraph.”');
    await expect(canvas(page).locator('p.pmd-commented')).toHaveText('First paragraph.');
    await expect(canvas(page).locator('.pmd-comment-flag')).toHaveText('c1');
    await expect(panel(page).locator('.pmd-comments-compose')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('the second comment gets the next id, a list is commented as one block, and selected words are the quote', async ({ page }) => {
    const host = new Host('# Guide\n\n<!-- ::COMMENT id="c1" -->\nFirst paragraph.\n\n- one\n- two\n\nLast.\n', file(thread('c1')));
    await open(page, host);
    await caretIn(page, 'two');
    await panel(page).getByRole('button', { name: 'New comment' }).click();
    await page.keyboard.type('About the list');
    await page.keyboard.press('Control+Enter');
    await host.until(page, (h) => h.writes.length === 1 && h.batches.length === 1);
    expect(host.text).toBe('# Guide\n\n<!-- ::COMMENT id="c1" -->\nFirst paragraph.\n\n<!-- ::COMMENT id="c2" -->\n- one\n- two\n\nLast.\n');
    expect((host.sidecar as { threads: { id: string; quote: string }[] }).threads.map((t) => [t.id, t.quote])).toEqual([['c1', 'quoted'], ['c2', 'one two']]);
    await expect(canvas(page).locator('ul.pmd-commented')).toHaveCount(1);
  });

  test('the quote is the selected text when there is a selection', async ({ page }) => {
    const host = new Host(DOC);
    await open(page, host);
    await caretIn(page, 'First paragraph');
    await page.keyboard.press('Home');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight'); // selects "First"
    await expect.poll(() => page.evaluate(() => { const s = (window as unknown as { __pmd: { canvas: { view: { state: { doc: { textBetween(a: number, b: number): string }; selection: { from: number; to: number } } } } } }).__pmd.canvas.view.state; return s.doc.textBetween(s.selection.from, s.selection.to); })).toBe('First');
    await panel(page).getByRole('button', { name: 'New comment' }).click();
    await expect(panel(page).locator('.pmd-comments-compose .pmd-comments-quote')).toHaveText('On: “First”');
    await page.keyboard.type('Word');
    await page.keyboard.press('Control+Enter');
    await host.until(page, (h) => h.writes.length === 1);
    expect((host.sidecar as { threads: { quote: string }[] }).threads[0]!.quote).toBe('First');
  });

  test('an empty comment is not sent; Cancel leaves the document alone', async ({ page }) => {
    const host = new Host(DOC);
    await open(page, host);
    await caretIn(page, 'Last.');
    await panel(page).getByRole('button', { name: 'New comment' }).click();
    await panel(page).getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(panel(page).locator('.pmd-comments-error')).toContainText('Write something first');
    await panel(page).getByRole('button', { name: 'Cancel' }).click();
    await quiet(page);
    await host.pump(page);
    expect(host.batches).toHaveLength(0);
    expect(host.writes).toHaveLength(0);
  });
});

test.describe('reply, resolve, delete', () => {
  const TEXT = '# Guide\n\n<!-- ::COMMENT id="c1" -->\nFirst paragraph.\n\nSecond.\n';

  test('Reply adds a message; Resolve hides the thread until "Show resolved"; Reopen brings it back', async ({ page }) => {
    const host = new Host(TEXT, file(thread('c1')));
    await open(page, host);
    await expect(card(page, 'c1')).toContainText('Note c1');
    await card(page, 'c1').locator('textarea').fill('A reply');
    await card(page, 'c1').getByRole('button', { name: 'Reply' }).click();
    await host.until(page, (h) => h.writes.length === 1);
    expect((host.sidecar as { threads: { comments: { author: string; text: string }[] }[] }).threads[0]!.comments.map((m) => [m.author, m.text])).toEqual([['Ann', 'Note c1'], ['Test Author', 'A reply']]);
    await expect(card(page, 'c1')).toContainText('A reply');
    await card(page, 'c1').getByRole('button', { name: 'Resolve' }).click();
    await host.until(page, (h) => h.writes.length === 2);
    expect((host.sidecar as { threads: { resolved: boolean }[] }).threads[0]!.resolved).toBe(true);
    await expect(card(page, 'c1')).toHaveCount(0); // hidden
    await expect(canvas(page).locator('p.pmd-commented-resolved')).toHaveCount(1); // quiet tint on the page
    await panel(page).getByLabel('Show resolved').check();
    await expect(card(page, 'c1')).toBeVisible();
    await card(page, 'c1').getByRole('button', { name: 'Reopen' }).click();
    await host.until(page, (h) => h.writes.length === 3);
    expect((host.sidecar as { threads: { resolved: boolean }[] }).threads[0]!.resolved).toBe(false);
    // none of this touched the document
    expect(host.batches).toHaveLength(0);
  });

  test('the Review tab\'s Reply and Resolve act on the thread the cursor is in', async ({ page }) => {
    const host = new Host(TEXT, file(thread('c1')));
    await open(page, host, { panel: false });
    await caretIn(page, 'First paragraph');
    await reviewTab(page);
    await expect(ribbonButton(page, 'comments.resolve')).toBeEnabled();
    await ribbonButton(page, 'comments.reply').click();
    await expect(panel(page)).toBeVisible();
    await expect(card(page, 'c1').locator('textarea')).toBeFocused();
    await ribbonButton(page, 'comments.resolve').click();
    await host.until(page, (h) => h.writes.length === 1 && (h.sidecar as { threads: { resolved: boolean }[] }).threads[0]!.resolved);
  });

  test('Delete removes the thread and its anchor line, in one edit', async ({ page }) => {
    const host = new Host(TEXT, file(thread('c1')));
    await open(page, host);
    await card(page, 'c1').getByRole('button', { name: 'Delete' }).click();
    await host.until(page, (h) => h.writes.length === 1 && h.batches.length === 1);
    expect(host.text).toBe('# Guide\n\nFirst paragraph.\n\nSecond.\n');
    expect(host.batches[0]).toHaveLength(1);
    expect((host.sidecar as { threads: unknown[] }).threads).toEqual([]);
    await expect(card(page, 'c1')).toHaveCount(0);
  });

  test('clicking a card goes to the block; clicking the flag selects the card; Previous and Next step through the threads', async ({ page }) => {
    const text = '# Guide\n\n<!-- ::COMMENT id="c1" -->\nFirst paragraph.\n\nMiddle.\n\n<!-- ::COMMENT id="c2" -->\nLast paragraph.\n';
    const host = new Host(text, file(thread('c1'), thread('c2')));
    await open(page, host, { panel: false });
    await page.evaluate(() => (window as unknown as { __pmd: { view: { set(c: unknown): void } } }).__pmd.view.set({ panels: { comments: true } }));
    await card(page, 'c2').locator('.pmd-comments-top').click();
    await expect(card(page, 'c2')).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $from: { parent: { textContent: string } } } } } } } }).__pmd.canvas.view.state.selection.$from.parent.textContent)).toBe('Last paragraph.');
    await expect(canvas(page).locator('p.pmd-commented-active')).toHaveText('Last paragraph.');
    await canvas(page).locator('.pmd-comment-flag', { hasText: 'c1' }).click();
    await expect(card(page, 'c1')).toHaveAttribute('aria-current', 'true');
    await reviewTab(page);
    await ribbonButton(page, 'comments.next').click();
    await expect(card(page, 'c2')).toHaveAttribute('aria-current', 'true');
    await ribbonButton(page, 'comments.next').click(); // round the end
    await expect(card(page, 'c1')).toHaveAttribute('aria-current', 'true');
    await ribbonButton(page, 'comments.previous').click();
    await expect(card(page, 'c2')).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('orphans (R-181)', () => {
  test('a thread whose anchor is gone, and an anchor with no thread, are listed under "Needs attention"', async ({ page }) => {
    const host = new Host('# Guide\n\n<!-- ::COMMENT id="c9" -->\nFirst paragraph.\n\nSecond.\n', file(thread('c1', { quote: 'lost words' })));
    await open(page, host);
    const attention = panel(page).locator('.pmd-comments-attention');
    await expect(attention).toContainText('Needs attention');
    await expect(attention.locator('[data-thread="c1"]')).toContainText('“lost words”');
    await expect(attention.locator('[data-thread="c1"]')).toContainText('Its place in the text is gone');
    await expect(attention.locator('[data-anchor="0"]')).toContainText('A marker for comment c9 has no thread');
    await expect(panel(page).locator('.pmd-comments-list [data-thread]')).toHaveCount(0);
    expect(host.writes).toHaveLength(0); // looking at them writes nothing
  });

  test('"Re-attach here" puts the anchor above the block at the cursor; "Remove marker" and Delete clean up', async ({ page }) => {
    const host = new Host('# Guide\n\n<!-- ::COMMENT id="c9" -->\nFirst paragraph.\n\nSecond.\n', file(thread('c1')));
    await open(page, host);
    await caretIn(page, 'Second.');
    await panel(page).locator('[data-thread="c1"]').getByRole('button', { name: 'Re-attach here' }).click();
    await host.until(page, (h) => h.batches.length === 1);
    expect(host.text).toBe('# Guide\n\n<!-- ::COMMENT id="c9" -->\nFirst paragraph.\n\n<!-- ::COMMENT id="c1" -->\nSecond.\n');
    await expect(panel(page).locator('.pmd-comments-list [data-thread="c1"]')).toBeVisible();
    await panel(page).locator('[data-anchor]').getByRole('button', { name: 'Remove marker' }).click();
    await host.until(page, (h) => h.batches.length === 2);
    expect(host.text).toBe('# Guide\n\nFirst paragraph.\n\n<!-- ::COMMENT id="c1" -->\nSecond.\n');
    expect(host.writes).toHaveLength(0); // the side file never changed
  });

  test('a thread with no anchor is deleted without touching the text', async ({ page }) => {
    const host = new Host('# Guide\n\nFirst.\n', file(thread('c1')));
    await open(page, host);
    await panel(page).locator('[data-thread="c1"]').getByRole('button', { name: 'Delete' }).click();
    await host.until(page, (h) => h.writes.length === 1);
    expect((host.sidecar as { threads: unknown[] }).threads).toEqual([]);
    expect(host.batches).toHaveLength(0);
  });
});

test.describe('the side file', () => {
  test('until the file is read nothing is called an orphan, and nothing can be added', async ({ page }) => {
    const host = new Host('# Guide\n\n<!-- ::COMMENT id="c1" -->\nFirst paragraph.\n', file(thread('c1')));
    page.on('pageerror', (error) => expect(error.message).toBe(''));
    await page.goto(pageUrl);
    await expect.poll(async () => (await sent(page)).some((m) => m.kind === 'event' && m.name === 'ready')).toBe(true);
    await fromHost(page, {
      kind: 'event',
      name: 'init',
      data: { protocol: PROTOCOL, text: host.text, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' },
    });
    await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
    await page.evaluate(() => (window as unknown as { __pmd: { view: { set(c: unknown): void } } }).__pmd.view.set({ panels: { comments: true } }));
    await expect(panel(page).locator('.pmd-comments-note')).toContainText('Loading comments');
    await expect(panel(page).locator('.pmd-comments-attention')).toBeEmpty(); // the anchor is not "a marker with no thread" yet
    await expect(panel(page).getByRole('button', { name: 'New comment' })).toBeDisabled();
    await host.until(page, async () => (await card(page, 'c1').count()) === 1); // now the file has been read
    await expect(panel(page).locator('.pmd-comments-attention')).toBeEmpty();
  });

  test('a file that cannot be read is left alone: the panel says so, nothing can be added, nothing is written', async ({ page }) => {
    const host = new Host(DOC, new Error('.pagemd/comments/a.json is not valid JSON (Unexpected token)'));
    await open(page, host, { panel: false });
    await caretIn(page, 'First paragraph');
    await reviewTab(page);
    await expect(ribbonButton(page, 'comments.new')).toBeDisabled();
    await page.evaluate(() => (window as unknown as { __pmd: { view: { set(c: unknown): void } } }).__pmd.view.set({ panels: { comments: true } }));
    await expect(panel(page).locator('.pmd-comments-note')).toContainText('could not be read');
    await expect(panel(page).locator('.pmd-comments-note')).toContainText('not valid JSON');
    await expect(panel(page).getByRole('button', { name: 'New comment' })).toBeDisabled();
    await quiet(page);
    await host.pump(page);
    expect(host.writes).toHaveLength(0);
  });

  test('a file in another shape (a newer version) is not understood and not overwritten', async ({ page }) => {
    const host = new Host(DOC, { version: 7, threads: [] });
    await open(page, host);
    await expect(panel(page).locator('.pmd-comments-note')).toContainText('version 7');
    await expect(panel(page).getByRole('button', { name: 'New comment' })).toBeDisabled();
  });

  test('a change on disk (the host says so) is picked up', async ({ page }) => {
    const host = new Host('# Guide\n\n<!-- ::COMMENT id="c1" -->\nFirst paragraph.\n', file(thread('c1')));
    await open(page, host);
    await expect(card(page, 'c1')).toContainText('Note c1');
    host.sidecar = file(thread('c1', { comments: [{ author: 'Bob', created: '2026-10-05T11:00:00.000Z', text: 'From a git checkout' }] }));
    await fromHost(page, { kind: 'event', name: 'sidecarChanged', data: { kind: 'comments' } });
    await host.until(page, async () => (await panel(page).locator('[data-thread="c1"]').textContent())?.includes('From a git checkout') === true);
  });

  test('a failed save keeps the comment on screen and says so', async ({ page }) => {
    const host = new Host('# Guide\n\nFirst paragraph.\n');
    await open(page, host);
    await caretIn(page, 'First paragraph');
    await panel(page).getByRole('button', { name: 'New comment' }).click();
    await page.keyboard.type('Hello');
    await page.keyboard.press('Control+Enter');
    const write = async () => (await sent(page)).find((m) => m.method === 'writeSidecar');
    await expect.poll(async () => !!(await write())).toBe(true);
    await fromHost(page, { kind: 'response', id: (await write())!.id, ok: false, error: 'disk full' });
    await expect(panel(page).locator('.pmd-comments-note')).toContainText('not saved: disk full');
    await expect(card(page, 'c1')).toContainText('Hello');
  });
});

test.describe('where the panel shows', () => {
  test('Read: the threads show, nothing can be changed', async ({ page }) => {
    const host = new Host('# Guide\n\n<!-- ::COMMENT id="c1" -->\nFirst paragraph.\n', file(thread('c1')));
    await open(page, host, { mode: 'read' });
    await expect(panel(page)).toBeVisible();
    await expect(card(page, 'c1')).toContainText('Note c1');
    await expect(card(page, 'c1').getByRole('button')).toHaveCount(0);
    await expect(card(page, 'c1').locator('textarea')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'New comment' })).toBeDisabled();
  });

  test('Code and Print Preview have no panel; Split and Draft do; the choice is remembered', async ({ page }) => {
    const host = new Host(DOC);
    await open(page, host);
    await expect(panel(page)).toBeVisible();
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'code' } });
    await expect(panel(page)).toBeHidden();
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'split' } });
    await expect(panel(page)).toBeVisible();
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Close the Comments panel' }).click();
    await expect(panel(page)).toBeHidden();
    expect(await page.evaluate(() => JSON.stringify((window as unknown as { __pageState: unknown }).__pageState))).toContain('"comments":false');
  });

  test('View ▸ Show has a Comments button that follows the panel', async ({ page }) => {
    const host = new Host(DOC);
    await open(page, host, { panel: false });
    await page.locator('.pmd-ribbon').getByRole('tab', { name: 'View', exact: true }).click();
    await expect(ribbonButton(page, 'view.comments')).toHaveAttribute('aria-pressed', 'false');
    await ribbonButton(page, 'view.comments').click();
    await expect(panel(page)).toBeVisible();
    await expect(ribbonButton(page, 'view.comments')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('the page is unaffected', () => {
  const longText = (anchors: boolean) =>
    Array.from({ length: 40 }, (_, i) => `${anchors ? `<!-- ::COMMENT id="c${i + 1}" -->\n` : ''}Paragraph ${i + 1}. ${'Some words to fill the line. '.repeat(8)}`).join('\n\n') + '\n';
  const pages = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: unknown[] } } } }).__pmd.pagination.layout.pages.length);

  test('forty anchors give the same pages and no height of their own in Print Layout', async ({ page }) => {
    const plain = new Host(longText(false));
    await open(page, plain, { panel: false });
    await expect.poll(() => pages(page)).toBeGreaterThan(2);
    const without = await pages(page);
    const tall = () => page.locator('.pmd-canvas .pmd-pages').evaluate((el) => Math.round(el.getBoundingClientRect().height));
    const heightWithout = await tall();
    await page.reload();
    const anchored = new Host(longText(true));
    await open(page, anchored, { panel: false });
    await expect.poll(() => pages(page)).toBe(without);
    expect(await tall()).toBe(heightWithout); // not a pixel taller
    await expect(page.locator('.pmd-comment-anchor').first()).toHaveCSS('height', '0px');
    const heights = await page.locator('.pmd-comment-anchor').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights).toHaveLength(40);
    expect(Math.max(...heights)).toBe(0);
  });

  test('opening a document with comments writes nothing back (hand-written anchors keep their bytes)', async ({ page }) => {
    const text = '# Guide\n\n<!-- ::COMMENT id="c1" -->\n\nBlank line after it.\n\n<!-- ::COMMENT id="c2" -->\nNo blank line.\n';
    const host = new Host(text, file(thread('c1'), thread('c2')));
    await open(page, host);
    await quiet(page);
    await host.pump(page);
    expect(host.batches).toHaveLength(0);
    expect(host.writes).toHaveLength(0);
  });
});
