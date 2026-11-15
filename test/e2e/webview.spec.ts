// The webview bundle in a real browser (Chromium) with a pretend host (webview.html): open, type, edits sent,
// flush, outside changes, images (C1), links, and undo after pending typing. The real VS Code round trip
// (save → git diff, dirty mark, VS Code's undo) is in test/vscode. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
/** Plain styles (protocol v2): what a document without a pagemd profile gets. */
const PLAIN = { styles: null, gateDefaults: {}, notes: [] };

const TEXT = '# Title\n\nFirst para.\n\nSecond para with a [link](other.md).\n\n![shown](pic.png) ![gone](missing.png)\n';



/** Waits for the webview to send a message matching `match`, and returns it. */
async function waitFor(page: Page, match: (m: Message) => boolean): Promise<Message> {
  let found: Message | undefined;
  await expect.poll(async () => (found = (await sent(page)).find(match)), { timeout: 5000 }).toBeTruthy();
  return found!;
}

async function open(page: Page, text = TEXT, extra: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
  await fromHost(page, { kind: 'event', name: 'init', data: { protocol: PROTOCOL, text, version: 1, fileName: 'a.md', documentBase: fixtures, testing: false, styles: PLAIN, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href, ...extra } });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  return errors;
}

test('opens the document in Print Layout by default (P6, amendment 2), with the status bar', async ({ page }) => {
  const errors = await open(page);
  expect((await sent(page))[0]).toEqual({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL } });
  await expect(page.locator('.pmd-canvas h1')).toHaveText('Title');
  await expect(page.locator('.pmd-canvas p').nth(1)).toHaveText('Second para with a link.');
  const bar = page.locator('.pmd-status-bar');
  await expect(bar.locator('span', { hasText: /^Page 1 of \d+$/ })).toBeVisible();
  await expect(bar.locator('span', { hasText: /^Print Layout$/ })).toBeVisible();
  await expect(bar.locator('.pmd-status-zoom option:checked')).toHaveText('100 %');
  await expect(bar.locator('.pmd-status-arrangement option:checked')).toHaveText('Vertical pages');
  // A document with no profile gets style-default's plain page, itself "the default" (ADR-0014).
  await expect(bar).toContainText('Using default layout');
  await expect(page.locator('.pmd-canvas')).toHaveClass(/pmd-paged/);
  expect(errors).toEqual([]);
});

test('the status bar\'s view name is clickable and opens the view picker (R-132, P6: pagemd.switchView)', async ({ page }) => {
  await open(page);
  const label = page.locator('.pmd-status-bar span', { hasText: /^(Print Layout|Web Layout|Draft|Read)$/ });
  await expect(label).toHaveText('Print Layout');
  await expect(label).toHaveAttribute('role', 'button');
  await label.click();
  const request = await waitFor(page, (m) => m.name === 'runCommand');
  expect(request).toEqual({ kind: 'event', name: 'runCommand', data: { command: 'pagemd.switchView' } });
  // The host answers the picker's choice by sending setView back (EditorProvider.setView), as it would for real.
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
  await expect(label).toHaveText('Draft');
  await expect(page.locator('.pmd-status-zoom')).toHaveCount(0); // Draft has no pages, so no zoom control
  await expect(page.locator('.pmd-canvas')).not.toHaveClass(/pmd-paged/);
});

test('setView (R-132) switches the view and, for a resolved profile, the content CSS', async ({ page }) => {
  const resolved = {
    styles: { css: '.pmd-canvas h1 { color: rgb(1, 2, 3) }', page: { width: 210, height: 297, margins: { top: 25, right: 25, bottom: 25, left: 25 } }, usingDefault: false, sources: [] },
    gateDefaults: {},
    notes: [],
  };
  await open(page, TEXT, { styles: resolved });
  await expect(page.locator('.pmd-canvas h1')).toHaveCSS('color', 'rgb(1, 2, 3)'); // Web Layout: the profile's CSS
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'draft' } });
  await expect(page.locator('.pmd-status-bar')).toContainText('Draft');
  await expect(page.locator('.pmd-canvas h1')).not.toHaveCSS('color', 'rgb(1, 2, 3)'); // Draft: style-default's look
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'web' } });
  await expect(page.locator('.pmd-canvas h1')).toHaveCSS('color', 'rgb(1, 2, 3)');
});

