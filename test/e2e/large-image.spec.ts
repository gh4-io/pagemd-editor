// P13b (amendment 11, acceptance 8, AD-P13-07): a picture over 4000 px on a side is shown from a smaller copy, at most twice its
// shown width, with its real width and height kept so the pages lay out as with the file itself; the file is never touched; and the
// browser holds much less memory for it. The decision is unit-tested (packages/components/canvas/test/large-images.test.ts).
// Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeBigPng } from './fixtures/big-picture.ts';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const DOC = '# Big picture\n\nBefore.\n\n![The big one](big.png)\n\nAfter.\n';
const WIDTH = 8000;
const HEIGHT = 6000;


async function open(page: Page, folder: string, text = DOC): Promise<void> {
  await page.goto(pageUrl);
  await expect.poll(async () => (await sent(page)).some((m) => m.kind === 'event' && m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text, version: 1, fileName: 'a.md', documentBase: `${pathToFileURL(folder).href}/`, testing: true, styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [], mermaidScript: '' },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
}

/**
 * The pretend host answers `readAsset` (the canvas asks for the picture's bytes to make its copy) with the file, or with a refusal
 * (`file` null: the host will not read it, so the picture keeps showing from the file, as it did before P13b). Stops with the page.
 */
function answerReads(page: Page, file: string | null): void {
  const b64 = file ? readFileSync(file).toString('base64') : '';
  let answered = 0;
  const timer = setInterval(() => {
    void (async () => {
      const requests = (await sent(page)).filter((m) => m.method === 'readAsset');
      for (; answered < requests.length; answered++) {
        const id = requests[answered]!.id;
        await page
          .evaluate(
            ({ id, b64, ok }) => {
              const bin = atob(b64);
              const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
              (window as unknown as { __fromHost(m: unknown): void }).__fromHost(ok ? { kind: 'response', id, ok: true, result: bytes } : { kind: 'response', id, ok: false, error: 'Not read.' });
            },
            { id, b64, ok: !!file },
          )
          .catch(() => undefined);
      }
    })().catch(() => clearInterval(timer));
  }, 100);
  page.once('close', () => clearInterval(timer));
}

/** Resident memory of every process of the page's browser, in MB (Linux only: /proc). */
async function browserMemoryMb(page: Page): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  const client = await page.context().browser()!.newBrowserCDPSession();
  const { processInfo } = (await client.send('SystemInfo.getProcessInfo')) as { processInfo: { id: number }[] };
  let kb = 0;
  for (const { id } of processInfo) {
    try {
      kb += Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${id}/status`, 'utf8'))?.[1] ?? 0);
    } catch {
      /* the process ended */
    }
  }
  await client.detach();
  return Math.round(kb / 1024);
}

const pages = (page: Page) => page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: unknown[] } | null } } }).__pmd.pagination.layout?.pages.length ?? 0);
const picture = (page: Page) =>
  page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>('.pmd-canvas img[alt="The big one"]')!;
    return { src: img.getAttribute('src')!.slice(0, 30), full: img.getAttribute('data-pmd-full-src'), natural: [img.naturalWidth, img.naturalHeight], shown: [img.offsetWidth, img.offsetHeight], attrs: [img.getAttribute('width'), img.getAttribute('height')] };
  });

test.describe('a picture of 8000 x 6000', () => {
  let folder: string;
  test.beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'pmd-big-'));
    writeBigPng(join(folder, 'big.png'), WIDTH, HEIGHT);
  });
  test.afterAll(() => rmSync(folder, { recursive: true, force: true }));

  test('is shown from a copy of at most twice its shown width, shown as the file is, the file named by data-pmd-full-src', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    answerReads(page, join(folder, 'big.png'));
    await open(page, folder);
    await expect.poll(async () => (await picture(page)).src, { timeout: 30000 }).toMatch(/^data:image\/webp/);
    const copy = await picture(page);
    expect(copy.full).toBe('big.png');
    // the copy is at most 2 x the width the picture is shown at (and smaller than the file)
    await expect.poll(async () => (await picture(page)).natural[0]!).toBeLessThanOrEqual(2 * copy.shown[0]!);
    const after = await picture(page);
    expect(after.natural[0]).toBeGreaterThan(0);
    expect(after.natural[0]).toBeLessThan(WIDTH);
    // it is shown with the proportions of the file (the page's rules hold the copy as they held the file)
    expect(after.shown[0]! / after.shown[1]!).toBeCloseTo(WIDTH / HEIGHT, 1);
    expect(errors).toEqual([]);
  });

  test('a changed file is read again: assetsChanged points the picture at the file and a new copy follows', async ({ page }) => {
    answerReads(page, join(folder, 'big.png'));
    await open(page, folder);
    await expect.poll(async () => (await picture(page)).full, { timeout: 30000 }).toBe('big.png');
    await fromHost(page, { kind: 'event', name: 'assetsChanged', data: { paths: ['big.png'] } });
    await expect.poll(async () => (await picture(page)).full, { timeout: 30000 }).toMatch(/^big\.png\?v=\d+$/);
    expect((await picture(page)).src).toMatch(/^data:image\/webp/);
    expect((await sent(page)).filter((m) => m.method === 'readAsset').length).toBe(2);
  });

  // Measured (WSL 2, Chromium 1xx, Node 24): the whole browser holds about 660 MB with the file, about 525 MB with the copy (a page with no
  // picture: about 360 MB), the same in every run. A picture that was painted is decoded (190 MB) and the browser keeps that.
  test('the pages are the same as with the file itself, and the browser holds at least 100 MB less (Linux)', async ({ browser }) => {
    test.setTimeout(120_000);
    const run = async (copy: boolean) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      // without a copy: the host refuses to read it, so the picture keeps showing from the file (the way it was before P13b)
      answerReads(page, copy ? join(folder, 'big.png') : null);
      await open(page, folder);
      await page.setViewportSize({ width: 1000, height: 800 });
      await expect.poll(async () => (await picture(page)).natural[0], { timeout: 30000 }).toBeGreaterThan(0);
      if (copy) await expect.poll(async () => (await picture(page)).src, { timeout: 30000 }).toMatch(/^data:image\//);
      else await page.waitForTimeout(2000); // the host's refusal arrives; nothing changes
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500); // the browser lets go of what it decoded for the file
      const result = { pages: await pages(page), memory: await browserMemoryMb(page), shown: (await picture(page)).shown };
      await context.close();
      return result;
    };
    const file = await run(false);
    const copy = await run(true);
    console.log(`[P13b large picture] ${WIDTH}x${HEIGHT}: pages ${file.pages} (file) / ${copy.pages} (copy); browser memory ${file.memory} MB (file) / ${copy.memory} MB (copy); shown ${JSON.stringify(file.shown)} / ${JSON.stringify(copy.shown)}`);
    expect(copy.pages).toBe(file.pages);
    expect(copy.shown).toEqual(file.shown);
    if (file.memory !== null && copy.memory !== null) expect(file.memory - copy.memory).toBeGreaterThanOrEqual(100);
  });
});
