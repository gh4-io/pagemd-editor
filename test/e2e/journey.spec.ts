// P13 (amendment 6): one document through every view: Print Layout, Web Layout, Draft, Read, Code and Split, with an edit in each
// (Read can only look), the pretend host answering every save; the text the host ends with is checked once, at the end. It
// covers what no single-phase spec does: an edit made in one view is what the next view shows, and nothing is lost or
// echoed between them. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const DOC = ['---', 'title: Journey', '---', '', 'Intro paragraph.', '', '# Alpha', '', 'Alpha text.', '', '## Alpha one', '', 'Second-level text.', '', '# Beta', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '# Gamma', '', 'Gamma text.', '', 'Final words.', ''].join('\n');

type Edit = { from: number; to: number; text: string };
const setView = (page: Page, mode: string) => fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
const typeInCanvas = (page: Page, block: number, text: string) => page.evaluate(([b, t]) => (window as unknown as { __pmd: { canvas: { typeAtEndOfBlock(i: number, t: string): void } } }).__pmd.canvas.typeAtEndOfBlock(b as number, t as string), [block, text]);
const codeText = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { code?: { text: string } } }).__pmd.code?.text ?? null);

function apply(text: string, list: Edit[]): string {
  let out = '';
  let at = 0;
  for (const e of list) {
    out += text.slice(at, e.from) + e.text;
    at = e.to;
  }
  return out + text.slice(at);
}

/** The pretend host: answers every applyEdits as VS Code does and keeps the text it now has. */
function host(page: Page) {
  let current = DOC;
  let answered = 0;
  const pump = async () => {
    const requests = (await sent(page)).filter((m) => m.method === 'applyEdits');
    for (; answered < requests.length; answered++) {
      const request = requests[answered]!;
      current = apply(current, (request.params as { edits: Edit[] }).edits);
      await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: answered + 2 } });
    }
    return answered;
  };
  return {
    text: () => current,
    /** Waits until the host has answered `count` saves in all. */
    saves: async (count: number) => expect.poll(pump, { timeout: 8000 }).toBe(count),
    count: pump,
  };
}

test('one document through Print, Web, Draft, Read, Code and Split: an edit in each, all saved, nothing echoed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await expect.poll(async () => (await sent(page)).some((m) => m.kind === 'event' && m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: DOC, version: 1, fileName: 'journey.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  const canvas = page.locator('.pmd-canvas .ProseMirror');
  const pretendHost = host(page);

  // Print Layout (the default view): an edit.
  await expect(page.locator('.pmd-page-gap, .pmd-canvas').first()).toBeVisible();
  await typeInCanvas(page, 1, ' PRINT');
  await pretendHost.saves(1);
  await expect(canvas).toContainText('Intro paragraph. PRINT');

  // Web Layout: the earlier edit is there; another edit.
  await setView(page, 'web');
  await expect(canvas).toContainText('Intro paragraph. PRINT');
  await typeInCanvas(page, 3, ' WEB');
  await pretendHost.saves(2);

  // Draft.
  await setView(page, 'draft');
  await expect(canvas).toContainText('Alpha text. WEB');
  await typeInCanvas(page, 5, ' DRAFT');
  await pretendHost.saves(3);

  // Read: shows everything so far; it can't be edited, and looking sends nothing.
  await setView(page, 'read');
  await expect(canvas).toContainText('Second-level text. DRAFT');
  await expect(canvas).toHaveAttribute('contenteditable', 'false');
  await quiet(page);
  expect(await pretendHost.count()).toBe(3);

  // Code: the source has every edit so far; typing in it reaches the host as one edit and the canvas reads it.
  await setView(page, 'code');
  await expect.poll(() => codeText(page)).toBe(pretendHost.text());
  await page.locator('.cm-line', { hasText: 'Gamma text.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' CODE');
  await pretendHost.saves(4);

  // Split: both sides show everything; an edit on the canvas side reaches the code side.
  await setView(page, 'split');
  await expect(page.locator('.pmd-code .cm-editor')).toBeVisible();
  await expect(canvas).toContainText('Gamma text. CODE');
  await typeInCanvas(page, 10, ' SPLIT');
  await pretendHost.saves(5);
  await expect.poll(() => codeText(page)).toBe(pretendHost.text());

  // Back to Print Layout: the document is the sum of every edit, and nothing else was sent.
  await setView(page, 'print');
  await expect(canvas).toContainText('Final words. SPLIT');
  await quiet(page);
  expect(await pretendHost.count()).toBe(5);
  expect(pretendHost.text()).toBe(
    DOC.replace('Intro paragraph.', 'Intro paragraph. PRINT').replace('Alpha text.', 'Alpha text. WEB').replace('Second-level text.', 'Second-level text. DRAFT').replace('Gamma text.', 'Gamma text. CODE').replace('Final words.', 'Final words. SPLIT'),
  );
  expect(errors).toEqual([]);
});
