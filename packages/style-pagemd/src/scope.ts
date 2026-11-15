// Scoping a profile's CSS to the canvas (P5, amendment 5; R-131). pagemd's CSS is written for a whole page (its
// HTML's `html`/`body`, Paged.js's `@page`); on the canvas it must only style the document, never the editor
// around it. With postcss (8.5.28, pinned):
// - `:root`, `html` and `body` at the start of a selector become the canvas (`.pmd-canvas`); every other selector
//   is put inside it (`.pmd-canvas h1`);
// - `@page` rules are dropped (the page geometry travels as numbers, ResolvedStyles.page);
// - `@layer`, `@media`, `@supports` and `@container` are scoped inside, recursively (layer order statements stay);
// - `@font-face` (and the other rules without selectors: `@keyframes`, `@counter-style`, `@property`) stays
//   global;
// - `@import` is dropped and reported (the webview can't fetch it; pagemd's own files have none);
// - dark-mode rules (`prefers-color-scheme: dark`) are dropped and light-mode conditions count as always true:
//   the canvas is light like the PDF (R-131);
// - print and screen rules (P6, amendment 5) become class conditions on the canvas, so one stylesheet serves every
//   view: `@media print { h1 {…} }` → `.pmd-canvas:where(.pmd-print) h1 {…}` (Print Layout and Read put `.pmd-print`
//   on the canvas), `@media screen { … }` → `.pmd-canvas:not(:where(.pmd-print)) …` (Web Layout, Draft). `:where()`
//   adds no specificity, so the cascade between these and plain rules is what it was. A query list mixing print and
//   screen with other conditions (`screen and (x), print`) is left as an ordinary `@media` (screen only, as before).
import postcss, { type AtRule, type ChildNode, type Container, type Root, type Rule } from 'postcss';

/** The canvas's class (components/canvas). */
export const CANVAS_SCOPE = '.pmd-canvas';

/** The class Print Layout and Read put on the canvas: print rules apply, screen rules don't (P6, amendment 5). */
export const PRINT_CLASS = 'pmd-print';

/** Which media the rules being scoped apply to. */
type Medium = 'any' | 'print' | 'screen';

export interface ScopeResult {
  css: string;
  /** The `@import` rules dropped, as written (`url("x.css")`, `"y.css" screen`). */
  droppedImports: string[];
}

/** At-rules whose contents are rules to scope. */
const NESTING = new Set(['layer', 'media', 'supports', 'container', 'scope', 'document', '-moz-document']);

/** Scopes `css` to `scope` (see the file header). Throws a postcss CssSyntaxError on CSS it can't read. */
export function scopeCss(css: string, scope: string = CANVAS_SCOPE): ScopeResult {
  const root = postcss.parse(css);
  const droppedImports = scopeRoot(root, scope);
  return { css: root.toString(), droppedImports };
}

/**
 * Scopes an already parsed sheet in place (see the file header) and answers the `@import` rules dropped. The rule nodes that stay
 * keep their identity and source positions (P25's rule index reads them after scoping, so its selectors are the canvas's own).
 */
export function scopeRoot(root: Root, scope: string = CANVAS_SCOPE): string[] {
  const droppedImports: string[] = [];
  scopeContainer(root, scope, droppedImports, 'any');
  return droppedImports;
}

function scopeContainer(container: Root | AtRule, scope: string, dropped: string[], medium: Medium): void {
  // A copy: rules are removed while walking.
  for (const node of [...(container.nodes ?? [])] as ChildNode[]) {
    if (node.type === 'rule') {
      scopeRule(node, scopeFor(scope, medium));
    } else if (node.type === 'atrule') {
      const name = node.name.toLowerCase();
      if (name === 'page') node.remove();
      else if (name === 'import') {
        dropped.push(node.params);
        node.remove();
      } else if (name === 'charset') node.remove();
      else if (name === 'media') {
        const light = lightMedia(node.params);
        const split = light === null || light === '' ? { medium: 'any' as const, params: light } : printMedia(light);
        const inner = combine(medium, split.medium);
        if (split.params === null || inner === null) node.remove();
        else if (split.params === '') unwrap(node, scope, dropped, inner);
        else {
          node.params = split.params;
          scopeContainer(node, scope, dropped, inner);
        }
      } else if (NESTING.has(name) && node.nodes) scopeContainer(node, scope, dropped, medium);
      // @font-face, @keyframes, @counter-style, @property, @namespace, layer statements: global, unchanged.
    }
  }
}

/** Replaces an at-rule that always applies by its contents (scoped). */
function unwrap(node: AtRule, scope: string, dropped: string[], medium: Medium): void {
  scopeContainer(node, scope, dropped, medium);
  const children = [...(node.nodes ?? [])];
  if (children.length > 0) node.replaceWith(...children);
  else node.remove();
}