test('a profile not found is shown as a note in the status bar (amendment 9)', async ({ page }) => {
  await open(page, TEXT, { styles: { styles: null, gateDefaults: {}, notes: [{ kind: 'profile-not-found', message: 'Profile not found: x', source: 'x' }] } });
  await expect(page.locator('.pmd-status-bar')).toContainText('Profile not found: x');
});

test('assetsChanged reloads the matching <img> with a cache-busting suffix, leaving others untouched (C9, amendment 11)', async ({ page }) => {
  await open(page);
  const shown = page.locator('.pmd-canvas img[alt="shown"]');
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.complete)).toBe(true);
  await fromHost(page, { kind: 'event', name: 'assetsChanged', data: { paths: ['pic.png'] } });
  await expect.poll(() => shown.getAttribute('src')).toMatch(/^pic\.png\?v=\d+$/);
  const gone = page.locator('.pmd-canvas img[alt="gone"]');
  expect(await gone.getAttribute('src')).toBe('missing.png'); // not in the changed set: untouched
});

test('typing sends one minimal edit after a pause, against the version it was made on', async ({ page }) => {
  await open(page);
  await page.locator('.pmd-canvas p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More');
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  expect(request.params).toEqual({ edits: [{ from: 9, to: 20, text: 'First para. More' }], version: 1 });
  await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: 2 } });

  await page.keyboard.type('!');
  const next = await waitFor(page, (m) => m.method === 'applyEdits' && m.id !== request.id);
  expect(next.params).toEqual({ edits: [{ from: 9, to: 25, text: 'First para. More!' }], version: 2 });
});

test('flush (before save) sends pending edits at once', async ({ page }) => {
  await open(page);
  await page.locator('.pmd-canvas h1').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await fromHost(page, { kind: 'request', id: 500, method: 'flush', params: {} });
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  expect(request.params).toEqual({ edits: [{ from: 0, to: 7, text: '# Title!' }], version: 1 });
  expect((await sent(page)).some((m) => m.kind === 'response' && m.id === 500)).toBe(false); // waits for the host
  await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: 2 } });
  await waitFor(page, (m) => m.kind === 'response' && m.id === 500);
});

test('an outside change is re-read; a stale answer re-reads the host text', async ({ page }) => {
  await open(page);
  await fromHost(page, { kind: 'event', name: 'externalChange', data: { text: '# Changed\n\nNew body.\n', version: 5 } });
  await expect(page.locator('.pmd-canvas h1')).toHaveText('Changed');

  await page.locator('.pmd-canvas p').first().click();
  await page.keyboard.type('x');
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  expect((request.params as { version: number }).version).toBe(5);
  await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'stale', text: '# From host\n', version: 7 } });
  await expect(page.locator('.pmd-canvas h1')).toHaveText('From host');
  await expect(page.locator('.pmd-canvas p')).toHaveCount(0);
});

