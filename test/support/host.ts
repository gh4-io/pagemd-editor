// T2: the pretend VS Code every e2e spec needs, once. It was copied into 28 specs (`open()`) and 6 (`Host`), word for word in places.
//  - openEditor(): load the harness page (test/e2e/webview.html), send `init`, wait until the webview is ready, optionally switch view.
//  - PretendHost: answers the canvas's edits like VS Code (version, undo and redo stacks) and reports undo/redo as an outside change.
// A spec with a different shape (extra init data, a different host) passes `init` or keeps its own; the point is that the common case is here.
import { expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { PROTOCOL } from './protocol.ts';

export type Message = { kind: string; id?: number; name?: string; method?: string; data?: unknown; params?: unknown };
export type Edit = { from: number; to: number; text: string };

export const pageUrl = pathToFileURL(new URL('../e2e/webview.html', import.meta.url).pathname).href;
export const fixtures = pathToFileURL(new URL('../e2e/fixtures/', import.meta.url).pathname).href;

export const sent = (page: Page) => page.evaluate(() => (window as unknown as { __toHost: Message[] }).__toHost);
export const fromHost = (page: Page, message: unknown) => page.evaluate((m) => (window as unknown as { __fromHost(m: unknown): void }).__fromHost(m), message);

/** The text after the edits, which are in file order and do not overlap (what the webview sends). */
export function apply(text: string, list: readonly Edit[]): string {
  let out = '';
  let at = 0;
  for (const e of list) {
    out += text.slice(at, e.from) + e.text;
    at = e.to;
  }
  return out + text.slice(at);
}

export interface OpenOptions {
  /** Which view to switch to once ready (`print`, `web`, `draft`, `read`, …); the harness starts in Print Layout. */
  mode?: string;
  /** Merged over the default `init` data (settings, styles, documentBase, …). */
  init?: Record<string, unknown>;
}

/** Opens the editor on `text` and returns the page errors seen so far (check them empty at the end) and a PretendHost that answers its edits. */
export async function openEditor(page: Page, text: string, options: OpenOptions = {}): Promise<{ host: PretendHost; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await expect.poll(async () => (await sent(page)).some((m) => m.kind === 'event' && m.name === 'ready')).toBe(true);
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: {
      protocol: PROTOCOL,
      text,
      version: 1,
      eol: '\n',
      fileName: 'a.md',
      documentBase: fixtures,
      testing: true,
      styles: { styles: null, gateDefaults: {}, notes: [] },
      settings: { gatedInsert: 'ask', commentAuthor: 'Test Author' },
      output: [],
      mermaidScript: '',
      ...options.init,
    },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (options.mode) await fromHost(page, { kind: 'event', name: 'setView', data: { mode: options.mode } });
  return { host: new PretendHost(page, text), errors };
}

/** A pretend VS Code: answers the canvas's edits, keeps an undo stack, and reports undo / redo as an outside change. */
export class PretendHost {
  answered = 0;
  version = 1;
  readonly undoStack: string[] = [];
  readonly redoStack: string[] = [];
  constructor(
    readonly page: Page,
    public text: string,
  ) {}

  /** Answers the edits sent so far; resolves once `until` holds for the text (or the time is up). */
  async settle(until: (text: string) => boolean = () => true, ms = 6000): Promise<string> {
    await expect
      .poll(
        async () => {
          const requests = (await sent(this.page)).filter((m) => m.method === 'applyEdits');
          for (; this.answered < requests.length; this.answered++) {
            const r = requests[this.answered]!;
            const { edits } = r.params as { edits: Edit[] };
            if (edits.length > 0) {
              this.undoStack.push(this.text);
              this.redoStack.length = 0;
              this.text = apply(this.text, edits);
              this.version++;
            }
            await fromHost(this.page, { kind: 'response', id: r.id, ok: true, result: { status: 'ok', version: this.version } });
          }
          return until(this.text);
        },
        { timeout: ms },
      )
      .toBe(true);
    return this.text;
  }

  /** VS Code's undo (Ctrl+Z): the text before the last edit, reported to the page as a change from outside. */
  async undo(): Promise<void> {
    await this.settle();
    this.redoStack.push(this.text);
    this.text = this.undoStack.pop()!;
    this.version++;
    await fromHost(this.page, { kind: 'event', name: 'externalChange', data: { text: this.text, version: this.version, eol: '\n' } });
  }

  /** VS Code's redo (Ctrl+Y). */
  async redo(): Promise<void> {
    this.undoStack.push(this.text);
    this.text = this.redoStack.pop()!;
    this.version++;
    await fromHost(this.page, { kind: 'event', name: 'externalChange', data: { text: this.text, version: this.version, eol: '\n' } });
  }
}
