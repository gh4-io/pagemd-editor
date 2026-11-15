// P10 in a real browser (Chromium), with the real webview's CSP (webview-csp.html) and a pretend host: Print Preview shows
// pagemd's own page (made here by the built runtime file, as the host makes it) with Paged.js's pages and the diagrams drawn,
// and a script written in the document never runs; the plain-HTML fallback; the Document tab's Export and Profile buttons;
// a save renders the preview again; and diagrams drawn on the canvas in Print Layout (not in Draft), the source shown while
// the cursor is in it. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { quiet } from '../support/quiet.ts';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PagemdRuntime } from '../../packages/output-pagemd/src/index.ts';

const cspPage = pathToFileURL(fileURLToPath(new URL('./webview-csp.html', import.meta.url))).href;
const fixtures = pathToFileURL(fileURLToPath(new URL('./fixtures/', import.meta.url))).href;
const runtimeFile = fileURLToPath(new URL('../../apps/vscode/dist/host/pagemd/runtime.mjs', import.meta.url));
const MERMAID = new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href;
const CHECKOUT = fileURLToPath(new URL('../../../pagemd/', import.meta.url));
const EXAMPLE = `${CHECKOUT}tests/corpus/pagemd/examples/md/01-basic-document.md`;
const NONCE = 'E2eNonce';
const HINTS = { required: [], shownOnPage: [], profileFields: [], defaults: {} };
const PAGEMD = [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }, { id: 'html', label: 'Plain HTML', formats: ['html'] }];
const HTML_ONLY = [{ id: 'html', label: 'Plain HTML', formats: ['html'] }];

const setView = (page: Page, mode: string) => fromHost(page, { kind: 'event', name: 'setView', data: { mode } });

async function requests(page: Page, method: string): Promise<Message[]> {
  return (await sent(page)).filter((m) => m.kind === 'request' && m.method === method);
}

async function open(page: Page, text: string, output = PAGEMD): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(cspPage);
  await expect.poll(async () => (await sent(page)).some((m) => m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: 16, text, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: HINTS }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output, mermaidScript: MERMAID },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  return errors;
}

/** Answers the next `preview` request with `result` (the host's answer). */
async function answerPreview(page: Page, result: unknown, nth = 0): Promise<Message> {
  let request: Message | undefined;
  await expect.poll(async () => (request = (await requests(page, 'preview'))[nth]), { timeout: 5000 }).toBeTruthy();
  await fromHost(page, { kind: 'response', id: request!.id, ok: true, result });
  return request!;
}

let runtime: PagemdRuntime | undefined;
async function pagemdPage(text: string): Promise<{ html: string; colorScheme: string }> {
  runtime ??= ((await import(pathToFileURL(runtimeFile).href)) as { runtime: PagemdRuntime }).runtime;
  const { mermaidRunner } = await import('../../packages/output-pagemd/src/preview-page.ts');
  const { MERMAID_CONFIG } = await import('../../packages/preset-pagemd/src/index.ts');
  return runtime.renderForPreview(text, { markdownPath: EXAMPLE, cliPath: CHECKOUT, nonce: NONCE, beforePolyfill: mermaidRunner(NONCE, MERMAID, MERMAID_CONFIG) });
}

const previewState = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pmd: { preview: { state: { busy: boolean; pages: number | null; diagrams: number | null }; frame: HTMLIFrameElement } } };
    const frame = w.__pmd.preview.frame.contentWindow as (Window & { __pmdDocumentScript?: boolean }) | null;
    return { ...w.__pmd.preview.state, documentScriptRan: frame?.__pmdDocumentScript === true, svgs: w.__pmd.preview.frame.contentDocument?.querySelectorAll('figure.mermaid-diagram svg').length ?? 0 };
  });

