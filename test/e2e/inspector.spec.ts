// P8 in a real browser (Chromium) with a pretend host: the Inspector (Element and Document tabs), the properties card,
// the View tab's Inspector button and the Document tab's Properties button, VS Code's icons. Each change must reach the
// host as one minimal edit of only the changed text. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const HINTS = { required: ['title', 'author'], shownOnPage: ['title', 'version'], profileFields: [], defaults: { author: 'TBD' } };
const DOC = [
  '---',
  '# The guide',
  'title: Old title  # keep me',
  'doc_id: X-1',
  '---',
  '',
  '# Heading',
  '',
  'See [the site](https://a.org) now.',
  '',
  '<!-- ::FIGURE src="shot.png" caption="Login" width=half -->',
  '',
  'Last paragraph.',
  '',
].join('\n');

type Edit = { from: number; to: number; text: string };

async function waitFor(page: Page, match: (m: Message) => boolean, nth = 0): Promise<Message> {
  let found: Message | undefined;
  await expect.poll(async () => (found = (await sent(page)).filter(match)[nth]), { timeout: 5000 }).toBeTruthy();
  return found!;
}

async function open(page: Page, options: { text?: string; mode?: string; hints?: object } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: options.text ?? DOC, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: options.hints ?? HINTS }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (options.mode) await fromHost(page, { kind: 'event', name: 'setView', data: { mode: options.mode } });
  return errors;
}

/** The edits of the first applyEdits request, applied to `text`. */
async function savedText(page: Page, text = DOC): Promise<{ text: string; edits: Edit[] }> {
  const request = await waitFor(page, (m) => m.method === 'applyEdits');
  const edits = (request.params as { edits: Edit[] }).edits;
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.from) + e.text;
    at = e.to;
  }
  return { text: out + text.slice(at), edits };
}

/**
 * Answers every applyEdits request as the host would (each one is computed against the text after the one before) and
 * resolves once the text the host has is `expected`.
 */
async function hostReaches(page: Page, expected: string, text = DOC): Promise<void> {
  let current = text;
  let answered = 0;
  await expect
    .poll(
      async () => {
        const requests = (await sent(page)).filter((m) => m.method === 'applyEdits');
        for (; answered < requests.length; answered++) {
          const request = requests[answered]!;
          let out = '';
          let at = 0;
          for (const e of (request.params as { edits: Edit[] }).edits) {
            out += current.slice(at, e.from) + e.text;
            at = e.to;
          }
          current = out + current.slice(at);
          await fromHost(page, { kind: 'response', id: request.id, ok: true, result: { status: 'ok', version: answered + 2 } });
        }
        return current;
      },
      { timeout: 5000 },
    )
    .toBe(expected);
}

const inspector = (page: Page) => page.locator('.pmd-inspector');
const ribbonButton = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const tab = (page: Page, name: string) => page.locator('.pmd-ribbon').getByRole('tab', { name, exact: true });
const field = (page: Page, key: string) => inspector(page).locator(`[data-field="${key}"]`);
const property = (page: Page, key: string) => inspector(page).locator(`[data-property="${key}"]`);

async function openInspector(page: Page) {
  await tab(page, 'View').click();
  await ribbonButton(page, 'view.inspector').click();
  await expect(inspector(page)).toBeVisible();
}

test.describe('the Inspector panel', () => {
  test('closed at first; the View tab opens it, its close button closes it, and the editor tab remembers it', async ({ page }) => {
    const errors = await open(page);
    await expect(inspector(page)).toBeHidden();
    await openInspector(page);
    await expect(ribbonButton(page, 'view.inspector')).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector(page).getByRole('tab')).toHaveText([/Element/, /Document/]);
    await inspector(page).getByRole('button', { name: 'Close the Inspector' }).click();
    await expect(inspector(page)).toBeHidden();
    await expect(ribbonButton(page, 'view.inspector')).toHaveAttribute('aria-pressed', 'false');
    await ribbonButton(page, 'view.inspector').click();
    await page.reload(); // VS Code keeps a webview's state while its tab lives
    await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
    await fromHost(page, { kind: 'event', name: 'init', data: { protocol: PROTOCOL, text: DOC, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: HINTS }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href } });
    await expect(inspector(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Document ▸ Properties opens it on the Document tab', async ({ page }) => {
    await open(page);
    await tab(page, 'Document').click();
    await ribbonButton(page, 'document.properties').click();
    await expect(inspector(page)).toBeVisible();
    await expect(inspector(page).getByRole('tab', { name: /Document/ })).toHaveAttribute('aria-selected', 'true');
    await expect(property(page, 'title').locator('input')).toHaveValue('Old title');
  });

  test("uses VS Code's own icons (codicons): the font loads and the buttons show them", async ({ page }) => {
    await open(page);
    await expect(page.locator('.pmd-ribbon [data-command="strong.toggle"] .codicon-bold')).toHaveCount(1);
    await expect.poll(() => page.evaluate(async () => (await document.fonts.load('16px codicon'), document.fonts.check('16px codicon')))).toBe(true);
    // the ribbon keeps its text labels next to the icons (nothing harder to find than in P7)
    await expect(page.locator('.pmd-ribbon [data-command="strong.toggle"]')).toHaveText('Bold');
  });
});

