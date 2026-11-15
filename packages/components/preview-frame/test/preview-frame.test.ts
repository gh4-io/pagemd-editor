// FIX-PGF (item 1): Print Preview's attempts, stage by stage, on a small stand-in for the browser's DOM (Vitest has none here).
// What was left over after leaving Print Preview mid-render (the state stayed "busy" and the half-made page kept running), a stuck
// send of the typing (it held the preview back and was blamed on the renderer), a load event of an earlier page, and the stages
// said in the status and the log.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreviewResult } from '@pagemd-editor/core';
import { BLANK_PAGE, busyText, markAttempt, PreviewFrame, type PreviewStageEvent } from '../src/index.ts';

// ── a stand-in DOM: only what PreviewFrame touches ──
type Listener = () => void;
class FakeElement {
  readonly tag: string;
  className = '';
  hidden = false;
  textContent = '';
  title = '';
  type = '';
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<Listener>>();
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(name: string, listener: Listener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: Listener): void {
    this.listeners.get(name)?.delete(listener);
  }
  fire(name: string): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener();
  }
}

/** A frame whose page "loads" a moment after srcdoc is set; a page containing COMPLETE says Paged.js is done (5 pages). */
class FakeFrame extends FakeElement {
  #srcdoc: string | null = null;
  contentDocument: unknown = null;
  contentWindow: Record<string, unknown> | null = null;
  /** Loads still on their way, in order (the test fires them). */
  readonly pendingLoads: { html: string }[] = [];
  autoLoad = true;
  get srcdoc(): string {
    return this.#srcdoc ?? '';
  }
  set srcdoc(html: string) {
    this.#srcdoc = html;
    this.#navigate(html);
  }
  removeAttribute(name: string): void {
    if (name === 'srcdoc') {
      this.#srcdoc = null;
      this.#navigate('');
    }
  }
  get hasSrcdoc(): boolean {
    return this.#srcdoc !== null;
  }
  #navigate(html: string): void {
    const load = { html };
    this.pendingLoads.push(load);
    if (this.autoLoad) setTimeout(() => this.finishLoad(load), 5);
  }
  /** The page `load` finished loading: it becomes the frame's document, and `load` fires. */
  finishLoad(load = this.pendingLoads[0]): void {
    if (!load || !this.pendingLoads.includes(load)) return;
    this.pendingLoads.splice(this.pendingLoads.indexOf(load), 1);
    const attempt = /data-pmd-attempt="(\d+)"/.exec(load.html)?.[1] ?? null;
    const head = new FakeElement('head');
    this.contentDocument = {
      documentElement: { getAttribute: (name: string) => (name === 'data-pmd-attempt' ? attempt : null) },
      head,
      createElement: (tag: string) => new FakeElement(tag),
      addEventListener: () => undefined,
      querySelectorAll: () => ({ length: Number(/PAGES=(\d+)/.exec(load.html)?.[1] ?? (load.html.includes('COMPLETE') ? 5 : 0)) }),
    };
    this.contentWindow = load.html.includes('COMPLETE') ? { __pagedjs_complete: true } : {};
    this.fire('load');
  }
}

const realDocument = (globalThis as { document?: unknown }).document;
beforeEach(() => {
  (globalThis as { document?: unknown }).document = { createElement: (tag: string) => (tag === 'iframe' ? new FakeFrame(tag) : new FakeElement(tag)) };
});
afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

