// @pagemd-editor/split-view: Split view's frame (P9, R-164). Two panes, the Code view first (left, or on top when
// stacked) and the canvas second, with a divider the author can drag. The same frame shows one pane alone in the other
// views (Code: the Code view; Print, Web, Draft, Read: the canvas), so switching views never rebuilds either side.
// It knows nothing about what is inside the panes; the app keeps the two cursors together (plugin-source-map).
import type { ViewStateValue } from '@pagemd-editor/core';

/** Which panes show: the canvas alone, the Code view alone, or both. */
export type SplitShow = 'canvas' | 'code' | 'both';
export type SplitArrangement = ViewStateValue['arrangement'];

export interface SplitViewOptions {
  arrangement?: SplitArrangement;
  /** The panes changed size (shown, hidden, divider dragged): the app lays its views out again. */
  onResize?(): void;
}

/** The first pane's share of the room, kept between 15 % and 85 %. */
export function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(0.85, Math.max(0.15, ratio)) : 0.5;
}

export class SplitView {
  readonly element: HTMLElement;
  /** The Code view's pane. */
  readonly codePane: HTMLElement;
  /** The canvas's pane. */
  readonly canvasPane: HTMLElement;
  readonly #divider: HTMLElement;
  readonly #o: SplitViewOptions;
  #show: SplitShow = 'canvas';
  #arrangement: SplitArrangement;
  #ratio = 0.5;

  constructor(parent: HTMLElement, options: SplitViewOptions = {}) {
    this.#o = options;
    this.#arrangement = options.arrangement ?? 'side-by-side';
    const d = parent.ownerDocument;
    this.element = d.createElement('div');
    this.element.className = 'pmd-split';
    this.codePane = d.createElement('div');
    this.codePane.className = 'pmd-split-pane pmd-split-code';
    this.canvasPane = d.createElement('div');
    this.canvasPane.className = 'pmd-split-pane pmd-split-canvas';
    this.#divider = d.createElement('div');
    this.#divider.className = 'pmd-split-divider';
    this.#divider.setAttribute('role', 'separator');
    this.#divider.tabIndex = 0;
    this.#divider.setAttribute('aria-label', 'Resize the panes');
    this.#divider.addEventListener('pointerdown', (event) => this.#drag(event));
    this.#divider.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 0.05 : 0;
      if (!step) return;
      event.preventDefault();
      this.setRatio(this.#ratio + step);
    });
    this.element.append(this.codePane, this.#divider, this.canvasPane);
    parent.append(this.element);
    this.#apply();
  }

  get show(): SplitShow {
    return this.#show;
  }

  get arrangement(): SplitArrangement {
    return this.#arrangement;
  }

  get ratio(): number {
    return this.#ratio;
  }

  setShow(show: SplitShow): void {
    if (show === this.#show) return;
    this.#show = show;
    this.#apply();
  }

  setArrangement(arrangement: SplitArrangement): void {
    if (arrangement === this.#arrangement) return;
    this.#arrangement = arrangement;
    this.#apply();
  }

  setRatio(ratio: number): void {
    this.#ratio = clampRatio(ratio);
    this.#apply();
  }

  #apply(): void {
    const both = this.#show === 'both';
    this.element.dataset['show'] = this.#show;
    this.element.dataset['arrangement'] = this.#arrangement;
    this.codePane.hidden = this.#show === 'canvas';
    this.canvasPane.hidden = this.#show === 'code';
    this.#divider.hidden = !both;
    // A focusable separator says where it is (P13b): the share of the frame the Code pane has, in percent.
    this.#divider.setAttribute('aria-valuemin', '15');
    this.#divider.setAttribute('aria-valuemax', '85');
    this.#divider.setAttribute('aria-valuenow', String(Math.round(this.#ratio * 100)));
    this.#divider.setAttribute('aria-orientation', this.#arrangement === 'stacked' ? 'horizontal' : 'vertical');
    this.codePane.style.flex = both ? `0 0 ${(this.#ratio * 100).toFixed(2)}%` : '';
    this.#o.onResize?.();
  }

  #drag(event: PointerEvent): void {
    event.preventDefault();
    const rect = this.element.getBoundingClientRect();
    const move = (e: PointerEvent): void => {
      const ratio = this.#arrangement === 'stacked' ? (e.clientY - rect.top) / Math.max(1, rect.height) : (e.clientX - rect.left) / Math.max(1, rect.width);
      this.setRatio(ratio);
    };
    const up = (): void => {
      this.#divider.removeEventListener('pointermove', move);
      this.#divider.removeEventListener('pointerup', up);
    };
    this.#divider.setPointerCapture?.(event.pointerId);
    this.#divider.addEventListener('pointermove', move);
    this.#divider.addEventListener('pointerup', up);
  }
}

/** Editor UI: VS Code's theme variables. */
export const splitViewCss = `
.pmd-split { flex: 1; display: flex; min-height: 0; min-width: 0; }
.pmd-split[data-arrangement="stacked"] { flex-direction: column; }
.pmd-split-pane { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.pmd-split-pane[hidden], .pmd-split-divider[hidden] { display: none; }
.pmd-split-divider { flex: none; width: 4px; cursor: col-resize; background: var(--vscode-panel-border, transparent); }
.pmd-split[data-arrangement="stacked"] > .pmd-split-divider { width: auto; height: 4px; cursor: row-resize; }
.pmd-split-divider:hover, .pmd-split-divider:focus-visible { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); outline: none; }
`;