test.describe('Print Preview (P10)', () => {
  test.skip(!existsSync(runtimeFile), 'needs the pagemd checkout (the runtime file is built from it)');

  test("shows pagemd's page with Paged.js's pages and the diagrams drawn; the document's own scripts never run", async ({ page }) => {
    const text = `${readFileSync(EXAMPLE, 'utf8')}\n\n\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\`\n\n<script>window.__pmdDocumentScript = true;</script>\n\n<img src="nowhere.png" onerror="window.__pmdDocumentScript = true">\n`;
    const errors = await open(page, text);
    await setView(page, 'preview');
    await expect(page.locator('.pmd-preview')).toBeVisible();
    await expect(page.locator('.pmd-canvas')).toBeHidden();
    const request = await requests(page, 'preview').then((r) => r[0]);
    await expect.poll(async () => (await requests(page, 'preview')).length).toBe(1);
    expect((request?.params ?? (await requests(page, 'preview'))[0]!.params) as { nonce: string }).toEqual({ nonce: NONCE });
    const made = await pagemdPage(text);
    await answerPreview(page, { html: made.html, provider: 'pagemd', colorScheme: made.colorScheme });
    await expect.poll(async () => (await previewState(page)).busy, { timeout: 30000 }).toBe(false);
    const state = await previewState(page);
    // 01-basic-document is 4 pages in pagemd's PDF; one diagram (a page more at most).
    expect(state.pages).toBeGreaterThanOrEqual(4);
    expect(state.pages).toBeLessThanOrEqual(5);
    expect(state.diagrams).toBe(1);
    expect(state.svgs).toBe(1);
    expect(state.documentScriptRan).toBe(false);
    await expect(page.locator('.pmd-preview-status')).toHaveText(/^\d+ pages$/);
    // the status bar says Print Preview; nothing is editable
    await expect(page.locator('.pmd-status-bar')).toContainText('Print Preview');
    expect(errors).toEqual([]);
  });

  test('a link to a heading on the same page (a contents entry) jumps inside the preview and leaves the frame alone', async ({ page }) => {
    const text = '---\ntoc: true\ntoc_min_level: 1\n---\n# Book\n\n# Chapter\n\nText.\n\n# Appendix A {#appendix-a .appendix}\n\nBack matter.\n';
    const errors = await open(page, text);
    await setView(page, 'preview');
    const made = await pagemdPage(text);
    await answerPreview(page, { html: made.html, provider: 'pagemd', colorScheme: made.colorScheme });
    await expect.poll(async () => (await previewState(page)).busy, { timeout: 30000 }).toBe(false);
    const before = await previewState(page);
    const frame = page.frameLocator('.pmd-preview-frame');
    await frame.locator('a[href="#appendix-a"]').first().click();
    await quiet(page);
    // still the same page: same address (a srcdoc frame has none), Paged.js's pages still there, status unchanged, no error
    expect(await page.evaluate(() => (document.querySelector('.pmd-preview-frame') as HTMLIFrameElement).contentWindow?.location.href)).toBe('about:srcdoc');
    expect(await frame.locator('.pagedjs_page').count()).toBe(before.pages);
    await expect(page.locator('.pmd-preview-status')).toHaveText(/^\d+ pages?$/);
    expect(errors).toEqual([]);
  });

  test('a save renders it again while it shows; Refresh does too', async ({ page }) => {
    await open(page, '# A\n');
    await setView(page, 'preview');
    await answerPreview(page, { html: '<!doctype html><p>one</p>', provider: 'html', colorScheme: 'light', message: 'test' }, 0);
    await fromHost(page, { kind: 'event', name: 'saved', data: {} });
    await answerPreview(page, { html: '<!doctype html><p>two</p>', provider: 'html', colorScheme: 'light' }, 1);
    await expect(page.frameLocator('.pmd-preview-frame').locator('p')).toHaveText('two');
    await page.locator('.pmd-preview-bar button', { hasText: 'Refresh' }).click();
    await answerPreview(page, { html: '<!doctype html><p>three</p>', provider: 'html', colorScheme: 'light' }, 2);
    await expect(page.frameLocator('.pmd-preview-frame').locator('p')).toHaveText('three');
    // Leaving the preview: a save no longer asks.
    await setView(page, 'print');
    await fromHost(page, { kind: 'event', name: 'saved', data: {} });
    await quiet(page);
    expect(await requests(page, 'preview')).toHaveLength(3);
    await expect(page.locator('.pmd-canvas')).toBeVisible();
  });

  test('the plain-HTML fallback says why, and counts no pages', async ({ page }) => {
    await open(page, '# A\n', HTML_ONLY);
    await setView(page, 'preview');
    await answerPreview(page, { html: '<!doctype html><div class="pmd-canvas"><h1>A</h1></div>', provider: 'html', colorScheme: 'light', message: "pagemd's renderer is not built" });
    await expect(page.locator('.pmd-preview-status')).toHaveText("Plain HTML · pagemd's renderer is not built");
    await expect(page.frameLocator('.pmd-preview-frame').locator('h1')).toHaveText('A');
  });
});

