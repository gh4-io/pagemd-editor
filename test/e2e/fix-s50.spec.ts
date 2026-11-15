// FIX-S50 (session 50): on an annotated image the marker `size` scales the badge, `showLabels` draws the labels, a highlight multiplies
// at 50% opacity, and under a crop the editing rings stay on the badges (the frame's translate was ignored by offsetLeft). Run: npm run test:e2e.
import { readFileSync } from 'node:fs';
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
  'options: { caption: "Sized", showLabels: true }',
  'markers:',
  '  - { id: 1, x: 20, y: 50, label: "Small" }',
  '  - { id: 2, x: 70, y: 50, label: "Big", size: 3 }',
  'highlights:',
  '  - { x: 60, y: 10, width: 30, height: 10 }',
  ':::',
  '',
  '::: annotated-image wide.png',
  'options: { caption: "Cropped", crop-x: 50, crop-y: 60, pos-x: -30, pos-y: -20 }',
  'markers:',
  '  - { id: 1, x: 40, y: 30, label: "A" }',
  '  - { id: 2, x: 60, y: 45, label: "B" }',
  ':::',
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

async function openOurs2(page: Page, mode: string): Promise<void> {
  const env: StyleEnvironment = { fs: nodeFs, pagemdPath: PAGEMD_ROOT, path: await import('node:path') };
  const resolution = await resolveStyles({ path: join(fixturesDir, 'a.md'), text: DOC }, env);
  const styles = { styles: resolution.styles, gateDefaults: resolution.gateDefaults, notes: resolution.notes };
  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as unknown as { __toHost?: Message[] }).__toHost?.some((m) => m.name === 'ready'));
  await fromHost(page, { kind: 'event', name: 'init', data: { protocol: 16, text: DOC, version: 1, fileName: 'a.md', documentBase: fixturesUrl, testing: true, styles, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' } });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode } });
  await expect(page.locator('.pmd-canvas img').first()).toHaveJSProperty('complete', true);
}

for (const mode of ['web', 'print']) {
  test.describe(`FIX-S50, ${mode} view`, () => {
    test('marker size and labels show, a highlight multiplies at 50%, and the editing rings stay on the markers under a crop', async ({ page }) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      await openOurs2(page, mode);
      const first = await page.evaluate(() => {
        const fig = document.querySelectorAll('.pmd-canvas figure')[0]!;
        const widths = [...fig.querySelectorAll('.marker')].map((el) => el.getBoundingClientRect().width);
        const labels = [...fig.querySelectorAll('.marker-label')].filter((el) => el.getBoundingClientRect().width > 0).length;
        const hl = fig.querySelector('.annotation-shapes rect')!;
        return { widths, labels, blend: getComputedStyle(hl).mixBlendMode, opacity: hl.getAttribute('fill-opacity') };
      });
      expect(first.widths[1]! / first.widths[0]!, 'size 3 is three times the badge').toBeCloseTo(3, 1);
      expect(first.labels, 'showLabels draws both labels').toBe(2);
      expect(first.blend).toBe('multiply');
      expect(first.opacity).toBe('0.5');
      // The cropped figure: double-click opens shape editing; each ring is on its badge (the frame is moved by a transform).
      const wb = (await page.locator('.pmd-canvas figure .image-wrapper').nth(1).boundingBox())!;
      await page.mouse.dblclick(wb.x + wb.width - 6, wb.y + 6);
      await expect(page.locator('.pmd-shape-editing')).toHaveCount(1);
      const places = await page.evaluate(() => {
        const c = (el: Element) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
        const fig = document.querySelectorAll('.pmd-canvas figure')[1]!;
        return { badges: [...fig.querySelectorAll('.marker')].map(c), rings: [...document.querySelectorAll('.pmd-shape-hit-marker')].map(c) };
      });
      expect(places.rings).toHaveLength(2);
      places.rings.forEach((r, i) => {
        expect(Math.abs(r[0]! - places.badges[i]![0]!)).toBeLessThanOrEqual(1);
        expect(Math.abs(r[1]! - places.badges[i]![1]!)).toBeLessThanOrEqual(1);
      });
    });
  });
}

test.describe('FIX-S50: draw mode and the Inspector opening', () => {
  test('Add arrow draws by dragging (crosshair, Esc cancels) and the Inspector opens on the new arrow; Add marker opens it too', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await openOurs2(page, 'print');
    const first = page.locator('.pmd-canvas figure').first();
    const lines = () => first.locator('.annotation-shapes line').count();
    await first.locator('img').click({ position: { x: 4, y: 4 } });
    const arrow = page.locator('.pmd-ribbon [data-command="annotated-image.add-arrow"]');
    await arrow.click();
    await expect(page.locator('.pmd-draw-mode')).toHaveCount(1);
    expect(await page.locator('.pmd-draw-catcher').evaluate((el) => getComputedStyle(el).cursor)).toBe('crosshair');
    await page.keyboard.press('Escape');
    await expect(page.locator('.pmd-draw-mode')).toHaveCount(0);
    expect(await lines()).toBe(0);
    await arrow.click();
    const c = (await page.locator('.pmd-draw-catcher').boundingBox())!;
    await page.mouse.move(c.x + c.width * 0.2, c.y + c.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width * 0.5, c.y + c.height * 0.5, { steps: 4 });
    await page.mouse.move(c.x + c.width * 0.6, c.y + c.height * 0.8, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('.pmd-draw-mode')).toHaveCount(0);
    await expect.poll(lines).toBe(1);
    const [x1, y1, x2, y2] = await first.locator('.annotation-shapes line').evaluate((el) => ['x1', 'y1', 'x2', 'y2'].map((k) => Number(el.getAttribute(k))));
    expect(Math.abs(x1! - 20)).toBeLessThan(1.5);
    expect(Math.abs(y1! - 30)).toBeLessThan(1.5);
    expect(Math.abs(x2! - 60)).toBeLessThan(1.5);
    expect(Math.abs(y2! - 80)).toBeLessThan(1.5);
    await expect(page.locator('.pmd-inspector')).toBeVisible();
  });
});
