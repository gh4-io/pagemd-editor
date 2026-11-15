// fix-sync-bugs (session 33): the canvas and the Code view against a pretend VS Code that behaves as the real one does with a
// file's line ending: every line break an edit inserts becomes the file's own ('\r\n' on Windows), and when that makes the text
// differ from what the webview sent, the change is reported back as an outside change (before the answer, as VS Code does).
// Bug 7: Backspace on an empty `>` line in a callout in Code view duplicated text, and every later key made it worse.
// Bug 5: on a blank file, "# hello world" and Enter put the cursor back in the title (the canvas was read again under it).
// Each action must be ONE write to the document, nothing may come back, and the texts must stay the same on both sides.
// Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { frames } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const HINTS = { required: [], shownOnPage: [], profileFields: [], defaults: {} };
type Eol = '\n' | '\r\n';
const EOLS: [string, Eol][] = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
];

/** The user's document (bug 7): lines 7 and 9 end in three spaces, line 8 is a bare `>`. */
const CALLOUT = ['# Hello World', '', 'hello world', '', '> [!NOTE]', '>', '>   ', '>', '>   ', '', 'test test test', '', '> Note', '>', '> quote this', ''];

type Edit = { from: number; to: number; text: string };
const codeText = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { code?: { text: string } } }).__pmd.code?.text ?? null);
const canvasState = (page: Page) =>
  page.evaluate(() => {
    const view = (window as unknown as { __pmd: { canvas: { view: { state: { doc: { forEach(f: (n: { type: { name: string }; textContent: string }) => void): void }; selection: { $head: { index(depth: number): number } } } } } } }).__pmd.canvas.view;
    const blocks: string[] = [];
    view.state.doc.forEach((n) => blocks.push(`${n.type.name}:${n.textContent}`));
    return { blocks, cursorBlock: view.state.selection.$head.index(0) };
  });

function apply(text: string, list: readonly Edit[]): string {
  let out = '';
  let at = 0;
  for (const e of list) {
    out += text.slice(at, e.from) + e.text;
    at = e.to;
  }
  return out + text.slice(at);
}

/** A pretend VS Code for one document: answers every applyEdits the way HostDocumentSync does in the real one. */
class Host {
  answered = 0;
  version = 1;
  /** Every applyEdits that changed the text (a write to the document). */
  writes: Edit[][] = [];
  /** Outside changes it reported because it changed the webview's edit (its line breaks). */
  echoes = 0;
  constructor(
    readonly page: Page,
    public text: string,
    readonly eol: Eol,
  ) {}

  /** Answers requests for `ms` milliseconds. */
  async run(ms: number): Promise<this> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const requests = (await sent(this.page)).filter((m) => m.method === 'applyEdits');
      for (; this.answered < requests.length; this.answered++) {
        const r = requests[this.answered]!;
        const { edits, version } = r.params as { edits: Edit[]; version: number };
        if (version !== this.version) {
          await fromHost(this.page, { kind: 'response', id: r.id, ok: true, result: { status: 'stale', text: this.text, version: this.version, eol: this.eol } });
          continue;
        }
        if (edits.length > 0) {
          const sentText = apply(this.text, edits);
          // VS Code turns every inserted line break into the document's own.
          this.text = apply(this.text, edits.map((e) => ({ ...e, text: e.text.replace(/\r\n|\r|\n/g, this.eol) })));
          this.version++;
          this.writes.push(edits);
          if (this.text !== sentText) {
            this.echoes++;
            await fromHost(this.page, { kind: 'event', name: 'externalChange', data: { text: this.text, version: this.version, eol: this.eol } });
          }
        }
        await fromHost(this.page, { kind: 'response', id: r.id, ok: true, result: { status: 'ok', version: this.version } });
      }
      await frames(this.page);
    }
    return this;
  }
}