test("the profile's gate defaults switch gated syntax on, in init and when the styles change (R-124)", async ({ page }) => {
  const errors = await open(page, 'Intro.\n\na. one\nb. two\n');
  await expect(page.locator('.pmd-canvas ol')).toHaveCount(0);
  await page.locator('.pmd-canvas p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  // The profile now sets fancy_lists: the typing is sent first, then the document is read again with the gate on.
  await fromHost(page, { kind: 'event', name: 'stylesChanged', data: { ...PLAIN, gateDefaults: { fancy_lists: true } } });
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  expect(request.params).toEqual({ edits: [{ from: 0, to: 6, text: 'Intro.!' }], version: 1 });
  await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: 2 } });
  await expect(page.locator('.pmd-canvas ol')).toHaveCount(1);
  await expect(page.locator('.pmd-canvas p').first()).toHaveText('Intro.!');
  // The frontmatter still wins over the profile.
  await fromHost(page, { kind: 'event', name: 'externalChange', data: { text: '---\nfancy_lists: false\n---\n\na. one\n', version: 3 } });
  await expect(page.locator('.pmd-canvas ol')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('gate defaults in init apply to the first read (styles are resolved before init)', async ({ page }) => {
  await open(page, 'a. one\nb. two\n', { styles: { ...PLAIN, gateDefaults: { fancy_lists: true } } });
  await expect(page.locator('.pmd-canvas ol li')).toHaveCount(2);
});

test('images resolve against the document folder; ones that fail get a placeholder (C1)', async ({ page }) => {
  await open(page);
  const shown = page.locator('.pmd-canvas img[alt="shown"]');
  const gone = page.locator('.pmd-canvas img[alt="gone"]');
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2);
  await expect(gone).toHaveClass(/pmd-image-missing/);
  await expect(shown).not.toHaveClass(/pmd-image-missing/);
  expect(await shown.getAttribute('src')).toBe('pic.png'); // the document's own text is untouched
});

test('Ctrl+click on a link asks the host to open the href as written; a plain click does not', async ({ page }) => {
  await open(page);
  const link = page.locator('.pmd-canvas a');
  await link.click();
  await link.click({ modifiers: ['Control'] });
  const opened = (await sent(page)).filter((m) => m.name === 'openLink');
  expect(opened).toEqual([{ kind: 'event', name: 'openLink', data: { href: 'other.md' } }]);
  expect(page.url()).toBe(pageUrl);
});

test('undo with typing not yet sent: the typing is sent first, then VS Code is asked to undo', async ({ page }) => {
  await open(page);
  await page.locator('.pmd-canvas h1').click();
  await page.keyboard.press('End');
  await page.keyboard.type('?');
  await page.keyboard.press('Control+z');
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  expect((await sent(page)).some((m) => m.name === 'runCommand')).toBe(false);
  await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: 2 } });
  await waitFor(page, (m) => m.name === 'runCommand');
  expect((await sent(page)).filter((m) => m.name === 'runCommand')).toEqual([{ kind: 'event', name: 'runCommand', data: { command: 'undo' } }]);
});

test('test-only typing is refused unless the host says it runs under the test runner (R-89)', async ({ page }) => {
  await open(page);
  await fromHost(page, { kind: 'request', id: 900, method: 'test:type', params: { text: 'x', block: 0 } });
  const answer = await waitFor(page, (m) => m.kind === 'response' && m.id === 900);
  expect(answer).toMatchObject({ ok: false, error: "No handler for 'test:type'." });
  await expect(page.locator('.pmd-canvas h1')).toHaveText('Title');
});

test('a protocol mismatch shows an error instead of a half-working editor', async ({ page }) => {
  await page.goto(pageUrl);
  await waitFor(page, (m) => m.name === 'ready');
  await fromHost(page, { kind: 'event', name: 'init', data: { protocol: 99, text: '# x\n', version: 1, fileName: 'a.md', documentBase: fixtures, testing: false } });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'error');
  await expect(page.locator('.pmd-error')).toContainText('protocol 99');
});

test('Ctrl+S with typing not yet sent: the typing is sent first, then VS Code is asked to save', async ({ page }) => {
  await open(page);
  await page.locator('.pmd-canvas h1').click();
  await page.keyboard.press('End');
  await page.keyboard.type('.');
  await page.keyboard.press('Control+s');
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  expect((await sent(page)).some((m) => m.name === 'runCommand')).toBe(false);
  await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: 2 } });
  await waitFor(page, (m) => m.name === 'runCommand');
  expect((await sent(page)).filter((m) => m.name === 'runCommand')).toEqual([{ kind: 'event', name: 'runCommand', data: { command: 'save' } }]);
});

