// Shared by the pagination specs (P6): open a document in the test harness with the styles style-pagemd resolves
// from the real pagemd checkout, switch to Print Layout, and wait for the pages to settle.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { fromHost } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { filesInUse, resolveStyles, type StyleEnvironment } from '@pagemd-editor/style-pagemd';
import type { FilesInUse } from '@pagemd-editor/core';

export const PAGEMD_ROOT = fileURLToPath(new URL('../../../pagemd/', import.meta.url)).replace(/\/$/, '');
const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;

/** The resolver's async FileSystem port over real files. */
const nodeFs: StyleEnvironment['fs'] = {
  exists: async (p) => {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  },
  readText: async (p) => readFileSync(p, 'utf8'),
  stat: async (p) => {
    try {
      const s = statSync(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  list: async (p) => readdirSync(p),
};

type Message = { kind: string; name?: string };

/** The styles payload the host would send for `text` as the file at `path` (style-pagemd over the real files). */
export async function stylesFor(path: string, text: string, extra: Partial<StyleEnvironment> = {}): Promise<{ styles: unknown; gateDefaults: unknown; notes: unknown; properties: unknown }> {
  const env: StyleEnvironment = { fs: nodeFs, pagemdPath: PAGEMD_ROOT, path: nodePath, cwd: nodePath.dirname(path), ...extra };
  const resolution = await resolveStyles({ path, text }, env);
  return { styles: resolution.styles, gateDefaults: resolution.gateDefaults, notes: resolution.notes, properties: resolution.properties };
}

/** P25: the Files in Use report the host would answer for `text` as the file at `path` (style-pagemd over the real files). */
export async function filesReportFor(path: string, text: string, extra: Partial<StyleEnvironment> = {}): Promise<FilesInUse> {
  const env: StyleEnvironment = { fs: nodeFs, pagemdPath: PAGEMD_ROOT, path: nodePath, cwd: nodePath.dirname(path), ...extra };
  return filesInUse(await resolveStyles({ path, text }, env), env);
}

/** P25: answers the page's `filesInUse` request number `nth` (0 = the first) with `report`. */
export async function answerFilesInUse(page: Page, report: FilesInUse, nth = 0): Promise<void> {
  let request: { id?: number } | undefined;
  await expect.poll(async () => (request = (await page.evaluate(() => (window as unknown as { __toHost: { kind: string; method?: string; id?: number }[] }).__toHost)).filter((m) => m.kind === 'request' && m.method === 'filesInUse')[nth])).toBeTruthy();
  await fromHost(page, { kind: 'response', id: request!.id, ok: true, result: report });
}

/** Opens `text` (as if it were the file at `path`) in Print Layout and waits until the pages are settled. */
/** `extra`: more of the host's environment (phase L2: `sharedProfilesPath`, the shared profiles folder). */
export async function openInPrintLayout(page: Page, path: string, text: string, documentBase: string, extra: Partial<StyleEnvironment> = {}): Promise<void> {
  const { styles: resolved, gateDefaults, notes } = await stylesFor(path, text, extra);
  const styles = { styles: resolved, gateDefaults, notes };
  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as unknown as { __toHost?: Message[] }).__toHost?.some((m) => m.name === 'ready'));
  await fromHost(page, { kind: 'event', name: 'init', data: { protocol: PROTOCOL, text, version: 1, fileName: nodePath.basename(path), documentBase, testing: true, styles, settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href } });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  await fromHost(page, { kind: 'event', name: 'setView', data: { mode: 'print' } });
  await settle(page);
}

/** Waits for fonts and images, then runs the pagination until two runs agree (gap margins estimated at first). */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images]
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            }),
        ),
    );
    const { pagination } = (window as unknown as { __pmd: { pagination: { run(): { pages: unknown[] } | null } } }).__pmd;
    let last = '';
    for (let i = 0; i < 6; i++) {
      const layout = pagination.run();
      const sig = JSON.stringify((layout?.pages ?? []).map((p) => (p as { pos: number | null }).pos));
      if (sig === last) break;
      last = sig;
    }
  });
}

export async function pageCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: unknown[] } | null } } }).__pmd.pagination.layout?.pages.length ?? 0);
}

/**
 * The pages that hold part of the document's text (P18: since the template is drawn, a page may hold only template parts, e.g. a
 * title page). What R-146's reference counts (`bodyPages`) are compared with.
 */
export async function bodyPageCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __pmd: { pagination: { layout: { pages: Array<{ body: boolean }> } | null } } }).__pmd.pagination.layout?.pages.filter((p) => p.body).length ?? 0);
}
