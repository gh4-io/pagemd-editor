// R-133 acceptance checks 2 and 3 (P5): the canvas's computed styles and look match pagemd's own HTML output for
// a plain paragraph, styled by the same profile (standard_letter, the default). Two independent renderings are
// compared:
// 1. pagemd's own CLI (`build … -o html --stdout`), run once here as a subprocess, on the real pagemd checkout.
// 2. Our webview's Web Layout, fed the same markdown text and the same styles style-pagemd resolves (using the
//    real pagemd checkout as pagemdPath, R-128), through the same test harness webview.spec.ts uses.
// Check 2: getComputedStyle for the same properties (font family/size/weight, color, margins) must match exactly
// (the same CSS, only the surrounding markup differs). Check 3: a screenshot of that one `<p>` from each page,
// compared pixel by pixel inside the browser (no extra dependency); a generous, stated tolerance allows for the
// two different DOM structures' own font hinting/anti-aliasing, not for a different look.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { resolveStyles, type StyleEnvironment } from '@pagemd-editor/style-pagemd';

const PAGEMD_ROOT = fileURLToPath(new URL('../../../pagemd/', import.meta.url)).replace(/\/$/, '');
const FIXTURE = fileURLToPath(new URL('./fixtures/style-parity.md', import.meta.url));
const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixturesUrl = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;

/** The resolver's async FileSystem port over real files (what the host's adapter does over workspace.fs). */
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

/** pagemd's own HTML for `text` (the default profile, standard_letter): the CSS `<style>` blocks and the body's
 *  `<main class="document-content">`, wrapped into a standalone page (no template header, no directive chips). */
function pagemdReferenceHtml(text: string): string {
  // A real temp file (not --stdin): the CLI's own path resolution (project root, `${cliPath}` tokens) needs one.
  const dir = mkdtempSync(join(tmpdir(), 'pmd-style-parity-'));
  const file = join(dir, 'doc.md');
  writeFileSync(file, text);
  let html: string;
  try {
    html = execFileSync('node', ['apps/cli/src/index.js', 'build', file, '-o', 'html', '--stdout'], {
      cwd: PAGEMD_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PAGEMD_MERMAID: '0', TZ: 'UTC' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]).join('\n');
  const main = /<main class="document-content">([\s\S]*?)<\/main>/.exec(html);
  if (!main) throw new Error("pagemd's output has no <main class=\"document-content\"> to compare against");
  return `<!doctype html><html><head>${styles}</head><body><main class="document-content">${main[1]}</main></body></html>`;
}

type Message = { kind: string; name?: string; data?: unknown };

async function openOurs(page: Page, text: string): Promise<void> {
  const env: StyleEnvironment = { fs: nodeFs, pagemdPath: PAGEMD_ROOT, path: await import('node:path') };
  const resolution = await resolveStyles({ path: FIXTURE, text }, env);
  const styles = { styles: resolution.styles, gateDefaults: resolution.gateDefaults, notes: resolution.notes };
  expect(resolution.styles, `expected the default profile to resolve; notes: ${JSON.stringify(resolution.notes)}`).not.toBeNull();

  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as unknown as { __toHost?: Message[] }).__toHost?.some((m) => m.name === 'ready'));
  await fromHost(page, { kind: 'event', name: 'init', data: { protocol: 16, text, version: 1, fileName: 'style-parity.md', documentBase: fixturesUrl, testing: false, styles, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href } });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
}

/** Computed style, the same properties both pages are compared on (fonts, size, weight, color, spacing). */
async function computedStyle(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, marginTop: s.marginTop, marginBottom: s.marginBottom, lineHeight: s.lineHeight };
  });
}

/** The fraction of pixels that differ by more than a per-channel threshold, computed inside the browser (no
 *  pixelmatch/pngjs dependency): both screenshots are drawn onto same-size canvases and compared with getImageData. */
async function pixelDiffRatio(page: Page, pngA: Buffer, pngB: Buffer): Promise<number> {
  return page.evaluate(
    async ([a, b]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
      const [imgA, imgB] = await Promise.all([load(a), load(b)]);
      const w = Math.min(imgA.width, imgB.width);
      const h = Math.min(imgA.height, imgB.height);
      const draw = (img: HTMLImageElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
      };
      const [dataA, dataB] = [draw(imgA), draw(imgB)];
      const threshold = 40; // per channel: tolerant of anti-aliasing/hinting differences between the two DOMs
      let diff = 0;
      for (let i = 0; i < dataA.length; i += 4) {
        if (Math.abs(dataA[i]! - dataB[i]!) > threshold || Math.abs(dataA[i + 1]! - dataB[i + 1]!) > threshold || Math.abs(dataA[i + 2]! - dataB[i + 2]!) > threshold) diff++;
      }
      return diff / (w * h);
    },
    [`data:image/png;base64,${pngA.toString('base64')}`, `data:image/png;base64,${pngB.toString('base64')}`] as [string, string],
  );
}

test.describe('R-133: the canvas matches pagemd\'s own HTML output', () => {
  test('check 2: computed styles (font, size, weight, color, spacing) match exactly for a plain paragraph', async ({ page, browser }) => {
    const text = readFileSync(FIXTURE, 'utf8');
    const reference = await browser.newPage();
    await reference.setContent(pagemdReferenceHtml(text));

    await openOurs(page, text);

    const ours = await computedStyle(page, '.pmd-canvas p');
    const pagemds = await computedStyle(reference, '.document-content p');
    expect(ours).toEqual(pagemds);
    await reference.close();
  });

  test("check 3: one element-level screenshot (the paragraph) matches pagemd's, within a stated pixel tolerance", async ({ page, browser }) => {
    const text = readFileSync(FIXTURE, 'utf8');
    const reference = await browser.newPage();
    await reference.setContent(pagemdReferenceHtml(text));
    // A fixed viewport/width: text reflows differently at different widths, which would swamp a style-only check.
    await reference.setViewportSize({ width: 500, height: 400 });
    await page.setViewportSize({ width: 500, height: 400 });

    await openOurs(page, text);

    const pagemdShot = await reference.locator('.document-content p').first().screenshot();
    const oursShot = await page.locator('.pmd-canvas p').first().screenshot();
    const ratio = await pixelDiffRatio(page, pagemdShot, oursShot);
    // Stated tolerance: up to 35% of pixels may differ by more than 40/255 per channel. Two different DOM/CSS
    // engines' text rendering (sub-pixel positioning, anti-aliasing) easily accounts for this; a wrong font,
    // wrong color or wrong size produces a much larger difference (checked below, as a control).
    expect(ratio, `pixel difference ratio ${ratio}`).toBeLessThan(0.35);
    await reference.close();
  });

  test('control: two visibly different paragraphs fail the same pixel-tolerance check', async ({ page }) => {
    await page.setContent('<body style="margin:0"><p style="font:16px sans-serif;color:black;background:white;width:300px;height:80px">Some plain paragraph text with some emphasis.</p></body>');
    const a = await page.locator('p').screenshot();
    await page.setContent('<body style="margin:0"><p style="font:16px sans-serif;color:lime;background:navy;width:300px;height:80px">Some plain paragraph text with some emphasis.</p></body>');
    const b = await page.locator('p').screenshot();
    const ratio = await pixelDiffRatio(page, a, b);
    expect(ratio).toBeGreaterThan(0.35);
  });
});
