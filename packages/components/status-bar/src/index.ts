// @pagemd-editor/status-bar: "Page x of y · view · profile · zoom · Using default layout" (layered-architecture.md
// §3). Basic in P2: it shows what the view state and styles know; page numbers arrive with pagination (P6).
import type { PageArrangement, PageFit, ResolvedStyles, ViewMode, ViewState, ViewStateValue } from '@pagemd-editor/core';

export const VIEW_LABELS: Readonly<Record<ViewMode, string>> = {
  print: 'Print Layout',
  web: 'Web Layout',
  draft: 'Draft',
  read: 'Read',
  code: 'Code',
  split: 'Split',
  preview: 'Print Preview',
};

export const FIT_LABELS: Readonly<Record<Exclude<PageFit, 'none'>, string>> = { 'page-width': 'Page width', 'one-page': 'One page', 'multi-page': 'Multiple pages' };
export const ARRANGEMENT_LABELS: Readonly<Record<PageArrangement, string>> = { vertical: 'Vertical pages', 'side-by-side': 'Side by side' };
/** The zoom steps the zoom control offers (1 = 100 %). */
export const ZOOM_CHOICES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** The zoom part's text: the fit's name while fitting, else the percentage. */
export const zoomText = (view: Readonly<ViewStateValue>): string => {
  const fit = view.mode === 'read' && view.fit === 'none' ? 'one-page' : view.fit; // Read always fits the page(s) to the window
  return fit === 'none' ? `${Math.round(view.zoom * 100)} %` : FIT_LABELS[fit];
};

/** What the zoom and arrangement controls do (Print Layout and Read, P6, amendment 11). */
export interface StatusControls {
  /** Both absent (Read, which always fits the page to the window): the zoom part is plain text. */
  onFit?(fit: Exclude<PageFit, 'none'>): void;
  onZoom?(zoom: number): void;
  onArrangement(arrangement: PageArrangement): void;
}

/** The modes that show the page layout, where "Using default layout" matters (ADR-0014). */
const LAYOUT_MODES: ReadonlySet<ViewMode> = new Set(['print', 'web', 'read']);

export interface StatusBarInfo {
  styles?: ResolvedStyles;
  /** From pagination, once there is one. */
  page?: { current: number; total: number };
  profile?: string;
  /**
   * Anything else the author should know about the styles (a profile not found, a missing stylesheet, a YAML
   * error, …): plain messages, already formatted by the app (P5, amendment 9). "Using default layout" is shown
   * from `styles.usingDefault` instead (ADR-0014), so it is never repeated here.
   */
  notes?: readonly string[];
  /** Called when the author clicks the view name (R-132): the app decides what to do (e.g. switch views). */
  onSelectView?: () => void;
  /** When present the zoom (and page arrangement) parts are controls (P6); the pure `statusParts` also lists the arrangement. */
  controls?: StatusControls;
}

/** `styles.layout`, as "Layout: letter (pagemd)" (R-128): the file name without its extension, plus a marker
 *  for pagemd's own bundled file (never written to, ADR-0014). */
function layoutText(layout: { path: string; bundled: boolean }): string {
  const base = layout.path.split(/[\\/]/).pop()?.replace(/\.css$/i, '') || layout.path;
  return `Layout: ${base}${layout.bundled ? ' (pagemd)' : ''}`;
}

/** The status bar's parts, in order. Pure, so it can be tested without a DOM. */
export function statusParts(view: Readonly<ViewStateValue>, info: StatusBarInfo = {}): string[] {
  const parts: string[] = [];
  if (info.page) parts.push(`Page ${info.page.current} of ${info.page.total}`);
  parts.push(VIEW_LABELS[view.mode]);
  if (info.profile) parts.push(info.profile);
  parts.push(zoomText(view));
  if (info.controls) parts.push(ARRANGEMENT_LABELS[view.pageArrangement]);
  if (LAYOUT_MODES.has(view.mode)) {
    if (info.styles?.usingDefault) parts.push('Using default layout');
    if (info.styles?.layout) parts.push(layoutText(info.styles.layout));
  }
  for (const note of info.notes ?? []) parts.push(note);
  return parts;
}

export class StatusBar {
  readonly element: HTMLElement;
  readonly #view: ViewState;
  readonly #subscription: { dispose(): void };
  #info: StatusBarInfo;