// FIX-preview: a preview that stops must say so. Before, "Rendering…" stayed for good when the host never answered or the page
// never finished loading, and a layout that failed or never finished ended with an empty status.
test.describe('Print Preview never hangs silently (FIX-preview)', () => {
  const limit = (page: Page, which: 'request' | 'load' | 'layout', ms: number) =>
    page.evaluate(([w, v]) => {
      const limits = (window as unknown as { __pmd: { preview: { limits?: Record<string, number> } } }).__pmd.preview.limits;
      if (limits) limits[w as string] = v as number;
    }, [which, ms] as const);
  const status = (page: Page) => page.locator('.pmd-preview-status');
  const watched = async (body: string, head = '') => {
    const { previewWatch } = (await import('../../packages/output-pagemd/src/preview-page.ts')) as { previewWatch?: (nonce: string) => string };
    return `<!doctype html><html><head>${previewWatch?.(NONCE) ?? ''}${head}</head><body>${body}</body></html>`;
  };

  test('the host never answers: the status says so', async ({ page }) => {
    await open(page, '# A\n');
    await limit(page, 'request', 400);
    await setView(page, 'preview');
    await expect(status(page)).toHaveText(/^Preview stopped: no answer from the renderer within 0\.4 seconds\./, { timeout: 5000 });
    expect((await previewState(page)).busy).toBe(false);
  });

  test('the page never finishes loading (a picture that never arrives): the status says so', async ({ page }) => {
    await page.route('https://hang.test/**', () => undefined); // never answered
    await open(page, '# A\n');
    await limit(page, 'load', 600);
    await setView(page, 'preview');
    await answerPreview(page, { html: await watched('<img src="https://hang.test/a.png">'), provider: 'pagemd', colorScheme: 'light' });
    await expect(status(page)).toHaveText(/^Preview stopped: the page did not finish loading within 0\.6 seconds \(a picture or a script it asks for never arrived\)\. Use Refresh/, { timeout: 5000 });
  });

  test("the page layout fails: the status gives the page's error at once", async ({ page }) => {
    await open(page, '# A\n');
    await setView(page, 'preview');
    await answerPreview(page, { html: await watched('<p>x</p>', `<script nonce="${NONCE}">Promise.reject(new Error('Paged.js broke'));</script>`), provider: 'pagemd', colorScheme: 'light' });
    await expect(status(page)).toHaveText('Preview stopped: the page layout failed: Paged.js broke', { timeout: 8000 });
    expect((await previewState(page)).busy).toBe(false);
  });

  test('the page layout never finishes: the status says so', async ({ page }) => {
    await open(page, '# A\n');
    await limit(page, 'layout', 600);
    await setView(page, 'preview');
    await answerPreview(page, { html: await watched('<p>x</p>'), provider: 'pagemd', colorScheme: 'light' });
    await expect(status(page)).toHaveText(/^Preview stopped: the page layout did not finish within 0\.6 seconds\./, { timeout: 5000 });
  });
});