test.describe('the Element tab', () => {
  test('a FIGURE: its fields; changing the caption sends one edit of only that line', async ({ page }) => {
    await open(page);
    await openInspector(page);
    await page.locator('.pmd-canvas .pmd-figure').click();
    await expect(field(page, 'caption').locator('input')).toHaveValue('Login');
    await expect(field(page, 'src').getByRole('button', { name: /browse/i })).toBeVisible();
    await field(page, 'caption').locator('input').fill('The login page');
    await field(page, 'caption').locator('input').press('Enter');
    const { text, edits } = await savedText(page);
    expect(edits).toHaveLength(1);
    expect(text).toBe(DOC.replace('caption="Login"', 'caption="The login page"'));
  });

  test('a link (a mark): the address, then the paragraph around it', async ({ page }) => {
    await open(page);
    await openInspector(page);
    await page.locator('.pmd-canvas a', { hasText: 'the site' }).click();
    await expect(inspector(page).locator('.pmd-insp-title')).toHaveText(['Link', 'Text']);
    await field(page, 'href').locator('input').fill('https://b.org');
    await field(page, 'href').locator('input').press('Enter');
    const { text } = await savedText(page);
    expect(text).toBe(DOC.replace('https://a.org', 'https://b.org'));
  });

  test('a path field: "Browse…" asks the host for a file and writes the path it answers', async ({ page }) => {
    await open(page);
    await openInspector(page);
    await page.locator('.pmd-canvas .pmd-figure').click();
    await field(page, 'src').getByRole('button', { name: /browse/i }).click();
    const pick = await waitFor(page, (m) => m.method === 'pickFile');
    expect(pick.params).toEqual({ filter: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] });
    await fromHost(page, { kind: 'response', id: pick.id, ok: true, result: 'img/new.png' });
    const { text } = await savedText(page);
    expect(text).toBe(DOC.replace('src="shot.png"', 'src="img/new.png"'));
  });

  test('a number field takes only a number; the problem is shown and nothing is sent', async ({ page }) => {
    await open(page, { text: '<!-- ::TOC levels=3 -->\n\n# A\n' });
    await openInspector(page);
    await page.locator('.pmd-canvas .pmd-toc, .pmd-canvas [class*="toc"]').first().click();
    await field(page, 'levels').locator('input').fill('three');
    await field(page, 'levels').locator('input').press('Enter');
    await expect(field(page, 'levels').locator('.pmd-insp-problem')).toHaveText('A number is needed here.');
    await quiet(page);
    expect((await sent(page)).some((m) => m.method === 'applyEdits')).toBe(false);
  });

  test('list rows (D6): an annotated image gets a marker added through the form', async ({ page }) => {
    const text = '::: annotated-image shot.png\nmarkers:\n  - { id: 1, x: 10, y: 20, label: "First" }\n:::\n';
    await open(page, { text });
    await openInspector(page);
    await page.locator('.pmd-canvas .pmd-annotated-image').click();
    await expect(field(page, 'markers').locator('.pmd-insp-list-row')).toHaveCount(1);
    await field(page, 'markers').getByRole('button', { name: /Add marker/ }).click();
    const saved = await savedText(page, text);
    expect(saved.text).toContain('{ id: 1, x: 10, y: 20, label: "First" }');
    expect(saved.text).toMatch(/id: "?2"?, x: 50, y: 50/);
  });

  test('in Read everything shows and nothing can be changed', async ({ page }) => {
    await open(page, { mode: 'read' });
    await openInspector(page);
    await page.locator('.pmd-canvas .pmd-figure').click();
    await expect(field(page, 'caption').locator('input')).toHaveAttribute('readonly', '');
    await inspector(page).getByRole('tab', { name: /Document/ }).click();
    await expect(property(page, 'title').locator('input')).toHaveAttribute('readonly', '');
    await expect(inspector(page).getByRole('combobox', { name: 'Add property' })).toHaveCount(0);
  });
});

