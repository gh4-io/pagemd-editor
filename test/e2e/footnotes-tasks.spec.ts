// P26: footnotes and task lists on the canvas, in a real browser with the document's real profile CSS. The user's showcase
// sections (Desktop/example.md: Task lists, Footnotes): the boxes are drawn and ticked with a click (one edit that changes one
// character of the file), off in Read; references are numbered as pagemd numbers them and link to their notes and back; Insert ▸
// Footnote adds a reference and a note in one edit with the cursor in the note. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { quiet } from '../support/quiet.ts';
import { pathToFileURL } from 'node:url';
import { openInPrintLayout, PAGEMD_ROOT, settle } from './pagination-harness.ts';

type Message = { kind: string; method?: string; params?: { edits?: { from: number; to: number; text: string }[] } };
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __toHost: Message[] }).__toHost);

const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const PATH = `${PAGEMD_ROOT}/tests/corpus/pagemd/examples/md/footnotes-tasks.md`;
const DOC = [
  '# Task lists',
  '',
  '- [x] Finish my changes',
  '- [ ] Push my commits to GitHub',
  '- [x] @mentions, #refs, [links](), **formatting**, and <del>tags</del> supported',
  '',
  '# Footnotes',
  '',
  'Footnote 1 link[^first].',
  '',
  'Footnote 2 link[^second].',
  '',
  'Inline footnote^[Text of inline footnote] definition.',
  '',
  'Duplicated footnote reference[^second].',
  '',
  '[^first]: Footnote **can have markup**',
  '',
  '    and multiple paragraphs.',
  '',
  '[^second]: Footnote text.',
  '',
].join('\n');

const edits = async (page: Page) => (await sent(page)).filter((m) => m.method === 'applyEdits');
const apply = (text: string, list: { from: number; to: number; text: string }[]): string =>
  [...list].sort((a, b) => b.from - a.from).reduce((out, e) => out.slice(0, e.from) + e.text + out.slice(e.to), text);
const boxes = (page: Page) => page.locator('.pmd-canvas input.task-list-item-checkbox');
const selectionIn = (page: Page) =>
  page.evaluate(() => {
    const { $from } = (window as unknown as { __pmd: { canvas: { view: { state: { selection: { $from: { depth: number; node(d: number): { type: { name: string } } } } } } } } }).__pmd.canvas.view.state.selection;
    const names: string[] = [];
    for (let d = $from.depth; d > 0; d--) names.push($from.node(d).type.name);
    return names;
  });

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openInPrintLayout(page, PATH, DOC, fixtures);
  return errors;
}

test.describe('task lists', () => {
  test('drawn as pagemd draws them: a box in front of the text, no bullet, the box named by its text', async ({ page }) => {
    const errors = await open(page);
    await expect(boxes(page)).toHaveCount(3);
    await expect(boxes(page).nth(0)).toBeChecked();
    await expect(boxes(page).nth(1)).not.toBeChecked();
    await expect(boxes(page).nth(1)).toHaveAttribute('aria-label', 'Push my commits to GitHub');
    await expect(page.locator('.pmd-canvas ul.contains-task-list > li.task-list-item')).toHaveCount(3);
    expect(await page.locator('.pmd-canvas ul.contains-task-list').evaluate((ul) => getComputedStyle(ul).listStyleType)).toBe('none');
    // The box sits on the text's line, in front of it
    const box = (await boxes(page).nth(1).boundingBox())!;
    const text = (await page.locator('.pmd-canvas li.task-list-item p').nth(1).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(text.y - 4);
    expect(box.y + box.height).toBeLessThanOrEqual(text.y + text.height + 4);
    // The item's text does not hold the box's characters
    await expect(page.locator('.pmd-canvas li.task-list-item p').nth(1)).toHaveText('Push my commits to GitHub');
    expect(errors).toEqual([]);
  });

  test('a click ticks the box: one edit, one character of the file, the rest of the list as written', async ({ page }) => {
    const errors = await open(page);
    const before = (await edits(page)).length;
    await boxes(page).nth(1).click();
    await expect(boxes(page).nth(1)).toBeChecked();
    await expect.poll(async () => (await edits(page)).length).toBe(before + 1);
    const after = apply(DOC, (await edits(page)).at(-1)!.params!.edits!);
    expect(after).toBe(DOC.replace('- [ ] Push', '- [x] Push'));
    expect(after).toContain('[links]()');
    // control: the box of the item above was not touched
    await expect(boxes(page).nth(0)).toBeChecked();
    expect(errors).toEqual([]);
  });

  test('in Read the boxes are off: a click changes nothing', async ({ page }) => {
    const errors = await open(page);
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'read' } });
    await settle(page);
    await expect(boxes(page).nth(1)).toBeDisabled();
    const before = (await edits(page)).length;
    await boxes(page).nth(1).click({ force: true });
    await quiet(page);
    await expect(boxes(page).nth(1)).not.toBeChecked();
    expect((await edits(page)).length).toBe(before);
    // control: back in Print Layout the same box works
    await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'print' } });
    await settle(page);
    await expect(boxes(page).nth(1)).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('Home ▸ Tasks ▸ Checklist makes a paragraph a checklist in one edit', async ({ page }) => {
    const errors = await open(page);
    await page.locator('.pmd-canvas .ProseMirror p', { hasText: 'Footnote 2 link' }).click();
    const before = (await edits(page)).length;
    await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Home', exact: true }).click();
    await page.locator('.pmd-ribbon [data-command="task-lists.toggle"]').click();
    await expect.poll(async () => (await edits(page)).length).toBe(before + 1);
    expect(apply(DOC, (await edits(page)).at(-1)!.params!.edits!)).toContain('- [ ] Footnote 2 link[^second].');
    await expect(boxes(page)).toHaveCount(4);
    expect(errors).toEqual([]);
  });
});

