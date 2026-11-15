// Print Preview's frame (P10, R-170 Q5): the exact page an output provider made, in a frame filled from text (`srcdoc`),
// read-only. The frame inherits the editor page's Content Security Policy, so only scripts carrying the page's nonce run
// (Paged.js, mermaid, pagemd's own); the document's own scripts and inline handlers don't. It is sandboxed (no forms,
// pop-ups, top navigation or dialogs); `allow-same-origin` is kept so images load through the webview like the canvas's
// and the page count can be read (AD-P10-06). It refreshes when shown, on save and from its Refresh button (R-10: on demand).
import type { PreviewResult } from '@pagemd-editor/core';

export interface PreviewState {
  /** Rendering (asking the host, or Paged.js laying out). */
  busy: boolean;
  /** Pages Paged.js made (null: not finished, or a plain-HTML page). */
  pages: number | null;
  /** Which provider made the page ('pagemd' or 'html'). */
  provider: string | null;
  /** Diagrams drawn (pagemd's preview), or null. */
  diagrams: number | null;
  /** Why the page isn't pagemd's, or what went wrong. */
  message: string | null;
}

export interface PreviewFrameOptions {
  /**
   * FIX-PGF: sends the canvas's typing to VS Code first (the page is made from the text VS Code has). Its own stage with its own
   * limit: when it does not finish, the preview goes on with the text VS Code has and says so (a stuck send never blocks Print
   * Preview for good, and is never blamed on the renderer).
   */
  send?(): Promise<void>;
  /** Asks the host for the page (the document as VS Code has it now). */
  request(): Promise<PreviewResult>;
  /** FIX-PGF: each stage of each attempt starting, finishing, stopping or being dropped (the app writes it to the log). */
  onStage?(event: PreviewStageEvent): void;
  /** The state changed (the status bar shows it). */
  onState?(state: PreviewState): void;
  /** A link was clicked in the preview: the app opens it (the frame itself never navigates). */
  onLink?(href: string): void;
  /** How long to wait for Paged.js before giving up on a page count (ms). */
  timeoutMs?: number;
  /** How long to wait for the host's page (ms). */
  requestTimeoutMs?: number;
  /** How long to wait for the page to load in the frame (ms). */
  loadTimeoutMs?: number;
}

/** FIX-PGF: the stages of one attempt, in order: the typing sent to VS Code, pagemd making the page, the page loading, Paged.js. */
export type PreviewStage = 'send' | 'render' | 'load' | 'layout';

/** FIX-PGF: what the status says while a stage runs ("Rendering… laying out the pages"), so a report names the stage. */
export const STAGE_LABELS: Readonly<Record<PreviewStage, string>> = {
  send: 'sending your typing to VS Code',
  render: 'pagemd is making the page',
  load: 'loading pictures and fonts',
  layout: 'laying out the pages',
};

export interface PreviewStageEvent {
  /** Which attempt (1, 2, …): a Refresh, a save or showing the preview again starts a new one. */
  attempt: number;
  stage: PreviewStage;
  /** 'dropped': a newer attempt (or leaving Print Preview) replaced this one while the stage ran. */
  event: 'start' | 'done' | 'stopped' | 'dropped';
  /** Time since the stage started (0 for 'start'). */
  ms: number;
  detail?: string;
}

/** FIX-preview: how long each stage may take before the preview stops waiting and says so (ms). Never "Rendering…" for good. */
export interface PreviewLimits {
  /** FIX-PGF: the typing reaching VS Code (then the preview goes on without the newest typing). */
  send: number;
  /** The host's answer (pagemd renders the page). */
  request: number;
  /** The page loading in the frame (its pictures and scripts). */
  load: number;
  /** Paged.js laying out the pages (pagemd's completion flag). */
  layout: number;
}

export const PREVIEW_LIMITS: Readonly<PreviewLimits> = { send: 10000, request: 120000, load: 60000, layout: 120000 };

/** FIX-PGF: from this long on, the status also counts the seconds of the stage ("… (12 s)"). */
const SHOW_SECONDS_AFTER_MS = 3000;

/** How long a page error may stand without the layout finishing before the preview reports it (ms). */
const ERROR_GRACE_MS = 2000;