// FIX-PGF (item 1, the user's report: "I select Web, then Preview: stuck in render; Print, then Preview again, does not correct it").
// Not reproduced (see FIX-preview-greyouts-flicker.md). These cover the recovery path: each stage is named in the status, leaving
// Print Preview mid-render leaves nothing behind, and a send of the typing that VS Code never confirms no longer blocks every later
// preview (before, it was the one wait with no end of its own that survived Print → Preview, and it was blamed on the renderer).
test.describe('Web Layout → Print Preview (FIX-PGF)', () => {
  const status = (page: Page) => page.locator('.pmd-preview-status');
  const setLimit = (page: Page, which: string, ms: number) =>
    page.evaluate(([w, v]) => {
      (window as unknown as { __pmd: { preview: { limits: Record<string, number> } } }).__pmd.preview.limits[w as string] = v as number;
    }, [which, ms] as const);
  const html = (text: string) => ({ html: `<!doctype html><p>${text}</p>`, provider: 'html', colorScheme: 'light' });

  test('Web → Preview names the stage while it waits; Web → Print → Preview, left mid-render, starts clean', async ({ page }) => {
    await open(page, '# A\n\nText.\n');
    await setView(page, 'web');
    await setView(page, 'preview');
    await expect(status(page)).toHaveText('Rendering… pagemd is making the page');
    await answerPreview(page, html('one'), 0);
    await expect(page.frameLocator('.pmd-preview-frame').locator('p')).toHaveText('one');
    await expect(status(page)).toHaveText('Plain HTML');
    // Web → Print → Preview, and Print Layout again before the answer comes: nothing is left "busy".
    await setView(page, 'web');
    await setView(page, 'print');
    await setView(page, 'preview');
    await expect.poll(async () => (await requests(page, 'preview')).length).toBe(2);
    await setView(page, 'print');
    expect((await previewState(page)).busy).toBe(false);
    await setView(page, 'preview');
    await expect.poll(async () => (await requests(page, 'preview')).length).toBe(3);
    await answerPreview(page, html('late'), 1); // the left attempt's answer arrives late: dropped
    await answerPreview(page, html('three'), 2);
    await expect(page.frameLocator('.pmd-preview-frame').locator('p')).toHaveText('three');
    await expect(status(page)).toHaveText('Plain HTML');
  });

  test('typing in Web Layout that VS Code never confirms: Preview still renders, says so, and Print → Preview works again', async ({ page }) => {
    await open(page, '# A\n\nText.\n');
    await setView(page, 'web');
    await page.locator('.pmd-canvas .ProseMirror p').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' more'); // its applyEdits is never answered by this pretend host
    await setLimit(page, 'send', 400);
    await setView(page, 'preview');
    await expect(status(page)).toHaveText('Rendering… sending your typing to VS Code');
    // Before the fix the renderer was never asked (the preview waited for the send for good), and this failed.
    await answerPreview(page, html('web'), 0);
    await expect(status(page)).toHaveText(/^Plain HTML · Your newest typing had not reached VS Code yet, so it may be missing here\.$/);
    await setView(page, 'print');
    await setView(page, 'preview');
    await answerPreview(page, html('again'), 1);
    await expect(page.frameLocator('.pmd-preview-frame').locator('p')).toHaveText('again');
    expect((await sent(page)).filter((m) => m.name === 'log' && /Print Preview #\d+: send stopped/.test((m.data as { message: string }).message))).toHaveLength(2);
  });
});

test.describe('the Document tab (P10)', () => {
  test('Print Preview, Export PDF / HTML / PNG and Profile run their VS Code commands; P14 filled the Check group', async ({ page }) => {
    await open(page, '# A\n');
    await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Document', exact: true }).click();
    for (const id of ['document.export-pdf', 'document.export-html', 'document.export-png', 'document.preview']) await page.locator(`.pmd-ribbon [data-command="${id}"]`).click();
    const commands = (await sent(page)).filter((m) => m.name === 'runCommand').map((m) => (m.data as { command: string }).command);
    expect(commands).toEqual(['pagemd.exportToPdf', 'pagemd.exportToHtml', 'pagemd.exportToPng', 'pagemd.printPreview']);
    await expect(page.locator('.pmd-ribbon [data-command="document.check"]')).toHaveCount(1);
  });

  test('without pagemd, only HTML can be exported', async ({ page }) => {
    await open(page, '# A\n', HTML_ONLY);
    await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Document', exact: true }).click();
    await expect(page.locator('.pmd-ribbon [data-command="document.export-pdf"]')).toBeDisabled();
    await expect(page.locator('.pmd-ribbon [data-command="document.export-png"]')).toBeDisabled();
    await expect(page.locator('.pmd-ribbon [data-command="document.export-html"]')).toBeEnabled();
  });
});

test.describe('diagrams on the canvas (P10, R-170 Q9)', () => {
  const DOC = '# Flow\n\nBefore.\n\n```mermaid\ngraph TD\n  A[Start] --> B[Middle] --> C[End]\n```\n\nAfter.\n';
  const block = (page: Page) => page.locator('.pmd-canvas .pmd-diagram-block');

  test('Print Layout draws it in place of its code, and lays the pages out again; a click shows the source', async ({ page }) => {
    const errors = await open(page, DOC);
    await expect(block(page)).toHaveAttribute('data-state', 'drawn', { timeout: 15000 });
    await expect(block(page).locator('svg')).toHaveCount(1);
    await expect(block(page).locator('pre')).toBeHidden();
    // pagination measured the drawing (it ran after it was drawn)
    const drawnHeight = await block(page).evaluate((el) => el.getBoundingClientRect().height);
    expect(drawnHeight).toBeGreaterThan(100);
    await block(page).locator('.pmd-diagram-drawing').click();
    await expect(block(page)).toHaveClass(/pmd-diagram-editing/);
    await expect(block(page).locator('pre')).toBeVisible();
    // typing in the source draws it again
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.type(' --> D[Extra]');
    await expect.poll(async () => block(page).locator('svg').evaluate((svg) => svg.textContent ?? ''), { timeout: 10000 }).toContain('Extra');
    expect(errors).toEqual([]);
  });

  test('Draft shows the source only; Web Layout and Read draw', async ({ page }) => {
    await open(page, DOC);
    await setView(page, 'draft');
    await expect(block(page).locator('pre')).toBeVisible();
    await expect(block(page).locator('.pmd-diagram-drawing')).toBeHidden();
    await setView(page, 'web');
    await expect(block(page).locator('.pmd-diagram-drawing svg')).toBeVisible({ timeout: 15000 });
    await setView(page, 'read');
    await expect(block(page).locator('.pmd-diagram-drawing svg')).toBeVisible();
  });

  test('a broken diagram shows its source and why', async ({ page }) => {
    await open(page, '# X\n\n```mermaid\nthis is not ((( a diagram\n```\n');
    await expect(block(page)).toHaveAttribute('data-state', 'error', { timeout: 15000 });
    await expect(block(page).locator('pre')).toBeVisible();
    await expect(block(page).locator('.pmd-diagram-drawing')).toContainText('Diagram not drawn');
  });
});