test.describe('the Document tab and the properties card', () => {
  async function documentTab(page: Page) {
    await openInspector(page);
    await inspector(page).getByRole('tab', { name: /Document/ }).click();
  }

  test('lists the properties, marks required and shown-on-page ones, and the profile default as a hint', async ({ page }) => {
    await open(page);
    await documentTab(page);
    await expect(inspector(page).locator('.pmd-props-row')).toHaveCount(4); // title, document_id; then author, version
    await expect(property(page, 'title').locator('.pmd-props-badge')).toHaveText(['Required', 'On page']);
    await expect(property(page, 'document_id').locator('.pmd-props-badge')).toHaveText(['doc_id']); // the nickname as written
    await expect(property(page, 'author')).toHaveAttribute('data-missing', 'true');
    await expect(property(page, 'author').locator('input')).toHaveAttribute('placeholder', 'TBD');
  });

  test('a value changes in place: comments and key order kept, the nickname kept (M4)', async ({ page }) => {
    await open(page);
    await documentTab(page);
    await property(page, 'document_id').locator('input').fill('X-2');
    await property(page, 'document_id').locator('input').press('Enter');
    const { text, edits } = await savedText(page);
    expect(edits).toHaveLength(1);
    expect(text).toBe(DOC.replace('doc_id: X-1', 'doc_id: X-2'));
  });

  test('a missing required property is filled in; "Add property" adds another; × removes one', async ({ page }) => {
    await open(page);
    await documentTab(page);
    await property(page, 'author').locator('input').fill('Ann');
    await property(page, 'author').locator('input').press('Enter');
    await expect(property(page, 'author')).not.toHaveAttribute('data-missing', 'true');
    await inspector(page).getByRole('combobox', { name: 'Add property' }).selectOption('fancy_lists');
    await expect(property(page, 'fancy_lists')).toHaveCount(1);
    await property(page, 'document_id').getByRole('button', { name: /Remove/ }).click();
    await expect(property(page, 'document_id')).toHaveCount(0);
    await expect(property(page, 'author').locator('input')).toHaveValue('Ann');
    // The three changes reach the host (in one request or several, as the typing pause groups them): a new text value is written
    // quoted (@pagemd/syntax's YAML writer, C3), the removed line is gone, the comment and the rest are as written.
    await hostReaches(page, DOC.replace('doc_id: X-1\n', 'author: "Ann"\nfancy_lists: false\n'));
  });

  test('the raw YAML: edited as text; unreadable YAML shows the error and only the raw view', async ({ page }) => {
    await open(page, { text: '---\ntitle: [unclosed\n---\n\nBody.\n' });
    await documentTab(page);
    await expect(inspector(page).locator('.pmd-props-error')).toContainText("can't be read");
    const raw = inspector(page).getByRole('textbox', { name: 'Properties as YAML' });
    await expect(raw).toHaveValue('title: [unclosed');
    await raw.fill('title: Fixed');
    await raw.press('Control+Enter');
    const { text } = await savedText(page, '---\ntitle: [unclosed\n---\n\nBody.\n');
    expect(text).toBe('---\ntitle: Fixed\n---\n\nBody.\n');
    await expect(property(page, 'title').locator('input')).toHaveValue('Fixed');
  });

  test('the card: closed at first with the title and a count; opened, the same form edits the document', async ({ page }) => {
    await open(page);
    const card = page.locator('.pmd-canvas .pmd-fm-card');
    await expect(card.locator('.pmd-fm-summary')).toHaveText('Old title · 2 properties');
    await expect(card.locator('.pmd-props')).toBeHidden();
    await card.getByRole('button', { name: /Document properties/ }).click();
    await expect(card.getByRole('button', { name: /Document properties/ })).toHaveAttribute('aria-expanded', 'true');
    const title = card.locator('[data-property="title"] input');
    await title.fill('New title');
    await title.press('Enter');
    const { text } = await savedText(page);
    expect(text).toBe(DOC.replace('title: Old title  # keep me', 'title: New title  # keep me'));
    await expect(card.locator('.pmd-fm-summary')).toHaveText('New title · 2 properties');
  });

  test('typing in the page right after the card still goes into the text (the card is one block, not text)', async ({ page }) => {
    await open(page);
    await page.locator('.pmd-canvas h1').click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    const { text } = await savedText(page);
    expect(text).toBe(DOC.replace('# Heading', '# Heading!'));
  });
});