/** A promise and the hands that settle it. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const PAGE: PreviewResult = { html: '<!doctype html><html lang="en"><body>COMPLETE</body></html>', provider: 'pagemd', colorScheme: 'light' };

function setup(options: { send?: () => Promise<void> } = {}) {
  const answers: { resolve(value: PreviewResult): void }[] = [];
  const stages: PreviewStageEvent[] = [];
  const parent = new FakeElement('div');
  const preview = new PreviewFrame(parent as unknown as HTMLElement, {
    ...options,
    request: () => {
      const answer = deferred<PreviewResult>();
      answers.push(answer);
      return answer.promise;
    },
    onStage: (event) => stages.push(event),
  });
  const frame = preview.frame as unknown as FakeFrame;
  const status = (): string => (preview.element as unknown as FakeElement).children[0]!.children[1]!.textContent;
  return { preview, frame, answers, stages, status };
}

const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 5))) if (check()) return;
  throw new Error('timed out');
};

describe('Print Preview attempts (FIX-PGF)', () => {
  it('leaving Print Preview mid-render leaves nothing behind; showing it again starts clean', async () => {
    const { preview, frame, answers } = setup();
    void preview.show();
    await until(() => answers.length === 1);
    expect(preview.state.busy).toBe(true);
    preview.hide(); // e.g. Print Layout while pagemd is still making the page
    // Before the fix, the state stayed "busy" ("Rendering…") until the preview was shown again.
    expect(preview.state.busy).toBe(false);
    expect(preview.stage).toBe(null);
    // The first attempt's answer arrives late: it is not put into the frame.
    answers[0]!.resolve(PAGE);
    await new Promise((r) => setTimeout(r, 30));
    expect(frame.srcdoc).toBe(BLANK_PAGE);
    expect(preview.state.busy).toBe(false);
    // Showing it again: a new attempt, which finishes.
    const shown = preview.show();
    await until(() => answers.length === 2);
    answers[1]!.resolve(PAGE);
    await shown;
    expect(preview.state).toMatchObject({ busy: false, pages: 5, provider: 'pagemd', message: null });
  });

  it('leaving it while the page is loading or laid out takes the half-made page out of the frame', async () => {
    const { preview, frame, answers } = setup();
    frame.autoLoad = false;
    void preview.show();
    await until(() => answers.length === 1);
    answers[0]!.resolve({ ...PAGE, html: '<!doctype html><p>slow layout</p>' });
    await until(() => frame.pendingLoads.length === 1);
    expect(preview.stage).toBe('load');
    preview.hide();
    expect(frame.srcdoc).toBe(BLANK_PAGE); // its scripts (Paged.js) stop with it
    expect(preview.state.busy).toBe(false);
  });

  it('a send of the typing that never finishes does not hold the preview back; the status says the newest typing may be missing', async () => {
    const { preview, answers, stages } = setup({ send: () => new Promise<void>(() => undefined) });
    preview.limits.send = 40;
    const shown = preview.show();
    await until(() => answers.length === 1); // before the fix, the renderer was never asked
    answers[0]!.resolve(PAGE);
    await shown;
    expect(preview.state.busy).toBe(false);
    expect(preview.state.pages).toBe(5);
    expect(preview.state.message).toMatch(/newest typing had not reached VS Code yet/);
    expect(stages.filter((s) => s.stage === 'send').map((s) => s.event)).toEqual(['start', 'stopped']);
  });

  it('a load event of an earlier page is never taken for the page of this attempt', async () => {
    const { preview, frame, answers } = setup();
    frame.autoLoad = false;
    void preview.show();
    await until(() => answers.length === 1);
    answers[0]!.resolve({ ...PAGE, html: '<!doctype html><p>first COMPLETE PAGES=2</p>' }); // an older page, laid out in 2 pages
    await until(() => frame.pendingLoads.length === 1);
    const refreshed = preview.refresh(); // Refresh (or a save) while the first page loads
    await until(() => answers.length === 2);
    answers[1]!.resolve(PAGE);
    await until(() => frame.pendingLoads.length === 2);
    frame.finishLoad(frame.pendingLoads[0]); // the FIRST page's load fires now
    await new Promise((r) => setTimeout(r, 120));
    // Before the fix, attempt 2 took that load for its own, and reported the older page's 2 pages as done.
    expect(preview.state.busy).toBe(true); // still waiting for its own page
    expect(preview.state.pages).toBe(null);
    frame.finishLoad(frame.pendingLoads[0]);
    await refreshed;
    expect(preview.state).toMatchObject({ busy: false, pages: 5 });
  });

  it('says each stage in the status and reports it (start and end, in order)', async () => {
    const sent = deferred<void>();
    const { preview, answers, stages, status } = setup({ send: () => sent.promise });
    const shown = preview.show();
    expect(status()).toBe('Rendering… sending your typing to VS Code');
    sent.resolve();
    await until(() => answers.length === 1);
    expect(status()).toBe('Rendering… pagemd is making the page');
    answers[0]!.resolve(PAGE);
    await shown;
    expect(status()).toBe('5 pages');
    expect(stages.map((s) => `${s.attempt} ${s.stage} ${s.event}`)).toEqual([
      '1 send start', '1 send done', '1 render start', '1 render done', '1 load start', '1 load done', '1 layout start', '1 layout done',
    ]);
  });

  it('a newer attempt drops the one running (said as dropped, with its number)', async () => {
    const { preview, answers, stages } = setup();
    void preview.show();
    await until(() => answers.length === 1);
    void preview.refresh();
    expect(stages.map((s) => `${s.attempt} ${s.stage} ${s.event}`)).toEqual(['1 render start', '1 render dropped', '2 render start']);
  });
});

describe('the status and the attempt mark (FIX-PGF)', () => {
  it('busyText names the stage, and counts seconds once it takes a while', () => {
    expect(busyText(null, 0)).toBe('Rendering…');
    expect(busyText('layout', 1200)).toBe('Rendering… laying out the pages');
    expect(busyText('render', 12500)).toBe('Rendering… pagemd is making the page (12 s)');
    expect(busyText('load', 3000)).toBe('Rendering… loading pictures and fonts (3 s)');
  });

  it('markAttempt marks the <html> element, with or without one in the page', () => {
    expect(markAttempt('<!doctype html><html lang="en"><body></body></html>', 3)).toBe('<!doctype html><html data-pmd-attempt="3" lang="en"><body></body></html>');
    expect(markAttempt('<!doctype html><p>x</p>', 2)).toBe('<!doctype html><html data-pmd-attempt="2"><p>x</p>');
    expect(markAttempt('<p>x</p>', 1)).toBe('<html data-pmd-attempt="1"><p>x</p>');
  });
});