/** Selectors of nested rules (CSS nesting) are relative to their parent rule: only top-level rules are scoped. */
function scopeRule(rule: Rule, scope: string): void {
  rule.selectors = rule.selectors.map((selector) => scopeSelector(tableHeadSelector(selector), scope));
}

/**
 * The class the canvas puts on a table's header rows (preset-pagemd's table_row; a test checks both say the same). The
 * canvas holds every row of a table in one `<tbody>` (an editor's table has one container for its rows), so pagemd's
 * `thead` rules would miss the header rows: they were centred on the canvas and on the left in the PDF (OQ-49).
 */
export const HEAD_ROW_CLASS = 'pmd-head-row';

/** The type selector at the start of a compound (`thead`, `tr`, `*`), lower case; '' when it has none. */
const typeOf = (compound: string): string => (/^([a-zA-Z][\w-]*|\*)/.exec(compound)?.[1] ?? '').toLowerCase();

/**
 * A selector with pagemd's table row groups as the canvas has them (OQ-49): `thead X` reaches the header rows
 * (`tbody > tr.pmd-head-row X`; `thead > tr` → `tbody > tr.pmd-head-row`), and `tbody > tr` leaves them out
 * (`tbody > tr:not(.pmd-head-row)`), so the profile's own CSS decides the header row's look on the canvas as in the PDF.
 * Selectors without `thead` or `tbody` are unchanged.
 */
export function tableHeadSelector(selector: string): string {
  if (!/\b(thead|tbody)\b/i.test(selector)) return selector;
  // Split into compounds and the combinators between them.
  const parts: { compound: string; after: string }[] = [];
  let rest = selector.trim();
  while (rest.length > 0) {
    const end = compoundEnd(rest);
    const compound = rest.slice(0, end);
    rest = rest.slice(end);
    const combinator = /^\s*[>+~]\s*|^\s+/.exec(rest)?.[0] ?? '';
    rest = rest.slice(combinator.length);
    parts.push({ compound, after: combinator });
  }
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const { compound, after } = parts[i]!;
    const type = typeOf(compound);
    const next = parts[i + 1];
    const nextIsRow = !!next && typeOf(next.compound) === 'tr' && /^\s*>?\s*$/.test(after);
    if (type === 'thead') {
      out.push(`tbody${compound.slice(5)}`);
      if (nextIsRow) {
        out.push(after, `tr.${HEAD_ROW_CLASS}${next.compound.slice(2)}`, next.after);
        i++;
      } else out.push(` > tr.${HEAD_ROW_CLASS}`, next ? after : '');
    } else if (type === 'tbody' && nextIsRow) {
      out.push(compound, after, `tr:not(.${HEAD_ROW_CLASS})${next.compound.slice(2)}`, next.after);
      i++;
    } else out.push(compound, after);
  }
  return out.join('').trim();
}

/** The scope for rules that apply to `medium` only (zero added specificity). */
function scopeFor(scope: string, medium: Medium): string {
  if (medium === 'print') return `${scope}:where(.${PRINT_CLASS})`;
  if (medium === 'screen') return `${scope}:not(:where(.${PRINT_CLASS}))`;
  return scope;
}

/** Rules for `inner` nested in rules for `outer`: null when they can never both apply (print inside screen). */
function combine(outer: Medium, inner: Medium): Medium | null {
  if (outer === 'any') return inner;
  if (inner === 'any' || inner === outer) return outer;
  return null;
}

// ── selectors ──

/** `:root`, `html` or `body` as the type part of a compound selector, followed by the rest of the compound. */
const ROOTISH = /^(?::root|html|body)(?![\w-])/i;

/**
 * One complex selector inside the canvas. Leading `:root`/`html`/`body` compounds (joined by a descendant or child
 * combinator: `html body`, `html > body`) become the canvas itself, keeping their classes and pseudo-parts
 * (`body.dark::before` → `.pmd-canvas.dark::before`); anything else is put inside the canvas.
 */
export function scopeSelector(selector: string, scope: string = CANVAS_SCOPE): string {
  let rest = selector.trim();
  let suffix = '';
  let matched = false;
  for (;;) {
    const m = ROOTISH.exec(rest);
    if (!m) break;
    matched = true;
    rest = rest.slice(m[0].length);
    const end = compoundEnd(rest);
    suffix += rest.slice(0, end);
    rest = rest.slice(end);
    const combinator = /^\s*>\s*|^\s+/.exec(rest);
    if (combinator && ROOTISH.test(rest.slice(combinator[0].length))) {
      rest = rest.slice(combinator[0].length);
      continue;
    }
    break;
  }
  if (!matched) return `${scope} ${rest}`;
  return `${scope}${suffix}${rest}`;
}

