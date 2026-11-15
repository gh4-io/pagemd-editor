// P11 in a real browser (Chromium) with a pretend host: a pasted or dropped image becomes a figure in one edit and its
// caption box gets the focus; find and replace on the canvas (visible text only, one edit per change, keys that stay ours).
// Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const DOC = [
  '# Cats and dogs',
  '',
  'The cat sat on the **cat** mat. A concat is not a cat.',
  '',
  '1.  weird  spacing  stays',
  '',
  '<!-- ::PAGEBREAK -->',
  '',
  '<!-- ::FIGURE src="shot.png" caption="Login cat" -->',
  '',
  'Last: one more Cat.',
  '',
].join('\n');

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
    data: { protocol: PROTOCOL, text: options.text ?? DOC, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (options.mode) await fromHost(page, { kind: 'event', name: 'setView', data: { mode: options.mode } });
  return errors;
}

/** Answers every applyEdits as the host does; resolves with the text the host has once it is `expected`. */
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

const canvas = (page: Page) => page.locator('.pmd-canvas .ProseMirror');
const bar = (page: Page) => page.locator('.pmd-find');
const findBox = (page: Page) => bar(page).getByRole('textbox', { name: 'Find' });
const replaceBox = (page: Page) => bar(page).getByRole('textbox', { name: 'Replace' });
const count = (page: Page) => bar(page).locator('.pmd-find-count');

/** The browser's own paste (or drop) event with files, as an author's gesture delivers it. */
async function sendFiles(page: Page, files: { name: string; type?: string }[], how: { drop?: boolean; text?: string; margin?: boolean } = {}): Promise<boolean> {
  return page.evaluate(
    ({ files, how }) => {
      const data = new DataTransfer();
      for (const f of files) data.items.add(new File([new Uint8Array([137, 80, 78, 71])], f.name, { type: f.type ?? 'image/png' }));
      if (how.text !== undefined) data.setData('text/plain', how.text);
      const target = document.querySelector('.pmd-canvas .ProseMirror')!;
      const rect = target.getBoundingClientRect();
      const event = how.drop
        ? new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: how.margin ? rect.left - 30 : rect.left + 50, clientY: how.margin ? rect.top - 30 : rect.top + 20 })
        : new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { files, how },
  );
}

/** Answers the nth writeAsset request with `path` (or an error). */
async function answerWrite(page: Page, nth: number, path: string | { error: string }): Promise<Message> {
  const request = await waitFor(page, (m) => m.method === 'writeAsset', nth);
  await fromHost(page, typeof path === 'string' ? { kind: 'response', id: request.id, ok: true, result: path } : { kind: 'response', id: request.id, ok: false, error: path.error });
  return request;
}

const SMALL = '# Title\n\nBody text.\n\nEnd.\n';