test('P3: "## " turns a paragraph into a heading (input rule)', async ({ page }) => {
  await open(page);
  await page.locator('.pmd-canvas p').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.type('## ');
  await expect(page.locator('.pmd-canvas h2').filter({ hasText: 'First para.' })).toHaveCount(1);
});

test('P3: Enter inside a list makes a new item; Tab indents it (list keymap)', async ({ page }) => {
  await open(page, '# Title\n\n- one\n- two\n');
  // Triple-click selects the whole line ("one"); ArrowRight then reliably collapses the cursor to its end —
  // a plain click (or End) can land past short text in a full-width <li>'s empty space.
  await page.locator('.pmd-canvas li', { hasText: 'one' }).click({ clickCount: 3 });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.type('one-b');
  await expect(page.locator('.pmd-canvas li')).toHaveCount(3); // Enter made a new item, not a new paragraph
  await page.keyboard.press('Tab');
  // Tab nests the new item under "one": now found via a list nested inside a list item.
  await expect(page.locator('.pmd-canvas li ul li').filter({ hasText: 'one-b' })).toHaveCount(1);
});

test('P3: a GFM table and strikethrough render in Draft', async ({ page }) => {
  await open(page, '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~\n');
  await expect(page.locator('.pmd-canvas table td')).toHaveCount(2);
  await expect(page.locator('.pmd-canvas s')).toHaveText('gone');
});

test('P3: plugin behaviour (input rules) survives an outside-change re-sync, not just the first document', async ({ page }) => {
  await open(page);
  await fromHost(page, { kind: 'event', name: 'externalChange', data: { text: 'Body text.\n', version: 5 } });
  await expect(page.locator('.pmd-canvas p')).toHaveText('Body text.');
  await page.locator('.pmd-canvas p').click();
  await page.keyboard.press('Home');
  await page.keyboard.type('## ');
  await expect(page.locator('.pmd-canvas h2')).toHaveCount(1);
});

test('P3: an unrecognised construct (frontmatter-style `---`) still opens without error', async ({ page }) => {
  const errors = await open(page, '---\ntitle: Doc\n---\n\n# Body\n');
  expect(errors).toEqual([]);
  await expect(page.locator('.pmd-canvas h1')).toHaveText('Body');
});

test('with nothing pending, Ctrl+Z and Ctrl+S are left to VS Code; leaving the editor sends pending typing', async ({ page }) => {
  await open(page);
  await page.locator('.pmd-canvas h1').click();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  expect((await sent(page)).filter((m) => m.name === 'runCommand')).toEqual([]);

  await page.keyboard.press('End');
  await page.keyboard.type('#');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  expect(request.params).toMatchObject({ edits: [{ from: 0, to: 7 }] });
});

const PAGEMD = [
  '---',
  'fancy_lists: true',
  '---',
  '',
  '# Guide',
  '',
  '<!-- ::TOC levels="2" -->',
  '',
  '## Safety',
  '',
  '[[WARNING]]',
  'Wear gloves.',
  '[[/WARNING]]',
  '',
  '> [!TIP]',
  '> Check twice.',
  '',
  ':::note Remember',
  'Inside the box.',
  ':::',
  '',
  'a. first',
  'b. second',
  '',
  '::: annotated-image pic.png',
  'options:',
  '  caption: "The screen"',
  'markers:',
  '  - { id: 1, x: 25, y: 50, label: "Here" }',
  ':::',
  '',
  '<!-- ::FIGURE src="pic.png" caption="A figure" -->',
  '',
  'See [[Other Page]].',
  '',
].join('\n');