/** Where the compound selector at the start of `text` ends: at a combinator or whitespace outside () [] and quotes. */
function compoundEnd(text: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\') i++;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && (/\s/.test(ch) || ch === '>' || ch === '+' || ch === '~')) return i;
  }
  return text.length;
}

// ── media queries (R-131: the canvas is light) ──

const DARK = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;
const LIGHT = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/i;

/**
 * A media query list as it applies to the light canvas: null when it can never match (every query asks for dark
 * mode), '' when it always matches (only light-mode conditions), else the list with light conditions removed.
 * Queries starting with `not` are kept as written.
 */
export function lightMedia(params: string): string | null {
  const queries = splitTopLevel(params, ',').map((q) => q.trim()).filter(Boolean);
  const kept: string[] = [];
  let always = false;
  for (const query of queries) {
    if (/^not\b/i.test(query)) {
      kept.push(query);
      continue;
    }
    if (DARK.test(query)) continue;
    if (!LIGHT.test(query)) {
      kept.push(query);
      continue;
    }
    const rest = splitAnd(query).filter((part) => !LIGHT.test(part));
    if (rest.length === 0 || (rest.length === 1 && /^(only\s+)?(all|screen)$/i.test(rest[0]!))) always = true;
    else kept.push(rest.join(' and '));
  }
  if (always) return '';
  if (kept.length === 0) return null;
  return kept.join(', ');
}

/**
 * A (light-handled) media query list split into the medium it targets and what's left to test (P6, amendment 5):
 * `print` → print, ''; `screen and (max-width: 600px)` → screen, '(max-width: 600px)'; `not print` → screen, '';
 * `print, screen` → any, ''; `speech` → params null (never applies on the canvas). Anything mixing media with
 * other conditions across several queries is returned unchanged with medium 'any' (an ordinary `@media`).
 */
export function printMedia(params: string): { medium: Medium; params: string | null } {
  const queries = splitTopLevel(params, ',').map((q) => q.trim()).filter(Boolean);
  const parsed = queries.map(parseQuery);
  if (parsed.some((q) => q === undefined)) return { medium: 'any', params };
  const live = (parsed as Query[]).filter((q) => q.medium !== null);
  if (live.length === 0) return { medium: 'any', params: null };
  const media = new Set(live.map((q) => q.medium));
  const plain = live.every((q) => q.rest.length === 0);
  if (media.size === 1) {
    const medium = [...media][0] as Medium;
    if (plain) return { medium, params: '' };
    if (live.every((q) => q.rest.length > 0)) return { medium, params: live.map((q) => q.rest.join(' and ')).join(', ') };
    return { medium, params: '' }; // one query has no conditions: it always matches for this medium
  }
  if (plain || live.some((q) => q.medium === 'any' && q.rest.length === 0)) return { medium: 'any', params: '' };
  return { medium: 'any', params };
}

interface Query {
  /** null: a medium the canvas never is (speech, tty…). */
  medium: Medium | null;
  rest: string[];
}

/** One query's medium and other conditions; undefined for a form not handled here (kept as written). */
function parseQuery(query: string): Query | undefined {
  const parts = splitAnd(query);
  const head = parts[0] ?? '';
  const m = /^(not\s+|only\s+)?([a-z-]+)$/i.exec(head);
  if (!m) return { medium: 'any', rest: parts }; // starts with a condition: all media
  const negated = /^not/i.test(m[1] ?? '');
  const type = m[2]!.toLowerCase();
  const rest = parts.slice(1);
  if (negated) {
    if (rest.length > 0) return undefined; // `not print and (x)`: kept as written
    if (type === 'print') return { medium: 'screen', rest: [] };
    if (type === 'screen') return { medium: 'print', rest: [] };
    if (type === 'all') return { medium: null, rest: [] };
    return { medium: 'any', rest: [] };
  }
  if (type === 'print' || type === 'screen') return { medium: type, rest };
  if (type === 'all') return { medium: 'any', rest };
  return { medium: null, rest };
}

function splitAnd(query: string): string[] {
  return splitTopLevel(query, ' and ', true).map((p) => p.trim()).filter(Boolean);
}

/** Splits at `separator` outside parentheses. */
function splitTopLevel(text: string, separator: string, ignoreCase = false): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const hay = ignoreCase ? text.toLowerCase() : text;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && hay.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i = start - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Every selector of every scoped rule, for checks (R-133 check 1): rules inside @keyframes don't count. */
export function scopedSelectors(css: string): string[] {
  const out: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    const parent = rule.parent as Container | undefined;
    if (parent?.type === 'atrule' && /keyframes$/i.test((parent as AtRule).name)) return;
    if (parent?.type === 'rule') return; // nested: relative to its (scoped) parent
    out.push(...rule.selectors);
  });
  return out;
}