test.describe('footnotes', () => {
  test('numbered by first reference as pagemd numbers them; the notes show their number and a back-link', async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator('.pmd-canvas sup.footnote-ref a')).toHaveText(['[1]', '[2]', '[3]', '[2:1]']);
    await expect(page.locator('.pmd-canvas .pmd-footnote .pmd-footnote-label')).toHaveText(['1.', '2.']);
    await expect(page.locator('.pmd-canvas .pmd-footnote').first()).toContainText('Footnote can have markup');
    await expect(page.locator('.pmd-canvas .pmd-footnote').first()).toContainText('and multiple paragraphs.');
    await expect(page.locator('.pmd-canvas sup.footnote-ref a').nth(2)).toHaveAttribute('aria-label', 'Footnote 3: Text of inline footnote');
    // The reference is raised and smaller than the text, as in pagemd's PDF
    const size = await page.locator('.pmd-canvas sup.footnote-ref').first().evaluate((el) => [parseFloat(getComputedStyle(el).fontSize), parseFloat(getComputedStyle(el.parentElement!).fontSize)]);
    expect(size[0]).toBeLessThan(size[1]!);
    expect(errors).toEqual([]);
  });

  test('a reference links to its note, and the back-link returns to the first reference', async ({ page }) => {
    const errors = await open(page);
    await page.locator('.pmd-canvas sup.footnote-ref a').nth(1).click();
    await expect.poll(() => selectionIn(page)).toContain('pmd_footnote');
    await page.locator('.pmd-canvas .pmd-footnote .footnote-backref').nth(1).click();
    await expect.poll(() => selectionIn(page)).not.toContain('pmd_footnote');
    // An inline note has no block: a click selects its reference (the Inspector then shows the note's text)
    await page.locator('.pmd-canvas sup.footnote-ref a').nth(2).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __pmd: { canvas: { view: { state: { selection: { node?: { type: { name: string } } } } } } } }).__pmd.canvas.view.state.selection.node?.type.name ?? null))
      .toBe('pmd_footnote_ref');
    // nothing was written by moving around
    expect((await edits(page)).length).toBe(0);
    expect(errors).toEqual([]);
  });

  test('Insert ▸ Footnote: a reference at the cursor and a numbered note at the end, one edit; typing goes into the note', async ({ page }) => {
    const errors = await open(page);
    await page.locator('.pmd-canvas .ProseMirror li p', { hasText: 'Push my commits' }).click();
    await page.keyboard.press('End');
    const before = (await edits(page)).length;
    await page.locator('.pmd-ribbon').getByRole('tab', { name: 'Insert', exact: true }).click();
    await page.locator('.pmd-ribbon [data-command="footnotes.insert"]').click();
    await expect.poll(async () => (await edits(page)).length).toBe(before + 1);
    const text = apply(DOC, (await edits(page)).at(-1)!.params!.edits!);
    expect(text).toContain('- [ ] Push my commits to GitHub[^1]');
    expect(text.endsWith('[^second]: Footnote text.\n\n[^1]:\n')).toBe(true);
    await expect.poll(() => selectionIn(page)).toContain('pmd_footnote');
    await page.keyboard.type('A new note.');
    await expect(page.locator('.pmd-canvas .pmd-footnote').last()).toContainText('A new note.');
    // It is the first reference in the document, so it is number 1 now and the others follow (Word renumbers too)
    await expect(page.locator('.pmd-canvas sup.footnote-ref a')).toHaveText(['[1]', '[2]', '[3]', '[4]', '[3:1]']);
    expect(errors).toEqual([]);
  });
});
