// FIX-template-asset-paths (R-259, OQ-80) in a real browser (Chromium): a profile kept away from the document (named by its full
// path), whose template shows a logo written `../assets/images/logo.png` (from the template's own folder). The canvas draws the
// template around the text in Print Layout and Web Layout, and the logo loads: style-pagemd wrote its path from the document's
// folder (the page's base address). The old `.pagemd/assets/…` shape beside the document still loads; the profile CSS's url() too.
// (Which folders the VS Code webview may load from is the host's part: apps/vscode/test/editor-provider.test.ts and test:vscode.)
// Run: npm run test:e2e (builds first).
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { openInPrintLayout } from './pagination-harness.ts';

// Invented pictures only (SAN-0b): the UOFO logo (300 px wide) and a plain 400 px test picture.
const PNG = fileURLToPath(new URL('./fixtures/print-fidelity/brochure-uofo/.pagemd/assets/img/uofo-logo.png', import.meta.url));
const OLD_PNG = fileURLToPath(new URL('./fixtures/wide.png', import.meta.url));

function fixture(): { doc: string; text: string } {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'pmd-tap-'));
  const profile = nodePath.join(root, 'Resources', 'uofo how-to');
  const put = (rel: string, text: string) => {
    const file = nodePath.join(root, rel);
    mkdirSync(nodePath.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  mkdirSync(nodePath.join(profile, 'assets', 'images'), { recursive: true });
  mkdirSync(nodePath.join(root, '01-SOP', '.pagemd', 'assets'), { recursive: true });
  copyFileSync(PNG, nodePath.join(profile, 'assets', 'images', 'logo.png'));
  copyFileSync(OLD_PNG, nodePath.join(root, '01-SOP', '.pagemd', 'assets', 'old.png'));
  put('Resources/uofo how-to/profile.json', JSON.stringify({ id: 'uofo', extends: 'standard_letter', resources: { template: './templates/t.html', css: ['./styles/p.css'] } }));
  put(
    'Resources/uofo how-to/templates/t.html',
    '<html><head>{{styles}}</head><body><header class="tap-head"><img class="tap-logo" src="../assets/images/logo.png" alt="logo" style="width:40px"><img class="tap-old" src=".pagemd/assets/old.png" alt="old" style="width:40px"><span class="tap-bg"></span></header><main>{{content}}</main></body></html>',
  );
  put('Resources/uofo how-to/styles/p.css', '.tap-bg { display: inline-block; width: 20px; height: 20px; background-image: url("../assets/images/logo.png"); }');
  const doc = nodePath.join(root, '01-SOP', 'document.md');
  const text = `---\ntitle: Template pictures\npipeline_profile: ${nodePath.join(profile, 'profile.json')}\n---\n# Hello\n\nText.\n`;
  writeFileSync(doc, text);
  return { doc, text };
}

const loaded = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const img = document.querySelector<HTMLImageElement>(s);
    return img ? { width: img.naturalWidth, src: img.getAttribute('src') } : null;
  }, selector);

test('the template\'s logo next to an outside profile loads on the canvas; the old .pagemd shape and the CSS url() too', async ({ page }) => {
  const { doc, text } = fixture();
  await openInPrintLayout(page, doc, text, pathToFileURL(`${nodePath.dirname(doc)}/`).href);
  await expect.poll(() => loaded(page, '.tap-logo')).toEqual({ width: 300, src: '../Resources/uofo%20how-to/assets/images/logo.png' });
  await expect.poll(async () => (await loaded(page, '.tap-old'))?.width).toBe(400);
  // the stylesheet's url() starts from the stylesheet's folder, written from the document's
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.tap-bg')!).backgroundImage);
  expect(bg).toContain('/Resources/uofo%20how-to/assets/images/logo.png');
  const width = await page.evaluate(
    (url) =>
      new Promise<number>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth);
        img.onerror = () => resolve(0);
        img.src = url;
      }),
    /url\("(.*)"\)/.exec(bg)![1]!,
  );
  expect(width).toBe(300);
});