const seconds = (ms: number): string => `${ms >= 10000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10} seconds`;
const TRY_AGAIN = 'Use Refresh to try again.';
/** FIX-PGF: what the frame shows after Print Preview was left mid-render. */
export const BLANK_PAGE = '<!doctype html><html><body></body></html>';
const LATE_TYPING = 'Your newest typing had not reached VS Code yet, so it may be missing here.';

/**
 * FIX-PGF: marks the page of one attempt (`data-pmd-attempt` on its <html>), so a load event of an earlier page (one a newer
 * attempt replaced) is never taken for this one.
 */
export function markAttempt(html: string, attempt: number): string {
  const mark = ` data-pmd-attempt="${attempt}"`;
  if (/<html\b/i.test(html)) return html.replace(/<html\b/i, (tag) => tag + mark);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}<html${mark}>${html.slice(doctype[0].length)}` : `<html${mark}>${html}`;
}

/** Screen-only look of Paged.js's pages in the frame (the PDF is unaffected): grey desk, white sheets with a shadow. */
export const PREVIEW_PAGE_CSS = `
@media screen {
  html { background: #e6e6e6; }
  body { margin: 0; }
  .pagedjs_pages { display: flex; flex-direction: column; align-items: center; padding: 16px 0; }
  .pagedjs_page { background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); margin: 0 auto 16px; }
}
`;

export const previewFrameCss = `
.pmd-preview { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.pmd-preview[hidden] { display: none; }
.pmd-preview-bar { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent);
  font: 12px var(--vscode-font-family); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
.pmd-preview-bar button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: 2px 8px; cursor: pointer; }
.pmd-preview-bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.pmd-preview-status { flex: 1; }
.pmd-preview-frame { flex: 1; width: 100%; border: 0; background: #e6e6e6; }
`;

export class PreviewFrame {
  readonly element: HTMLElement;
  readonly frame: HTMLIFrameElement;
  readonly #status: HTMLElement;
  readonly #options: PreviewFrameOptions;
  #state: PreviewState = { busy: false, pages: null, provider: null, diagrams: null, message: null };
  #token = 0;
  /** FIX-PGF: the stage running now (null when idle), and since when; the status shows it. */
  #stage: { stage: PreviewStage; since: number; attempt: number } | null = null;
  #ticker: ReturnType<typeof setInterval> | undefined;
  /** How long each stage may take (tests shorten them). */
  readonly limits: PreviewLimits;

  constructor(parent: HTMLElement, options: PreviewFrameOptions) {
    this.#options = options;
    this.limits = {
      send: PREVIEW_LIMITS.send,
      request: options.requestTimeoutMs ?? PREVIEW_LIMITS.request,
      load: options.loadTimeoutMs ?? PREVIEW_LIMITS.load,
      layout: options.timeoutMs ?? PREVIEW_LIMITS.layout,
    };
    this.element = document.createElement('div');
    this.element.className = 'pmd-preview';
    this.element.hidden = true;
    const bar = document.createElement('div');
    bar.className = 'pmd-preview-bar';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Refresh';
    refresh.title = 'Render the preview again';
    refresh.addEventListener('click', () => void this.refresh());
    this.#status = document.createElement('span');
    this.#status.className = 'pmd-preview-status';
    this.#status.setAttribute('role', 'status');
    bar.append(refresh, this.#status);
    this.frame = document.createElement('iframe');
    this.frame.className = 'pmd-preview-frame';
    this.frame.title = 'Print Preview';
    this.frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    this.element.append(bar, this.frame);
    parent.append(this.element);
  }

  get state(): PreviewState {
    return this.#state;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** FIX-PGF: the stage running now, or null when nothing is being made. */
  get stage(): PreviewStage | null {
    return this.#stage?.stage ?? null;
  }

  show(): Promise<void> {
    this.element.hidden = false;
    return this.refresh();
  }

  /**
   * Leaves Print Preview. A render still on its way is dropped, and (FIX-PGF) nothing of it is left behind: the state is no longer
   * "busy", and a page still loading or laying out is taken out of the frame, so its scripts stop; showing the preview again starts
   * a clean attempt.
   */
  hide(): void {
    this.element.hidden = true;
    this.#token++;
    if (!this.#state.busy) return;
    this.#leaveStage('dropped', 'Print Preview was left');
    // An empty page in its place (the half-made page's Paged.js stops). Still a `srcdoc` page, so it keeps the editor page's origin:
    // without `srcdoc` a sandboxed frame is a page of another origin, which the app may not read.
    this.frame.srcdoc = BLANK_PAGE;
    this.#set({ busy: false, pages: null, diagrams: null, message: null });
  }

  /**
   * Renders again (shown only). Resolves when the page is in the frame and Paged.js is done, or when a stage stopped: no answer
   * from the host, a page that doesn't finish loading, a layout that fails or doesn't finish. Each of those is said in the status
   * (FIX-preview: "Rendering…" never stays for good).
   */
  async refresh(): Promise<void> {
    if (this.element.hidden) return;
    if (this.#state.busy) this.#leaveStage('dropped', 'a newer attempt started');
    const token = ++this.#token;
    const current = (): boolean => token === this.#token;
    this.#set({ busy: true, pages: null, diagrams: null, message: null });
    const stop = (message: string, change: Partial<PreviewState> = {}): void => {
      if (!current()) return;
      this.#leaveStage('stopped', message);
      this.#set({ busy: false, ...change, message: `Preview stopped: ${message}` });
    };
    const notes: string[] = [];
    // 1. The typing reaches VS Code (limited: the preview then shows the text VS Code has, and says so).
    if (this.#options.send) {
      this.#enter(token, 'send');
      const sent = await within(this.#options.send().catch(() => undefined), this.limits.send);
      if (!current()) return;
      if (sent === TIMED_OUT) {
        notes.push(LATE_TYPING);
        this.#leaveStage('stopped', `no answer within ${seconds(this.limits.send)}; going on with the text VS Code has`);
      } else this.#leaveStage('done');
    }
    // 2. pagemd makes the page (the host).
    this.#enter(token, 'render');
    let result: PreviewResult;
    try {
      const answer = await within(this.#options.request(), this.limits.request);
      if (answer === TIMED_OUT) return stop(`no answer from the renderer within ${seconds(this.limits.request)}. ${TRY_AGAIN}`, { provider: null, pages: null });
      result = answer;
    } catch (error) {
      if (current()) {
        this.#leaveStage('stopped', error instanceof Error ? error.message : String(error));
        this.#set({ busy: false, message: `Preview failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    if (!current()) return;
    this.#leaveStage('done', `${result.html.length} characters`);
    // 3. The page loads in the frame (its pictures and scripts). Only this attempt's own page counts (`markAttempt`).
    this.#enter(token, 'load');
    this.frame.style.colorScheme = result.colorScheme === 'dark' ? 'dark' : result.colorScheme === 'auto' ? '' : 'light';
    const loaded = new Promise<void>((resolve) => {
      const onLoad = (): void => {
        if (!current() || this.frame.contentDocument?.documentElement?.getAttribute('data-pmd-attempt') === String(token)) {
          this.frame.removeEventListener('load', onLoad);
          resolve();
        }
      };
      this.frame.addEventListener('load', onLoad);
    });
    this.frame.srcdoc = markAttempt(result.html, token);
    const provider = result.provider ?? null;
    if ((await within(loaded, this.limits.load)) === TIMED_OUT) {
      return stop(`the page did not finish loading within ${seconds(this.limits.load)} (a picture or a script it asks for never arrived). ${TRY_AGAIN}`, { provider });
    }
    if (!current()) return;
    this.#leaveStage('done');
    const doc = this.frame.contentDocument;
    if (doc) this.#dress(doc);
    // 4. Paged.js lays out the pages (pagemd's page only).
    let layout: { pages: number | null } | { failed: string } = { pages: null };
    if (provider === 'pagemd') {
      this.#enter(token, 'layout');
      layout = await this.#pagesWhenDone(token);
      if (!current()) return;
    }
    const win = this.frame.contentWindow as (Window & { __pmdDiagrams?: number }) | null;
    if ('failed' in layout) return stop(layout.failed, { provider, diagrams: win?.__pmdDiagrams ?? null });
    if (this.#stage) this.#leaveStage('done', `${layout.pages ?? 0} pages`);
    const message = [result.message, ...notes].filter(Boolean).join(' ');
    this.#set({ busy: false, provider, pages: layout.pages, diagrams: win?.__pmdDiagrams ?? null, message: message || null });
  }

  /** FIX-PGF: stage `stage` of attempt `token` starts (said in the status, with its seconds once it takes a while, and logged). */
  #enter(token: number, stage: PreviewStage): void {
    this.#stage = { stage, since: Date.now(), attempt: token };
    this.#options.onStage?.({ attempt: token, stage, event: 'start', ms: 0 });
    this.#ticker ??= setInterval(() => this.#paint(), 1000);
    this.#paint();
  }

  /** FIX-PGF: the stage running now ends (done, stopped or dropped). */
  #leaveStage(event: 'done' | 'stopped' | 'dropped', detail?: string): void {
    const running = this.#stage;
    if (!running) return;
    this.#stage = null;
    this.#options.onStage?.({ attempt: running.attempt, stage: running.stage, event, ms: Date.now() - running.since, ...(detail ? { detail } : {}) });
  }

  /** The screen look of the pages, and links handed to the app instead of navigating the frame. */
  #dress(doc: Document): void {
    const style = doc.createElement('style');
    style.textContent = PREVIEW_PAGE_CSS;
    doc.head?.append(style);
    doc.addEventListener('click', (event) => {
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (!link) return;
      const href = link.getAttribute('href') ?? '';
      event.preventDefault();
      if (href.startsWith('#')) {
        // A jump inside the preview, done here: left to the browser it resolves against pagemd's `<base href>` (the document's
        // folder) and navigates the frame away from the page, which crashed the preview on a contents or appendix link.
        let id = href.slice(1);
        try { id = decodeURIComponent(id); } catch { /* keep the raw id */ }
        (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView();
        return;
      }
      this.#options.onLink?.(href);
    });
  }

  /**
   * Waits for pagemd's completion flag (`__pagedjs_complete`, set after Paged.js and the TOC/index fill-in). Stops when an error
   * in the page (noted by output-pagemd's `previewWatch`) isn't followed by the flag, or when the layout takes too long.
   */
  async #pagesWhenDone(token: number): Promise<{ pages: number | null } | { failed: string }> {
    const limit = Date.now() + this.limits.layout;
    let errorSince: number | undefined;
    for (;;) {
      if (token !== this.#token) return { pages: null };
      const win = this.frame.contentWindow as (Window & { __pagedjs_complete?: boolean; __pmdPreviewError?: string }) | null;
      if (win?.__pagedjs_complete) return { pages: this.frame.contentDocument?.querySelectorAll('.pagedjs_page').length ?? 0 };
      if (win?.__pmdPreviewError) {
        errorSince ??= Date.now();
        if (Date.now() - errorSince >= ERROR_GRACE_MS) return { failed: `the page layout failed: ${win.__pmdPreviewError}` };
      }
      if (Date.now() > limit) return { failed: `the page layout did not finish within ${seconds(this.limits.layout)}. ${TRY_AGAIN}` };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  #set(change: Partial<PreviewState>): void {
    this.#state = { ...this.#state, ...change };
    if (!this.#state.busy) {
      this.#stage = null;
      clearInterval(this.#ticker);
      this.#ticker = undefined;
    }
    this.#paint();
    this.#options.onState?.(this.#state);
  }

  /** The status line: the stage while busy (FIX-PGF), else the pages and the message. */
  #paint(): void {
    const s = this.#state;
    this.#status.textContent = s.busy
      ? busyText(this.#stage?.stage ?? null, this.#stage ? Date.now() - this.#stage.since : 0)
      : [s.provider === 'html' ? 'Plain HTML' : s.pages !== null ? `${s.pages} page${s.pages === 1 ? '' : 's'}` : '', s.message ?? ''].filter(Boolean).join(' · ');
  }
}

/** FIX-PGF: "Rendering… laying out the pages", with the seconds once the stage takes a while ("… (12 s)"). */
export function busyText(stage: PreviewStage | null, ms: number): string {
  if (!stage) return 'Rendering…';
  return `Rendering… ${STAGE_LABELS[stage]}${ms >= SHOW_SECONDS_AFTER_MS ? ` (${Math.floor(ms / 1000)} s)` : ''}`;
}

const TIMED_OUT = Symbol('timed out');

/** `promise`, or TIMED_OUT once `ms` have passed without it settling. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
