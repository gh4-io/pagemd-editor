// P13b (amendment 8, acceptance 7): axe-core (WCAG 2.1 A and AA plus its best-practice rules) on every surface the editor draws, with a
// pretend host, in a light and a dark VS Code theme. No serious or critical finding is allowed anywhere; the moderate and minor ones are
// listed below with a reason (the known list fails on a new one, too). Run: npm run test:e2e (builds first).
// The gate prompt is VS Code's own dialog (the host asks, the webview draws nothing), so it has no surface here.
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { frames } from '../support/quiet.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { answerFilesInUse, filesReportFor, openInPrintLayout, PAGEMD_ROOT, settle } from './pagination-harness.ts';
import { themeCss, type ThemeName } from './fixtures/themes.ts';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const DOC_PATH = `${PAGEMD_ROOT}/tests/corpus/pagemd/examples/md/a11y-probe.md`;
const DOC = [
  '---', 'title: Accessibility probe', 'owner: Ann', '---', '',
  '# Probe heading', '', 'First paragraph with **bold** and a [link](https://example.com).', '',
  '<!-- ::BREAK -->', '', '## Second heading', '', '- one', '- two', '', '| A | B |', '|---|---|', '| 1 | 2 |', '',
  '<!-- ::FIGURE src="wide.png" alt="A wide test picture" caption="Figure shot" -->', '',
  '::: annotated-image wide.png', 'markers:', '  - { id: 1, x: 25, y: 50, label: "Left" }', ':::', '',
  '```', 'code', '```', '',
  // P26: a task list (each box named by its item's text) and a footnote (its reference and its note)
  '- [ ] Open task', '- [x] Done task', '', 'A sentence with a note[^1].', '', '[^1]: The note.', '',
  'Last paragraph.', '',
].join('\n');

/** axe's rules for this check: WCAG 2.1 A and AA, plus its own best practices. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

/** Rules switched off, with the reason: a webview is a part of VS Code's window and a document may have no level-one heading (its title is the tab's). */
const OFF = ['page-has-heading-one'];
/** Rules not held against the document's own text: links that the profile's CSS draws in color only (pagemd's PDF looks the same). */
const DOCUMENT_OWN = ['link-in-text-block'];

type Finding = { id: string; impact: string | null; help: string; nodes: { target: unknown; html: string; failureSummary?: string }[] };

async function scan(page: Page): Promise<Finding[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE);
  return page.evaluate(
    async ([tags, exempt, off]) => {
      const axe = (window as unknown as { axe: { run(context: unknown, options: unknown): Promise<{ violations: Finding[] }> } }).axe;
      const rules = Object.fromEntries(off!.map((id) => [id, { enabled: false }]));
      const found = (await axe.run(document, { runOnly: { type: 'tag', values: tags }, rules, resultTypes: ['violations'] })).violations;
      // The document's own look (the profile's CSS) is not the editor's to change: a rule listed in `exempt` is not held against
      // anything inside the canvas's text.
      return found
        .map((f) => (exempt!.includes(f.id) ? { ...f, nodes: f.nodes.filter((n) => !document.querySelector((n.target as string[]).join(' '))?.closest('.pmd-canvas .ProseMirror')) } : f))
        .filter((f) => f.nodes.length > 0);
    },
    [TAGS, DOCUMENT_OWN, OFF] as [string[], string[], string[]],
  );
}

const pmd = <T>(page: Page, fn: (api: any) => T) => page.evaluate(`(${fn.toString()})(window.__pmd)`) as Promise<T>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function open(page: Page, theme: ThemeName, mode: string, text = DOC): Promise<void> {
  await openInPrintLayout(page, DOC_PATH, text, fixtures);
  await page.addStyleTag({ content: themeCss(theme) });
  if (mode !== 'print') {
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
    await frames(page);
  }
  await settle(page);
}

/** P21: the same document with a landscape page (pagemd's letter.css): a size tag above that sheet and the note in the status bar. */
const WITH_LANDSCAPE = DOC.replace('## Second heading', '<!-- ::LAYOUT(landscape) -->\n\n## Second heading');