/** Opens `text` in `mode`; the host says the file's line ending unless `tellEol` is false (a host before protocol v11 didn't). */
async function open(page: Page, text: string, mode: string, eol: Eol, tellEol = true): Promise<{ host: Host; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await expect.poll(async () => (await sent(page)).some((m) => m.kind === 'event' && m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text, version: 1, ...(tellEol ? { eol } : {}), fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: HINTS }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
  return { host: new Host(page, text, eol), errors };
}

test.describe('bug 7: Backspace on an empty `>` line in a callout (Code view and Split)', () => {
  for (const mode of ['code', 'split']) {
    for (const [name, eol] of EOLS) {
      test(`${mode}, ${name}: one write per key, the right text, nothing sent back or duplicated`, async ({ page }) => {
        const doc = CALLOUT.join(eol);
        const { host, errors } = await open(page, doc, mode, eol);
        await expect.poll(() => codeText(page)).toBe(doc); // the Code view shows the file exactly, its line endings too
        await page.locator('.cm-line').nth(7).click(); // line 8: the bare `>`
        await page.keyboard.press('End');
        await page.keyboard.press('Backspace');
        const afterBackspace = [...CALLOUT.slice(0, 7), '', ...CALLOUT.slice(8)].join(eol);
        await host.run(1500);
        expect(host.writes).toHaveLength(1);
        expect(host.text).toBe(afterBackspace);
        await page.keyboard.type('x');
        await host.run(1500);
        const afterX = [...CALLOUT.slice(0, 7), 'x', ...CALLOUT.slice(8)].join(eol);
        expect(host.writes).toHaveLength(2);
        expect(host.text).toBe(afterX);
        expect(host.echoes).toBe(0);
        expect(await codeText(page)).toBe(afterX);
        expect(errors).toEqual([]);
      });
    }
  }

  test('a host that doesn’t say the line ending (blank CRLF file): VS Code’s text wins, nothing is duplicated', async ({ page }) => {
    // The webview can't tell the line ending of a blank file; VS Code changes its '\n' to '\r\n' and reports it. The Code view and
    // the canvas must then take VS Code's text, not the text they expected (before the fix they overwrote it, and every later key
    // went to the wrong place).
    const { host } = await open(page, '', 'code', '\r\n', false);
    await page.locator('.cm-content').click();
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await host.run(1500);
    expect(host.text).toBe('a\r\nb');
    await expect.poll(() => codeText(page)).toBe('a\r\nb');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c');
    await host.run(1500);
    expect(host.text).toBe('a\r\nb\r\nc');
    expect(await codeText(page)).toBe('a\r\nb\r\nc');
    expect(host.writes).toHaveLength(2);
  });
});

test.describe('bug 5: a blank file, "# hello world" and Enter (Print Layout, Web Layout, Draft)', () => {
  for (const mode of ['print', 'web', 'draft']) {
    for (const [name, eol] of EOLS) {
      test(`${mode}, ${name}: the cursor leaves the title; one write per pause; nothing comes back`, async ({ page }) => {
        const { host, errors } = await open(page, '', mode, eol);
        await page.locator('.pmd-canvas .ProseMirror').click();
        await page.keyboard.type('# hello world');
        await host.run(700);
        expect(host.text).toBe('# hello world');
        await page.keyboard.press('Enter');
        await host.run(900); // the pause: Enter's new paragraph is sent
        expect(await canvasState(page)).toEqual({ blocks: ['heading:hello world', 'paragraph:'], cursorBlock: 1 });
        await page.keyboard.type('next line');
        await host.run(900);
        expect(await canvasState(page)).toEqual({ blocks: ['heading:hello world', 'paragraph:next line'], cursorBlock: 1 });
        expect(host.text).toBe(`# hello world${eol}${eol}next line`);
        expect(host.writes).toHaveLength(3);
        expect(host.echoes).toBe(0);
        expect(errors).toEqual([]);
      });
    }
  }
});

test.describe('no action, no write', () => {
  for (const mode of ['print', 'web', 'draft', 'code', 'split']) {
    test(`${mode}, CRLF: opening, clicking and moving the cursor write nothing`, async ({ page }) => {
      const doc = CALLOUT.join('\r\n');
      const { host } = await open(page, doc, mode, '\r\n');
      const target = mode === 'code' || mode === 'split' ? page.locator('.cm-line').nth(6) : page.locator('.pmd-canvas p', { hasText: 'test test test' });
      await target.click();
      for (const key of ['ArrowDown', 'ArrowDown', 'End', 'ArrowUp', 'Home']) await page.keyboard.press(key);
      await host.run(1200);
      expect(host.writes).toEqual([]);
      expect(host.text).toBe(doc);
    });
  }
});
