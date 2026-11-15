// FIX-CF (R-258): a crop with a `height` gives the picture a box; crop-fit decides how the cropped part (the red left half of the
// 400 x 200 wide.png) fills it. Measured on the canvas: the frame's size and place, and the pixels. Run: npm run test:e2e.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { resolveStyles, type StyleEnvironment } from '@pagemd-editor/style-pagemd';

const PAGEMD_ROOT = fileURLToPath(new URL('../../../pagemd/', import.meta.url)).replace(/\/$/, '');
const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixturesUrl = pathToFileURL(fixturesDir).href;
const FITS = ['cover', 'contain', 'fill', 'scale-down'] as const;
const DOC = [
  '# Fits',
  '',
  ...FITS.flatMap((fit) => [`<!-- ::FIGURE src="wide.png" crop-x="50" height="100px" crop-fit="${fit}" width="400px" -->`, '']),
  '::: annotated-image wide.png',
  'options: { crop-x: 50, height: 100px, crop-fit: contain, width: 400px }',
  'markers:',
  '  - { id: 1, x: 10, y: 50, label: "Red" }',
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


/** Decodes a PNG screenshot (8-bit RGB or RGBA, not interlaced) and counts its red, blue and white pixels. */
function colors(png: Buffer): { red: number; blue: number; white: number; total: number } {
  let pos = 8;
  let width = 0;
  let bpp = 4;
  const parts: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = png.readUInt32BE(pos + 8);
      bpp = png[pos + 17] === 6 ? 4 : 3;
    } else if (type === 'IDAT') parts.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * bpp;
  const rows = raw.length / (stride + 1);
  const out = Buffer.alloc(stride * rows);
  for (let y = 0; y < rows; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      const v = raw[y * (stride + 1) + 1 + x]!;
      const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (() => { const q = a + b - c; const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
      out[y * stride + x] = (v + p) & 255;
    }
  }
  const n = { red: 0, blue: 0, white: 0, total: width * rows };
  for (let i = 0; i < out.length; i += bpp) {
    const [r, g, b] = [out[i]!, out[i + 1]!, out[i + 2]!];
    if (r > 200 && g < 60 && b < 60) n.red++;
    else if (b > 200 && r < 60 && g < 60) n.blue++;
    else if (r > 235 && g > 235 && b > 235) n.white++;
  }
  return n;
}

for (const mode of ['web', 'print']) {
  test.describe(`FIX-CF: crop + height, crop-fit fills the box (${mode} view)`, () => {
  test('cover trims, contain and scale-down fit with empty space, fill stretches; never the blue half; markers stay on the picture', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 1000 });
    await openOurs2(page, mode);
    const boxes = page.locator('.pmd-canvas .image-box');
    await expect(boxes).toHaveCount(5); // the picture's size is read once the file has loaded, then the boxes are drawn
    const measure = async (i: number) => {
      const box = boxes.nth(i);
      const frame = box.locator('.image-frame');
      await box.evaluate((el) => el.scrollIntoView({ block: 'center' })); // clear of the sticky ribbon and ruler
      const [b, f] = [(await box.boundingBox())!, (await frame.boundingBox())!];
      const at = (await box.boundingBox())!;
      const shot = await page.screenshot({ clip: { x: Math.ceil(at.x), y: Math.ceil(at.y), width: Math.floor(at.width) - 1, height: Math.floor(at.height) - 1 } });
      return { b, f, colors: colors(shot) };
    };
    const [cover, contain, fill, scaleDown, annotated] = [await measure(0), await measure(1), await measure(2), await measure(3), await measure(4)];
    for (const m of [cover, contain, fill, scaleDown, annotated]) {
      expect(Math.round(m.b.height), 'the box takes the height').toBe(100);
      expect(m.colors.blue, 'the blue half is never shown').toBe(0);
    }
    const W = cover.b.width;
    expect(W).toBeGreaterThan(300);
    // cover: the cropped part (square) fills the box's width: the frame is twice as wide as the box, and as tall as the box is wide
    expect(cover.f.width).toBeCloseTo(2 * W, 0);
    expect(cover.f.height).toBeCloseTo(W, 0);
    expect(cover.colors.white, 'cover leaves no empty space').toBeLessThan(cover.colors.total * 0.02);
    // contain: the square part fits the 100px height; the frame is 200 x 100, the part centered with empty space either side
    expect(contain.f.width).toBeCloseTo(200, 0);
    expect(contain.f.height).toBeCloseTo(100, 0);
    expect(contain.colors.white, 'contain leaves empty space').toBeGreaterThan(contain.colors.total * 0.4);
    expect(contain.colors.red, 'contain shows the red part').toBeGreaterThan(contain.colors.total * 0.15);
    expect(scaleDown.f.width).toBeCloseTo(200, 0);
    expect(scaleDown.colors.white).toBeGreaterThan(scaleDown.colors.total * 0.4);
    // fill: stretched to the box
    expect(fill.f.width).toBeCloseTo(2 * W, 0);
    expect(fill.f.height).toBeCloseTo(100, 0);
    expect(fill.colors.white).toBeLessThan(fill.colors.total * 0.02);
    // the annotated image: the same box; its marker is on the picture's point (10%, 50% of the whole picture: x = 10% of the frame)
    const marker = (await page.locator('.pmd-canvas .annotated-image-container .marker').boundingBox())!;
    expect(marker.x + marker.width / 2).toBeCloseTo(annotated.f.x + annotated.f.width * 0.1, 0);
    expect(marker.y + marker.height / 2).toBeCloseTo(annotated.f.y + annotated.f.height * 0.5, 0);
  });
});
}
