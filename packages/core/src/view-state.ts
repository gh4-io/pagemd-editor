// View state: which view mode, arrangement, zoom and panels (layered-architecture.md §5).
import type { Disposable } from './services.ts';

export type ViewMode = 'print' | 'web' | 'draft' | 'read' | 'code' | 'split' | 'preview';

export interface Panels {
  outline: boolean;
  inspector: boolean;
  /** The Comments panel on the right (P12, R-181). */
  comments: boolean;
  /** The Files in Use panel on the right (P25, R-242). */
  files: boolean;
  ruler: boolean;
  statusBar: boolean;
}

export interface ViewStateValue {
  mode: ViewMode;
  /** Split view only: code | canvas side by side, or stacked. */
  arrangement: 'side-by-side' | 'stacked';
  /** 1 = 100 %. Used when `fit` is 'none'. */
  zoom: number;
  panels: Panels;
  /** Print Layout / Read (P6, R-142): pages stacked top to bottom, or laid out in rows (spreads). */
  pageArrangement: PageArrangement;
  /** Print Layout / Read (P6, R-142): fit the page(s) to the window, or 'none' to use `zoom`. */
  fit: PageFit;
}

export type PageArrangement = 'vertical' | 'side-by-side';
export type PageFit = 'none' | 'one-page' | 'multi-page' | 'page-width';

export type ViewStateChange = Partial<Omit<ViewStateValue, 'panels'>> & { panels?: Partial<Panels> };

/** Print Layout is the default view (ADR-0006). */
export const DEFAULT_VIEW_STATE: Readonly<ViewStateValue> = Object.freeze({
  mode: 'print',
  arrangement: 'side-by-side',
  zoom: 1,
  panels: Object.freeze({ outline: true, inspector: true, comments: true, files: true, ruler: true, statusBar: true }),
  pageArrangement: 'vertical',
  fit: 'none',
});

export class ViewState {
  #value: Readonly<ViewStateValue>;
  readonly #listeners = new Set<(value: Readonly<ViewStateValue>) => void>();

  constructor(initial: ViewStateChange = {}) {
    this.#value = merge(DEFAULT_VIEW_STATE, initial);
  }

  get value(): Readonly<ViewStateValue> {
    return this.#value;
  }

  set(change: ViewStateChange): void {
    if (change.zoom !== undefined && !(change.zoom > 0)) throw new RangeError(`Zoom must be above 0, got ${change.zoom}.`);
    this.#value = merge(this.#value, change);
    for (const listener of this.#listeners) listener(this.#value);
  }

  onChange(cb: (value: Readonly<ViewStateValue>) => void): Disposable {
    this.#listeners.add(cb);
    return { dispose: () => this.#listeners.delete(cb) };
  }
}

function merge(base: Readonly<ViewStateValue>, change: ViewStateChange): Readonly<ViewStateValue> {
  return Object.freeze({
    ...base,
    ...change,
    panels: Object.freeze({ ...base.panels, ...change.panels }),
  });
}