const surfaces: { name: string; setup(page: Page): Promise<void>; mode?: string; text?: string }[] = [
  { name: 'Print Layout', mode: 'print', async setup() {} },
  {
    name: 'Print Layout with a page type the PDF prints at another size (P21)',
    mode: 'print',
    text: WITH_LANDSCAPE,
    async setup(page) {
      await expect(page.locator('.pmd-page-size-tag')).not.toHaveCount(0);
      await expect(page.locator('.pmd-status-bar')).toContainText('drawn as your layout says');
    },
  },
  { name: 'Web Layout', mode: 'web', async setup() {} },
  { name: 'Draft', mode: 'draft', async setup() {} },
  { name: 'Read', mode: 'read', async setup() {} },
  { name: 'Code', mode: 'code', async setup() {} },
  { name: 'Split', mode: 'split', async setup() {} },
  {
    name: 'the Inspector, Document tab',
    async setup(page) {
      await pmd(page, (api) => (api.view.set({ panels: { inspector: true } }), api.inspector.show('document')));
    },
  },
  {
    name: 'the Inspector, Element tab (a table selected)',
    async setup(page) {
      await pmd(page, (api) => api.view.set({ panels: { inspector: true } }));
      await page.locator('.pmd-canvas td').first().click();
      await pmd(page, (api) => api.inspector.show('element'));
    },
  },
  {
    // P19: the Table tab with its Width group, the cursor in a table (its buttons on).
    name: 'the Table tab (cursor in a table)',
    async setup(page) {
      await page.locator('.pmd-canvas td').first().click();
      await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Table', exact: true }).click();
      await expect(page.locator('.pmd-ribbon [data-command="table.column-wider"]')).toBeVisible();
    },
  },
  {
    // P20: the Image tab, shown and brought forward by selecting a picture.
    name: 'the Image tab (a picture selected)',
    async setup(page) {
      await page.locator('.pmd-canvas .pmd-annotated-image img').first().click({ position: { x: 4, y: 4 } });
      await expect(page.locator('.pmd-ribbon').getByRole('tab', { name: 'Image', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.pmd-ribbon [data-command="image.rotate-right"]')).toBeVisible();
    },
  },
  {
    // P20: Insert with no image tools left on it (Pictures only).
    name: 'the Insert tab (no image tools)',
    async setup(page) {
      await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Insert', exact: true }).click();
      await expect(page.locator('.pmd-ribbon [data-command="figure.insert"]')).toBeVisible();
      await expect(page.locator('.pmd-ribbon [data-command="image.crop"]')).toHaveCount(0);
    },
  },
  {
    name: 'the Outline',
    async setup(page) {
      await pmd(page, (api) => api.view.set({ panels: { outline: true } }));
      await expect(page.locator('.pmd-outline-entry').first()).toBeVisible();
    },
  },
  {
    name: 'the Comments panel (compose box open)',
    async setup(page) {
      await page.locator('.pmd-canvas .ProseMirror p').first().click();
      // the side file: no comments yet (the pretend host has no file)
      await expect.poll(async () => (await sent(page)).some((m) => m.method === 'readSidecar')).toBe(true);
      const read = (await sent(page)).find((m) => m.method === 'readSidecar')!;
      await fromHost(page, { kind: 'response', id: read.id, ok: true, result: null });
      await pmd(page, (api) => api.view.set({ panels: { comments: true } }));
      await page.getByRole('button', { name: /new comment/i }).first().click();
    },
  },
  {
    // P25: the Files in Use panel, its lists and "where did this come from" for a heading (the corpus document's own report).
    name: 'the Files in Use panel',
    async setup(page) {
      await pmd(page, (api) => api.view.set({ panels: { files: true } }));
      await answerFilesInUse(page, await filesReportFor(DOC_PATH, DOC));
      await page.locator('.pmd-canvas .ProseMirror h2').first().click();
      await expect(page.locator('.pmd-files-where .pmd-files-chip').first()).toBeVisible();
      await page.locator('.pmd-files-how summary').click();
      await page.locator('.pmd-files-beaten summary').first().click();
    },
  },
  {
    name: 'the find bar',
    async setup(page) {
      await page.locator('.pmd-canvas .ProseMirror p').first().click();
      await page.keyboard.press('Control+f');
      await expect(page.getByRole('textbox', { name: 'Find' })).toBeVisible();
    },
  },
  {
    name: 'the slash menu',
    async setup(page) {
      await page.locator('.pmd-canvas .ProseMirror p').last().click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('/');
      await expect(page.getByRole('listbox')).toBeVisible();
    },
  },
  {
    name: 'the selection toolbar',
    async setup(page) {
      await page.locator('.pmd-canvas .ProseMirror p').first().click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await expect(page.getByRole('toolbar', { name: 'Text formatting' })).toBeVisible();
    },
  },
  {
    name: 'the ribbon with a menu open',
    async setup(page) {
      await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Insert', exact: true }).click();
      await page.locator('.pmd-ribbon-menu-button').first().click();
      await expect(page.locator('.pmd-ribbon-menu:not([hidden])')).toBeVisible();
    },
  },
  {
    // P27: Word's crop mode on the canvas (Image ▸ Edit picture ▸ Crop).
    name: 'crop mode (Image ▸ Crop)',
    async setup(page) {
      await page.locator('.pmd-canvas .pmd-annotated-image img').first().click({ position: { x: 4, y: 4 } });
      await expect(page.locator('.pmd-ribbon').getByRole('tab', { name: 'Image', exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.locator('.pmd-ribbon [data-command="image.crop"]').click();
      await expect(page.locator('.pmd-crop-mode')).toBeFocused();
    },
  },
  {
    // P27 (R-251): the first redaction's note (a dialog).
    name: 'the Redact note',
    async setup(page) {
      await page.locator('.pmd-canvas .pmd-annotated-image img').first().click({ position: { x: 4, y: 4 } });
      await expect(page.locator('.pmd-ribbon').getByRole('tab', { name: 'Image', exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.locator('.pmd-ribbon [data-command="image.redact"]').click();
      await expect(page.getByRole('dialog', { name: 'Redact' })).toBeVisible();
    },
  },
];


/**
 * Findings that are known and accepted, by surface. A new moderate or minor finding fails the run until it is fixed or listed here
 * with its reason. Today: the two pop-ups that are drawn on the page's body so they can be placed anywhere (the slash menu's list and the
 * selection toolbar) are "not inside a landmark" (axe: region, moderate). They exist while the author types or selects; a screen reader
 * reaches them through the text box (the combobox owns the list) and the Tab stop of the toolbar, not through landmark navigation.
 */
const ACCEPTED: Record<string, string[]> = { 'the slash menu': ['region'], 'the selection toolbar': ['region'] };

/** The surfaces that also run in a high-contrast theme (the rest differ from these only in their content, not in their colors). */
const HIGH_CONTRAST = ['Print Layout', 'Draft', 'Code', 'the Inspector, Document tab', 'the Outline', 'the Comments panel (compose box open)', 'the Files in Use panel', 'the find bar', 'the selection toolbar', 'the ribbon with a menu open', 'the image dialog (Crop)'];

for (const theme of ['light', 'dark', 'high-contrast'] as const) {
  test.describe(`axe-core, ${theme} theme`, () => {
    for (const surface of surfaces.filter((s) => theme !== 'high-contrast' || HIGH_CONTRAST.includes(s.name))) {
      test(surface.name, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await open(page, theme, surface.mode ?? 'print', surface.text);
        await surface.setup(page);
        await settle(page);
        const found = await scan(page);
        const report = found.map((f) => `${f.impact} ${f.id}: ${f.help}\n${f.nodes.slice(0, 4).map((n) => `    ${JSON.stringify(n.target)} ${n.html.slice(0, 140)}`).join('\n')}`);
        const serious = found.filter((f) => f.impact === 'serious' || f.impact === 'critical');
        expect(serious.map((f) => f.id), report.join('\n')).toEqual([]);
        const rest = found.filter((f) => !serious.includes(f)).map((f) => f.id);
        expect(rest.filter((id) => !(ACCEPTED[surface.name] ?? []).includes(id)), report.join('\n')).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  });
}