  constructor(parent: HTMLElement, view: ViewState, info: StatusBarInfo = {}) {
    this.#view = view;
    this.#info = info;
    this.element = parent.ownerDocument.createElement('div');
    this.element.className = 'pmd-status-bar';
    this.element.setAttribute('role', 'status');
    parent.append(this.element);
    this.#subscription = view.onChange(() => this.render());
    this.render();
  }

  update(info: StatusBarInfo): void {
    this.#info = { ...this.#info, ...info };
    this.render();
  }

  render(): void {
    const doc = this.element.ownerDocument;
    const viewLabel = VIEW_LABELS[this.#view.value.mode];
    const onSelectView = this.#info.onSelectView;
    const controls = this.#info.controls;
    const zoom = zoomText(this.#view.value);
    const arrangement = ARRANGEMENT_LABELS[this.#view.value.pageArrangement];
    this.element.replaceChildren(
      ...statusParts(this.#view.value, this.#info).map((text) => {
        if (controls?.onFit && controls.onZoom && text === zoom) return this.#zoomControl(controls);
        if (controls && text === arrangement) return this.#arrangementControl(controls);
        const span = doc.createElement('span');
        span.textContent = text;
        // The view name (R-132): clickable when the app gave us something to do about it.
        if (text === viewLabel && onSelectView) {
          span.className = 'pmd-status-view';
          span.setAttribute('role', 'button');
          span.tabIndex = 0;
          span.addEventListener('click', onSelectView);
          span.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelectView();
            }
          });
        }
        return span;
      }),
    );
  }

  /** A drop-down of the fits and the zoom steps; it shows the current one. */
  #zoomControl(controls: StatusControls): HTMLElement {
    const view = this.#view.value;
    const select = this.#select('pmd-status-zoom', 'Zoom');
    const add = (value: string, label: string) => select.append(new Option(label, value));
    for (const [fit, label] of Object.entries(FIT_LABELS)) add(`fit:${fit}`, label);
    const steps = new Set(ZOOM_CHOICES);
    if (view.fit === 'none') steps.add(Math.round(view.zoom * 100) / 100);
    for (const step of [...steps].sort((a, b) => a - b)) add(`zoom:${step}`, `${Math.round(step * 100)} %`);
    select.value = view.fit === 'none' ? `zoom:${Math.round(view.zoom * 100) / 100}` : `fit:${view.fit}`;
    select.addEventListener('change', () => {
      const [kind, value] = select.value.split(':') as [string, string];
      if (kind === 'fit') controls.onFit?.(value as Exclude<PageFit, 'none'>);
      else controls.onZoom?.(Number(value));
    });
    return select;
  }

  #arrangementControl(controls: StatusControls): HTMLElement {
    const select = this.#select('pmd-status-arrangement', 'Page arrangement');
    for (const [value, label] of Object.entries(ARRANGEMENT_LABELS)) select.append(new Option(label, value));
    select.value = this.#view.value.pageArrangement;
    select.addEventListener('change', () => controls.onArrangement(select.value as PageArrangement));
    return select;
  }

  #select(cls: string, label: string): HTMLSelectElement {
    const select = this.element.ownerDocument.createElement('select');
    select.className = cls;
    select.setAttribute('aria-label', label);
    return select;
  }

  destroy(): void {
    this.#subscription.dispose();
    this.element.remove();
  }
}

/** Editor UI, so it uses the VS Code theme variables. */
export const statusBarCss = `
.pmd-status-bar { display: flex; gap: 1.5em; padding: 2px 12px; font-size: 12px;
  color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border, transparent);
  background: var(--vscode-editor-background); }
.pmd-status-view { cursor: pointer; }
.pmd-status-bar select { font: inherit; color: inherit; background: transparent; border: 0; padding: 0; cursor: pointer; }
.pmd-status-bar select option { color: var(--vscode-foreground); background: var(--vscode-dropdown-background, #3c3c3c); }
.pmd-status-view:hover, .pmd-status-view:focus-visible { color: var(--vscode-foreground); text-decoration: underline; }
.pmd-status-bar:focus-visible, .pmd-status-bar [tabindex]:focus-visible, .pmd-status-bar select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
`;
