// Running headers and footers (P6, amendment 7, R-147), as text per box for one page. Pure: no DOM. The styles
// hold the texts with pagemd's tokens (`:::PAGE`, `:::PAGES`, `:::STRING(name)`); this fills them in for a page,
// applies the first-page rules and flips inside/outside by page side (page 1 is a right page, like a book's).
//
// P21: a page type (`<!-- ::LAYOUT(wide) -->`, `@page wide` in the layout) may write its own boxes. Per box, lowest
// to highest, as pagemd's PDF (Paged.js) decides: the document's properties, the plain page's own text, `@page :first`
// on the document's page 1 (all three are today's result), then `@page wide`, then `@page wide:first` on the first
// page of each run of that type. A box the page type doesn't write is inherited (box by box); `null` clears it. In
// Word's terms a page type is a section and an inherited box is "Link to Previous".
import type { NamedRunning, ResolvedStyles, RunningContent, RunningOverride } from '@pagemd-editor/core';

/** The three boxes of a header or footer, left to right; empty strings draw nothing. */
export interface RunningBoxes {
  left: string;
  center: string;
  right: string;
  /** The text spans the whole width (pagemd's `span`): `center` holds it, left and right are empty. */
  span: boolean;
}

export interface RunningPage {
  /** 1-based. */
  number: number;
  /** All pages, blank ones included (the PDF numbers them too). */
  total: number;
  blank: boolean;
  /** `:::STRING(name)` values on this page (PageInfo.strings). */
  strings: Readonly<Record<string, string>>;
  /** P21: the page type (PageInfo.name: '' = the document's own page, `default` for LAYOUT(default)). */
  name?: string;
  /** P21: the first page of a run of this page type (the page before it, blank ones skipped, is another type or none). */
  firstOfType?: boolean;
}

export interface RunningFor {
  header: RunningBoxes | null;
  footer: RunningBoxes | null;
}

/** What `page` shows in its top and bottom margins, or nulls (a blank page shows neither). */
export function runningFor(styles: Pick<ResolvedStyles, 'header' | 'footer' | 'firstPage'> & Pick<Partial<ResolvedStyles>, 'namedRunning'>, page: RunningPage): RunningFor {
  if (page.blank) return { header: null, footer: null };
  const first = page.number === 1;
  const rules = first ? styles.firstPage : undefined;
  const pick = (part: 'header' | 'footer'): RunningContent | undefined => {
    if (rules === false) return undefined;
    const own = rules?.[part];
    if (own === false) return undefined;
    return own ?? styles[part];
  };
  const named = namedFor(styles.namedRunning, page.name);
  const side = (part: 'header' | 'footer'): RunningBoxes | null => {
    let shown = boxes(pick(part), page);
    shown = override(shown, named?.[part], page);
    if (page.firstOfType) shown = override(shown, named?.first?.[part], page);
    return shown;
  };
  return { header: side('header'), footer: side('footer') };
}

/** The page type's own boxes: matched in lower case, like the layout's page names; none for the document's own page. */
export function namedFor(named: Readonly<Record<string, NamedRunning>> | undefined, name: string | undefined): NamedRunning | undefined {
  if (!named || !name) return undefined;
  return named[name] ?? named[name.toLowerCase()];
}

/** `boxes` with a page type's own boxes on top (absent = inherited; null = cleared). */
function override(shown: RunningBoxes | null, own: RunningOverride | undefined, page: RunningPage): RunningBoxes | null {
  if (!own) return shown;
  const out: RunningBoxes = shown ? { ...shown } : { left: '', center: '', right: '', span: false };
  for (const pos of ['left', 'center', 'right'] as const) {
    if (!(pos in own)) continue;
    const value = own[pos];
    out[pos] = typeof value === 'string' ? fill(value, page) : '';
  }
  // A spanning text stops spanning once the page type writes its own left or right box (as fillFrom does for layouts)
  if (out.span && ('left' in own || 'right' in own)) out.span = false;
  return out.left || out.center || out.right ? out : null;
}

function boxes(content: RunningContent | undefined, page: RunningPage): RunningBoxes | null {
  if (!content) return null;
  // Left pages are the even ones; page 1 is a right page. Inside is the binding edge, outside the page's edge.
  const rightPage = page.number % 2 === 1;
  const text = (value: string | undefined) => (value === undefined ? '' : fill(value, page));
  const fallback = (side: 'left' | 'right', binding: 'inside' | 'outside') => text(content[binding] !== undefined ? content[binding] : content[side]);
  if (content.spansWidth) return { left: '', center: text(content.center), right: '', span: true };
  const result: RunningBoxes = {
    left: rightPage ? fallback('left', 'inside') : fallback('left', 'outside'),
    center: text(content.center),
    right: rightPage ? fallback('right', 'outside') : fallback('right', 'inside'),
    span: false,
  };
  return result.left || result.center || result.right ? result : null;
}

/** `:::PAGE`, `:::PAGES` and `:::STRING(name)` replaced by this page's values (a string never set is blank). */
export function fill(text: string, page: RunningPage): string {
  return text
    .replace(/:::PAGES\b/g, String(page.total))
    .replace(/:::PAGE\b/g, String(page.number))
    .replace(/:::STRING\(\s*([^)\s]+)\s*\)/g, (_all, name: string) => page.strings[name] ?? '');
}