test('P4: pagemd items on the canvas carry the renderer\'s classes; the TOC lists the headings live', async ({ page }) => {
  const errors = await open(page, PAGEMD);
  expect(errors).toEqual([]);
  await expect(page.locator('.pmd-canvas .callout.callout-warning .callout-label')).toHaveText('WARNING');
  await expect(page.locator('.pmd-canvas .markdown-alert.markdown-alert-tip')).toContainText('Check twice.');
  await expect(page.locator('.pmd-canvas .container.container-note')).toHaveAttribute('data-title', 'Remember');
  await expect(page.locator('.pmd-canvas ol[type="a"].list-lower-alpha li')).toHaveCount(2);
  await expect(page.locator('.pmd-canvas a.wikilink')).toHaveText('Other Page');
  // The frontmatter still falls apart into ordinary blocks until P8 (R-85 D), but the TOC never lists them, and it
  // starts at level 2 like pagemd's (R-148): "Guide" (h1) isn't listed.
  await expect(page.locator('.pmd-canvas .toc-placeholder li')).toHaveText(['Safety …']);

  // A new heading shows up in the TOC without reopening (live list). The browser reports a click's selection change
  // a moment later; Enter pressed within that moment (only a script is that fast, with or without pagemd) still acts
  // at the old cursor, so the test waits one frame.
  await page.locator('.pmd-canvas .container-note p').click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Added');
  await expect(page.locator('.pmd-canvas .toc-placeholder li')).toHaveText(['Safety …', 'Added …']);
});

test('P4: annotated images and FIGURE are drawn by pagemd\'s renderer; markers sit on the image (D1, D2, D18)', async ({ page }) => {
  await open(page, PAGEMD);
  const marker = page.locator('.pmd-canvas .annotated-image-container .marker').first();
  await expect(marker).toHaveText('1');
  expect(await marker.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  expect(await page.locator('.pmd-canvas .image-wrapper').first().evaluate((el) => getComputedStyle(el).position)).toBe('relative');
  await expect(page.locator('.pmd-canvas figure img[src="pic.png"]')).toHaveCount(2);
  // One live figure counter over annotated images and FIGUREs, in document order (C9).
  const numbers = await page.locator('.pmd-canvas .fig-num').evaluateAll((els) => els.map((el) => getComputedStyle(el, '::before').content));
  expect(numbers).toEqual(['counter(pmd-figure)', 'counter(pmd-figure)']);
  await expect(page.locator('.pmd-canvas figcaption').last()).toContainText('A figure');
});

test('P4: typing inside a pagemd box sends one minimal edit that rewrites only that box', async ({ page }) => {
  await open(page, PAGEMD);
  await page.locator('.pmd-canvas .container-note p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More');
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  const from = PAGEMD.indexOf(':::note');
  const to = PAGEMD.indexOf(':::\n\na. first') + 3;
  expect(request.params).toEqual({ edits: [{ from, to, text: ':::note Remember\nInside the box. More\n:::' }], version: 1 });
});

test('P4 (R-120): a document that starts with a `---` rule (frontmatter) opens with the cursor in text, not the rule selected; typing at once goes into the text', async ({ page }) => {
  await open(page, '---\ntitle: X\n---\n\nFirst paragraph.\n');
  await expect(page.locator('.ProseMirror')).not.toHaveClass(/ProseMirror-hideselection/);
  await page.keyboard.type('Z');
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  // Before the fix the rule was selected and the first keystroke replaced it. (Until P8 the frontmatter read as a rule and
  // a setext heading, and the typing went into "title: X"; since P8 it is one card, and the typing goes into the text.)
  expect(request.params).toMatchObject({ edits: [{ from: 18, to: 34, text: 'ZFirst paragraph.' }] });
});

test('P4 (R-120): in such a document one click places the cursor', async ({ page }) => {
  await open(page, '---\ntitle: X\n---\n\nFirst paragraph.\n\nSecond paragraph.\n');
  await expect(page.locator('.ProseMirror')).not.toHaveClass(/ProseMirror-hideselection/);
  await page.locator('.pmd-canvas p', { hasText: 'Second paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More');
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  expect(request.params).toMatchObject({ edits: [{ text: 'Second paragraph. More' }] });
});
