// A selector's specificity (P25, "where did this come from"), as CSS Selectors level 4 counts it: (ids, classes + attributes +
// pseudo-classes, types + pseudo-elements). `:where()` counts nothing; `:is()`, `:not()`, `:has()` and `:matches()` count as their
// most specific argument; `:nth-child(… of S)` counts one pseudo-class plus S. A list counts as its most specific selector (callers
// pass the one selector that matched). No DOM: plain text, so it is tested on its own.

export type Specificity = readonly [number, number, number];

const ZERO: Specificity = [0, 0, 0];
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
const BY_ARGUMENT = new Set(['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any']);
const NTH = new Set(['nth-child', 'nth-last-child']);

/** a > b: positive; equal: 0. */
export function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const add = (a: Specificity, b: Specificity): Specificity => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const max = (list: Specificity[]): Specificity => list.reduce((best, s) => (compareSpecificity(s, best) > 0 ? s : best), ZERO);

/** The parts of a selector list, split at commas outside brackets, parentheses and strings. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '\\') i++;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** The index just after the bracket that closes the one at `open`. */
function closing(text: string, open: number): number {
  const pair = text[open] === '(' ? ')' : ']';
  const first = text[open];
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '\\') i++;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === first) depth++;
    else if (ch === pair && --depth === 0) return i + 1;
  }
  return text.length;
}

/** An identifier starting at `i` (escapes included). */
function ident(text: string, i: number): number {
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') i += 2;
    else if (/[\w-]/.test(ch) || ch.charCodeAt(0) > 127) i++;
    else break;
  }
  return i;
}

/** The specificity of one complex selector (no commas at the top level; for a list, the most specific part). */
export function specificity(selector: string): Specificity {
  const parts = splitList(selector);
  if (parts.length > 1) return max(parts.map(specificity));
  const text = parts[0] ?? '';
  let a = 0;
  let b = 0;
  let c = 0;
  let extra: Specificity = ZERO;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '#') {
      a++;
      i = ident(text, i + 1);
    } else if (ch === '.') {
      b++;
      i = ident(text, i + 1);
    } else if (ch === '[') {
      b++;
      i = closing(text, i);
    } else if (ch === ':') {
      const element = text[i + 1] === ':';
      const start = i + (element ? 2 : 1);
      const end = ident(text, start);
      const name = text.slice(start, end).toLowerCase();
      let argument: string | null = null;
      i = end;
      if (text[i] === '(') {
        const close = closing(text, i);
        argument = text.slice(i + 1, close - 1);
        i = close;
      }
      if (element || LEGACY_PSEUDO_ELEMENTS.has(name)) c++;
      else if (name === 'where') {
        // nothing
      } else if (BY_ARGUMENT.has(name) && argument !== null) extra = add(extra, max(splitList(argument).map(specificity)));
      else if (NTH.has(name) && argument !== null) {
        b++;
        const of = /\bof\b([\s\S]*)$/i.exec(argument);
        if (of) extra = add(extra, max(splitList(of[1]!).map(specificity)));
      } else b++;
    } else if (ch === '*') {
      i++;
    } else if (/[a-zA-Z_\\-]/.test(ch) || ch.charCodeAt(0) > 127) {
      // a type selector (or a namespace prefix before `|`)
      const end = ident(text, i);
      if (text[end] === '|') i = end + 1;
      else {
        c++;
        i = end;
      }
    } else i++; // combinators, spaces (strings only appear inside [] and (), skipped whole above)
  }
  return add([a, b, c], extra);
}