test.describe('image paste and drop (R-174)', () => {
  test('a pasted picture: a timestamp name, the file goes to the host, ONE edit writes the figure, the caption box has the focus', async ({ page }) => {
    const errors = await open(page, { text: SMALL });
    await canvas(page).locator('h1').click(); // the cursor in the heading: the figure goes below it
    expect(await sendFiles(page, [{ name: 'image.png' }])).toBe(true);
    const write = await answerWrite(page, 0, '.pagemd/assets/img/image-20261005-134501.png');
    const params = write.params as { bytes: Uint8Array; name: string };
    expect(params.name).toMatch(/^image-\d{8}-\d{6}\.png$/);
    expect(Array.from(params.bytes)).toEqual([137, 80, 78, 71]);
    const { text, batches } = await hostReaches(page, '# Title\n\n![image-20261005-134501](.pagemd/assets/img/image-20261005-134501.png)\n\nBody text.\n\nEnd.\n', SMALL); // R-254: the readable style is the default
    expect(text).toContain('![image-20261005-134501](.pagemd/assets/img/image-20261005-134501.png)');
    expect(batches).toHaveLength(1); // one insert, one undo step in VS Code
    expect(batches[0]).toHaveLength(1);
    await expect(page.locator('.pmd-inspector')).toBeVisible();
    await expect(page.locator('.pmd-inspector').getByRole('tab', { name: /Element/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.pmd-inspector [data-field="caption"] input')).toBeFocused();
    // the caption typed there is written into the picture's title (and the bare FIGURE marker under it)
    await page.keyboard.type('Login page');
    await page.keyboard.press('Enter');
    await hostReaches(page, '# Title\n\n![image-20261005-134501](.pagemd/assets/img/image-20261005-134501.png "Login page")\n<!-- ::FIGURE -->\n\nBody text.\n\nEnd.\n', SMALL); // (replays every edit the host got)
    expect(errors).toEqual([]);
  });

  test('two dropped files: figures in order, each file under its own name, one edit', async ({ page }) => {
    await open(page, { text: SMALL });
    await canvas(page).locator('h1').click();
    expect(await sendFiles(page, [{ name: 'Login screen.png' }, { name: 'logout.jpg', type: 'image/jpeg' }], { drop: true })).toBe(true);
    await answerWrite(page, 0, '.pagemd/assets/img/Login-screen.png');
    const second = await answerWrite(page, 1, '.pagemd/assets/img/logout.jpg');
    expect((((await sent(page)).filter((m) => m.method === 'writeAsset')[0]!.params) as { name: string }).name).toBe('Login screen.png');
    expect((second.params as { name: string }).name).toBe('logout.jpg');
    const { text, batches } = await hostReaches(page, /!\[Login-screen\]\(\.pagemd\/assets\/img\/Login-screen\.png\)\n\n!\[logout\]\(\.pagemd\/assets\/img\/logout\.jpg\)/, SMALL);
    expect(batches).toHaveLength(1);
    expect(text.split('![')).toHaveLength(3);
  });

  test('a file dropped outside the text (a page margin) is still taken, at the cursor', async ({ page }) => {
    await open(page, { text: SMALL });
    await canvas(page).locator('h1').click();
    expect(
      await page.evaluate(() => {
        const r = document.querySelector('.pmd-canvas .ProseMirror')!.getBoundingClientRect();
        return (window as unknown as { __pmd: { canvas: { view: { posAtCoords(c: { left: number; top: number }): unknown } } } }).__pmd.canvas.view.posAtCoords({ left: r.left - 30, top: r.top - 30 }) ?? null;
      }),
    ).toBeNull(); // (the test means what it says: ProseMirror itself finds no position there)
    await sendFiles(page, [{ name: 'margin.png' }], { drop: true, margin: true });
    await answerWrite(page, 0, '.pagemd/assets/img/margin.png');
    await hostReaches(page, '# Title\n\n![margin](.pagemd/assets/img/margin.png)\n\nBody text.\n\nEnd.\n', SMALL);
  });

  test('a paste with words in it, or a file that is not a picture, is left to the normal paste: nothing is written', async ({ page }) => {
    await open(page, { text: SMALL });
    await canvas(page).click();
    await sendFiles(page, [{ name: 'image.png' }], { text: 'words from a word processor' });
    await sendFiles(page, [{ name: 'a.pdf', type: 'application/pdf' }]);
    await quiet(page);
    expect((await sent(page)).filter((m) => m.method === 'writeAsset')).toHaveLength(0);
  });

  test('in Read (not editable) nothing is written and nothing is sent', async ({ page }) => {
    await open(page, { text: SMALL, mode: 'read' });
    await sendFiles(page, [{ name: 'image.png' }]);
    await sendFiles(page, [{ name: 'image.png' }], { drop: true });
    await quiet(page);
    expect((await sent(page)).filter((m) => m.method === 'writeAsset' || m.method === 'applyEdits')).toHaveLength(0);
  });

  test('when the host cannot save the file, the author is told and the document is untouched', async ({ page }) => {
    await open(page, { text: SMALL });
    await sendFiles(page, [{ name: 'image.png' }]);
    await answerWrite(page, 0, { error: 'disk full' });
    await expect(page.locator('.pmd-status-bar')).toContainText('disk full');
    await quiet(page);
    expect((await sent(page)).filter((m) => m.method === 'applyEdits')).toHaveLength(0);
  });
});

test.describe('find and replace (R-175)', () => {
  test('Ctrl+F opens the bar with the selected word; it counts, highlights, and steps with Enter / Shift+Enter, wrapping', async ({ page }) => {
    await open(page);
    await canvas(page).locator('strong').dblclick(); // selects the bold "cat"
    await expect.poll(() => page.evaluate(() => !(window as unknown as { __pmd: { canvas: { view: { state: { selection: { empty: boolean } } } } } }).__pmd.canvas.view.state.selection.empty)).toBe(true);
    await page.keyboard.press('Control+f');
    await expect(bar(page)).toBeVisible();
    await expect(findBox(page)).toBeFocused();
    await expect(findBox(page)).toHaveValue(/^cat$/i);
    // The visible text only: the paragraph has cat, **cat**, concat and cat; the heading "Cats"; the last line "Cat". The figure's
    // caption "Login cat" lives in a directive, so it does not count.
    await expect(count(page)).toHaveText(/^\d of 6$/);
    await expect(canvas(page).locator('.pmd-find-match')).toHaveCount(6);
    await expect(canvas(page).locator('.pmd-find-current')).toHaveCount(1);
    await expect(canvas(page).locator('.pmd-find-current')).toHaveText(/cat/i);
    const first = await count(page).textContent();
    await findBox(page).press('Enter');
    await expect(count(page)).not.toHaveText(first!);
    await findBox(page).press('Shift+Enter');
    await expect(count(page)).toHaveText(first!);
    for (let i = 0; i < 6; i++) await findBox(page).press('Enter');
    await expect(count(page)).toHaveText(first!); // six steps through six matches: back where it began
  });

  test('markup is not text: ** , a directive and a figure caption are not found; a word split by bold still is', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+f');
    for (const [query, result] of [['**', 'No results'], ['PAGEBREAK', 'No results'], ['Login', 'No results'], ['concat', '1 of 1'], ['sat on the cat mat', '1 of 1'], ['weird  spacing', '1 of 1']] as const) {
      await findBox(page).fill(query);
      await expect(count(page), query).toHaveText(result);
    }
  });

  test('match case and whole word narrow the matches', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+f');
    await findBox(page).fill('cat');
    await expect(count(page)).toHaveText(/of 6$/);
    await bar(page).getByRole('button', { name: 'Match whole word' }).click();
    await expect(count(page)).toHaveText(/of 4$/); // not "concat", not "Cats"
    await bar(page).getByRole('button', { name: 'Match case' }).click();
    await expect(count(page)).toHaveText(/of 3$/); // not "Cat" (the last line)
  });

  test('Esc closes the bar: the highlights go and the canvas has the focus, the match selected', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+f');
    await findBox(page).fill('mat');
    await findBox(page).press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect(canvas(page).locator('.pmd-find-match')).toHaveCount(0);
    await expect(canvas(page)).toBeFocused();
    expect(await page.evaluate(() => String(getSelection())).then((s) => s.trim())).toBe('mat');
  });

  test('Ctrl+H opens the replace row; Replace changes one match as ONE minimal edit and moves on; the rest of the file is the author\'s own bytes', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+h');
    await expect(replaceBox(page)).toBeVisible();
    await findBox(page).fill('concat');
    await replaceBox(page).fill('mess');
    await bar(page).getByRole('button', { name: 'Replace', exact: true }).click();
    const expected = DOC.replace('A concat is', 'A mess is');
    const { text, batches } = await hostReaches(page, expected);
    expect(text).toBe(expected);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1); // only the paragraph that changed
    expect(text).toContain('1.  weird  spacing  stays'); // untouched blocks keep their bytes
  });

  test('Replace all: every match, bold kept, as one batch; only the blocks that changed are written', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+h');
    await findBox(page).fill('cat');
    await bar(page).getByRole('button', { name: 'Match whole word' }).click();
    await replaceBox(page).fill('dog');
    await bar(page).getByRole('button', { name: 'Replace all' }).click();
    const expected = DOC.replace('The cat sat on the **cat** mat. A concat is not a cat.', 'The dog sat on the **dog** mat. A concat is not a dog.').replace('one more Cat.', 'one more dog.');
    const { text, batches } = await hostReaches(page, expected);
    expect(text).toBe(expected);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.length).toBeLessThanOrEqual(2); // the paragraph and the last line, nothing else
  });

  test('an empty replacement deletes the match', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+h');
    await findBox(page).fill(' mat');
    await bar(page).getByRole('button', { name: 'Replace all' }).click();
    await hostReaches(page, DOC.replace('**cat** mat.', '**cat**.'));
  });

  test('the keys stay ours: Ctrl+F and Ctrl+H do not travel on to VS Code from the canvas or from the bar', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __keys: string[] }).__keys = [];
      window.addEventListener('keydown', (e) => (window as unknown as { __keys: string[] }).__keys.push(e.key));
    });
    await canvas(page).click();
    await page.keyboard.press('Control+f');
    await findBox(page).press('Control+h');
    await findBox(page).press('Control+f');
    await findBox(page).press('Escape');
    // (the Control key itself is seen; the letters and Esc are ours and stop at the bar)
    expect((await page.evaluate(() => (window as unknown as { __keys: string[] }).__keys)).filter((k) => k !== 'Control')).toEqual([]);
  });

  test('in Read the bar finds but does not replace', async ({ page }) => {
    await open(page, { mode: 'read' });
    await canvas(page).click();
    await page.keyboard.press('Control+h');
    await expect(bar(page)).toBeVisible();
    await expect(replaceBox(page)).toBeHidden();
    await findBox(page).fill('cat');
    await expect(count(page)).toHaveText(/of 6$/);
  });

  test('Code view keeps VS Code\'s own find: the bar does not open, the key goes on', async ({ page }) => {
    await open(page, { mode: 'code' });
    await page.evaluate(() => {
      (window as unknown as { __keys: string[] }).__keys = [];
      window.addEventListener('keydown', (e) => (window as unknown as { __keys: string[] }).__keys.push(e.key));
    });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+f');
    await expect(bar(page)).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { __keys: string[] }).__keys)).toContain('f');
  });

  test('a drawn diagram\'s source is not searched (Print Layout), but it is in Draft where it shows', async ({ page }) => {
    const text = 'Intro.\n\n```mermaid\ngraph LR\n  A --> B\n```\n';
    await open(page, { text });
    await page.keyboard.press('Control+f');
    await findBox(page).fill('graph');
    await expect(count(page)).toHaveText('No results');
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
    await expect(count(page)).toHaveText(/of 1$/);
  });

  test('the bar goes with the canvas: switching to Code closes it', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+f');
    await expect(bar(page)).toBeVisible();
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'code' } });
    await expect(bar(page)).toBeHidden();
  });

  test('Home ▸ Editing has Find and Replace buttons that open the bar', async ({ page }) => {
    await open(page);
    await page.locator('.pmd-ribbon [data-command="find.replace"]').click();
    await expect(bar(page)).toBeVisible();
    await expect(replaceBox(page)).toBeVisible();
  });
});
