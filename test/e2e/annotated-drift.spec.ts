// FIX-ADT item A: on an annotated image, the editing ring (the overlay's marker hit, drawn on the picture's box) and pagemd's own
// badge (drawn in the figure's frame) are the same place, in Draft, Web Layout and Print Layout, and the canvas figure is as tall as
// the figure in pagemd's own HTML. The cause was ProseMirror's `white-space: break-spaces`: it reached pagemd's annotated-image
// markup, so the line breaks and indents between the picture and its badges became blank lines (the frame grew, the picture moved
// down) while the badges stay placed as a percentage of the frame. A plain figure must be unaffected. Run: npm run test:e2e.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { resolveStyles, type StyleEnvironment } from '@pagemd-editor/style-pagemd';

const PAGEMD_ROOT = fileURLToPath(new URL('../../../pagemd/', import.meta.url)).replace(/\/$/, '');
const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixturesUrl = pathToFileURL(fixturesDir).href;
const DOC = [
  '# Shots',
  '',
  '::: annotated-image wide.png',
  'options: { caption: "The app" }',
  'markers:',
  '  - { id: 1, x: 5, y: 5, label: "A" }',
  '  - { id: 2, x: 95, y: 5, label: "B" }',
  '  - { id: 3, x: 5, y: 95, label: "C" }',
  '  - { id: 4, x: 95, y: 95, label: "D" }',
  '  - { id: 5, x: 50, y: 50, label: "E" }',
  'boxes:',
  '  - { x: 60, y: 20, width: 20, height: 20, label: "Panel", id: 6 }',
  ':::',
  '',
  '<!-- ::FIGURE src="wide.png" caption="Plain" -->',
  '',
  'End.',
  '',
].join('\n');

const nodeFs: StyleEnvironment['fs'] = {
  exists: async (p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  },
  readText: async (p) => readFileSync(p, 'utf8'),
  stat: async (p) => {
    try {
      const { statSync } = await import('node:fs');
      const s = statSync(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  list: async (p) => {
    const { readdirSync } = await import('node:fs');
    return readdirSync(p);
  },
};

type Message = { kind: string; name?: string };

async function openOurs(page: Page, mode: string): Promise<void> {
  const env: StyleEnvironment = { fs: nodeFs, pagemdPath: PAGEMD_ROOT, path: await import('node:path') };
  const resolution = await resolveStyles({ path: join(fixturesDir, 'a.md'), text: DOC }, env);
  expect(resolution.styles, JSON.stringify(resolution.notes)).not.toBeNull();
  const styles = { styles: resolution.styles, gateDefaults: resolution.gateDefaults, notes: resolution.notes };
  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as unknown as { __toHost?: Message[] }).__toHost?.some((m) => m.name === 'ready'));
  await fromHost(page, { kind: 'event', name: 'init', data: { protocol: 16, text: DOC, version: 1, fileName: 'a.md', documentBase: fixturesUrl, testing: true, styles, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' } });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
  await expect(page.locator('.pmd-canvas img').first()).toHaveJSProperty('complete', true);
}

/** pagemd's own HTML for DOC, written next to the picture so it loads; measured in the same browser. */
function pagemdFile(): { dir: string; url: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pmd-drift-'));
  copyFileSync(join(fixturesDir, 'wide.png'), join(dir, 'wide.png'));
  writeFileSync(join(dir, 'doc.md'), DOC);
  const html = execFileSync('node', ['apps/cli/src/index.js', 'build', join(dir, 'doc.md'), '-o', 'html', '--stdout'], { cwd: PAGEMD_ROOT, encoding: 'utf8', env: { ...process.env, PAGEMD_MERMAID: '0', TZ: 'UTC' } });
  // The CLI may print a log line before the page: text before the doctype puts the browser in quirks mode, which drops the line strut under a picture.
  writeFileSync(join(dir, 'out.html'), html.slice(html.search(/<!doctype html>/i)));
  return { dir, url: pathToFileURL(join(dir, 'out.html')).href };
}

const heights = (page: Page, figures: string) => page.locator(figures).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));

for (const mode of ['draft', 'web', 'print']) {
  test.describe(`FIX-ADT A, ${mode} view`, () => {
    test("the figure is as tall as pagemd's, the plain figure unchanged", async ({ page, browser }) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      await openOurs(page, mode);
      if (mode === 'draft') {
        // Draft has no profile CSS, so the text sizes differ from pagemd's; the frame must still be exactly the picture.
        const [frame, picture] = await page.locator('.pmd-canvas .image-wrapper, .pmd-canvas .image-wrapper img').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
        expect(frame, 'the frame is as tall as the picture').toBeCloseTo(picture!, 0);
        return;
      }
      const reference = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      const made = pagemdFile();
      try {
        await reference.goto(made.url);
        await expect(reference.locator('.image-wrapper img').first()).toHaveJSProperty('complete', true);
        const [oursAnnotated, oursPlain] = await heights(page, '.pmd-canvas figure');
        const [theirsAnnotated, theirsPlain] = await heights(reference, '.document-content figure');
        expect(Math.abs(oursAnnotated! - theirsAnnotated!), `annotated figure: ours ${oursAnnotated}, pagemd ${theirsAnnotated}`).toBeLessThanOrEqual(1);
        expect(Math.abs(oursPlain! - theirsPlain!), `plain figure: ours ${oursPlain}, pagemd ${theirsPlain}`).toBeLessThanOrEqual(1);
      } finally {
        await reference.close();
        rmSync(made.dir, { recursive: true, force: true });
      }
    });

    test("the editing ring and pagemd's badge of each marker (corners and centre) are one place", async ({ page }) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      await openOurs(page, mode);
      await page.locator('.pmd-canvas .pmd-annotated-image img').dblclick({ position: { x: 4, y: 4 } });
      await expect(page.locator('.pmd-shape-overlay')).toBeVisible();
      const centres = (selector: string) => page.locator(selector).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
      const badges = await centres('.pmd-annotated-drawing .marker');
      const rings = await centres('.pmd-shape-hit-marker');
      expect(badges.length).toBeGreaterThanOrEqual(5);
      expect(rings).toHaveLength(5);
      const worst = rings.map((r, i) => Math.max(Math.abs(r.x - badges[i]!.x), Math.abs(r.y - badges[i]!.y)));
      expect(Math.max(...worst), `ring against badge, per marker: ${JSON.stringify(worst)}`).toBeLessThanOrEqual(1);
    });
  });
}
