// FIX-ADT item B: task lists look as on GitHub (github-markdown-css 5.9.0): the list keeps a 2em indent and each box is pulled back
// 1.4em into it, so the box starts 0.6em in from the list's edge, then a gap, then the text. The canvas and pagemd's own HTML (measured
// in the same browser) agree, under the default profile and under book-wiki (whose lists have their own indent: the extra CSS used to
// sit in the lowest layer, so that indent won and the box stood flush or outside). Run: npm run test:e2e (builds first).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { PAGEMD_ROOT, stylesFor } from './pagination-harness.ts';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const BODY = ['# Tasks', '', 'Intro paragraph.', '', '- [ ] Open item', '- [x] Done item', '', '1. [ ] Numbered open', '2. [x] Numbered done', '', '- plain bullet', ''].join('\n');
const PROFILES = [
  { name: 'the default profile', text: BODY },
  { name: 'book-wiki', text: `---\nprofile: book-wiki\n---\n\n${BODY}` },
];

type Message = { kind: string; name?: string };

/** What is measured on a page: for each list with task items, the box's left and the text's left, from the list's own left edge, in em. */
async function measure(page: Page, root: string): Promise<{ box: number; text: number; indent: number }[]> {
  return page.evaluate((rootSelector) => {
    const out: { box: number; text: number; indent: number }[] = [];
    for (const list of document.querySelectorAll(`${rootSelector} .contains-task-list`)) {
      const li = list.querySelector('li.task-list-item')!;
      const box = li.querySelector('input.task-list-item-checkbox')!;
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (box.parentElement!.contains(n) && n.parentElement !== li && n.parentElement!.className === 'pmd-task-box') || !n.textContent!.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const text = walker.nextNode()!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.search(/\S/));
      range.setEnd(text, text.textContent!.search(/\S/) + 1);
      const left = list.getBoundingClientRect().left;
      const em = parseFloat(getComputedStyle(list).fontSize);
      out.push({ box: (box.getBoundingClientRect().left - left) / em, text: (range.getBoundingClientRect().left - left) / em, indent: parseFloat(getComputedStyle(list).paddingLeft) / em });
    }
    return out;
  }, root);
}

for (const profile of PROFILES) {
  for (const mode of ['web', 'print']) {
    test(`${profile.name}, ${mode}: the box is 0.6em in from the list's edge, as in pagemd's HTML`, async ({ page, browser }) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      const dir = mkdtempSync(join(tmpdir(), 'pmd-tasks-'));
      const file = join(dir, 'doc.md');
      const reference = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      try {
        writeFileSync(file, profile.text);
        const html = execFileSync('node', ['apps/cli/src/index.js', 'build', file, '-o', 'html', '--stdout'], { cwd: PAGEMD_ROOT, encoding: 'utf8', env: { ...process.env, PAGEMD_MERMAID: '0', TZ: 'UTC' } });
        // The CLI may print a log line before the page; text before the doctype would put the browser in quirks mode.
        writeFileSync(join(dir, 'out.html'), html.slice(html.search(/<!doctype html>/i)));
        await reference.goto(pathToFileURL(join(dir, 'out.html')).href);

        const { styles, gateDefaults, notes } = await stylesFor(file, profile.text);
        await page.goto(pageUrl);
        await page.waitForFunction(() => (window as unknown as { __toHost?: Message[] }).__toHost?.some((m) => m.name === 'ready'));
        await fromHost(page, { kind: 'event', name: 'init', data: { protocol: 16, text: profile.text, version: 1, fileName: 'doc.md', documentBase: fixtures, testing: true, styles: { styles, gateDefaults, notes }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' } });
        await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
        await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
        await expect(page.locator('.pmd-canvas input.task-list-item-checkbox')).toHaveCount(4);

        const ours = await measure(page, '.pmd-canvas');
        const theirs = await measure(reference, 'body');
        expect(theirs).toHaveLength(2);
        expect(ours).toHaveLength(2);
        for (let i = 0; i < 2; i++) {
          const o = ours[i]!;
          const t = theirs[i]!;
          const em = await page.locator('.pmd-canvas .contains-task-list').nth(i).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          // GitHub's layout: the list keeps 2em, the box starts 0.6em in
          expect(o.indent, `list ${i} indent (em)`).toBeCloseTo(2, 1);
          expect(Math.abs(o.box - 0.6) * em, `list ${i}: box ${o.box}em from the list's edge, expected 0.6em`).toBeLessThanOrEqual(1);
          // and the canvas is where pagemd's own HTML puts them, box and text
          expect(Math.abs(o.box - t.box) * em, `list ${i} box: ours ${o.box}em, pagemd ${t.box}em`).toBeLessThanOrEqual(1);
          expect(Math.abs(o.text - t.text) * em, `list ${i} text: ours ${o.text}em, pagemd ${t.text}em`).toBeLessThanOrEqual(1);
        }
      } finally {
        await reference.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

// AD-FIX-ADT-09: the look is overridable again. Nothing in the task lists' CSS is !important, and book-wiki no longer states its list indent
// with !important, so (a) a document's own `styles:` file changes the indent with an ordinary rule (its layer is after `structural`), and
// (b) a profile that wants another indent can have it with an !important (the earlier layer wins for those). Before: both stayed at 2em.
async function openWith(page: Page, dir: string, text: string): Promise<void> {
  const file = join(dir, 'doc.md');
  writeFileSync(file, text);
  const { styles, gateDefaults, notes } = await stylesFor(file, text);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as unknown as { __toHost?: Message[] }).__toHost?.some((m) => m.name === 'ready'));
  await fromHost(page, { kind: 'event', name: 'init', data: { protocol: 16, text, version: 1, fileName: 'doc.md', documentBase: fixtures, testing: true, styles: { styles, gateDefaults, notes }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' } });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'web' } });
  await expect(page.locator('.pmd-canvas input.task-list-item-checkbox')).toHaveCount(4);
}
const indentOf = (page: Page) => page.locator('.pmd-canvas .contains-task-list').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft) / parseFloat(getComputedStyle(el).fontSize));

for (const profile of PROFILES) {
  test(`${profile.name}: a document's own styles: file can change the task list indent`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'pmd-tasks-'));
    try {
      writeFileSync(join(dir, 'indent.css'), '.contains-task-list { padding-left: 3em; }\n');
      const text = profile.text.startsWith('---\n') ? profile.text.replace('---\n\n', 'styles: [indent.css]\n---\n\n') : `---\nstyles: [indent.css]\n---\n\n${profile.text}`;
      await openWith(page, dir, text);
      expect(await indentOf(page)).toBeCloseTo(3, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${profile.name}: a profile's !important indent wins over the structural layer`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'pmd-tasks-'));
    try {
      await openWith(page, dir, profile.text);
      expect(await indentOf(page)).toBeCloseTo(2, 1);
      // as a project profile would: a rule of the `profile` layer
      // (a constructed sheet: the page's content security policy allows no inline <style> added later)
      await page.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('@layer profile { .pmd-canvas .contains-task-list { padding-left: 3em !important; } }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      expect(await indentOf(page)).toBeCloseTo(3, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
