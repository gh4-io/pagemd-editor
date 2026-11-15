// "Where did this come from" (P25, R-242; AD-P25-07): for one element on the canvas and each main property, the style rule CSS
// applies, the rules it beat, and where an inherited value comes from. The rules are the report's rule index (the files' own rules,
// scoped as the canvas scopes them); which of them match is the browser's own answer (`Element.matches`, `matchMedia`,
// `CSS.supports`), given through `CascadeHost` so the ordering is tested without a DOM. The order is CSS's (Cascade level 5):
// importance (`!important` reverses the layers), then the layer (base … frontmatter, then the template's own CSS, outside any layer;
// a rule in a layer of the file's own loses to the file's unnested rules), then specificity, then the order of appearance. A style
// written on the element itself beats every normal rule.
import { CSS_LAYERS, type CssDeclarationSource, type CssRuleSource } from '@pagemd-editor/core';
import { compareSpecificity, specificity, type Specificity } from './specificity.ts';

export interface PropertyInfo {
  property: string;
  label: string;
  group: 'Font' | 'Paragraph' | 'Box';
  inherited: boolean;
}

/** The properties shown, as Word's Reveal Formatting groups them (Font, Paragraph); AD-P25-08. */
export const PROPERTIES: readonly PropertyInfo[] = [
  { property: 'font-family', label: 'Font family', group: 'Font', inherited: true },
  { property: 'font-size', label: 'Size', group: 'Font', inherited: true },
  { property: 'font-weight', label: 'Weight', group: 'Font', inherited: true },
  { property: 'font-style', label: 'Style', group: 'Font', inherited: true },
  { property: 'color', label: 'Color', group: 'Font', inherited: true },
  { property: 'text-align', label: 'Alignment', group: 'Paragraph', inherited: true },
  { property: 'line-height', label: 'Line spacing', group: 'Paragraph', inherited: true },
  { property: 'text-indent', label: 'First-line indent', group: 'Paragraph', inherited: true },
  { property: 'margin-top', label: 'Space before', group: 'Paragraph', inherited: false },
  { property: 'margin-bottom', label: 'Space after', group: 'Paragraph', inherited: false },
  { property: 'margin-left', label: 'Indent left', group: 'Paragraph', inherited: false },
  { property: 'margin-right', label: 'Indent right', group: 'Paragraph', inherited: false },
  { property: 'background-color', label: 'Background', group: 'Box', inherited: false },
];

/** What the cascade needs from the page (the DOM in the webview; a stand-in in tests). */
export interface CascadeHost<E> {
  /** Whether `selector` (a canvas selector) matches `element`; false for a selector the browser can't read. */
  matches(element: E, selector: string): boolean;
  /** The element's parent, null above the canvas (inheritance stops there). */
  parent(element: E): E | null;
  /** The declarations written on the element itself (its `style` attribute), lower-case names. */
  inline(element: E): Record<string, string>;
  /** Whether an `@media` (kind 'media') or `@supports` condition holds now. */
  condition(kind: 'media' | 'supports', text: string): boolean;
  /** "<h2>", "<section class="x">": how an ancestor is named. */
  describe(element: E): string;
}

export interface Candidate {
  rule: CssRuleSource;
  declaration: CssDeclarationSource;
  /** The value this rule gives the property (a shorthand's part, or its whole value when it can't be split). */
  value: string;
  /** The shorthand it was written as (`margin`, `font`), when not the property itself. */
  via?: string;
  /** The matching selector (as on the canvas) and its specificity. */
  selector: string;
  specificity: Specificity;
  /** Its place in the rule's declarations. */
  index: number;
}

export interface PropertyTrace extends PropertyInfo {
  /**
   * 'rule': `winner` decides; 'inline': written on the element itself (`inline`); 'inherited': from an ancestor (`ancestor`, and
   * `winner` is the ancestor's rule, or `inline`); 'none': no rule in these files sets it.
   */
  source: 'rule' | 'inline' | 'inherited' | 'none';
  winner: Candidate | null;
  /** The rules that lost, best first (for the element itself; an inherited value lists the ancestor's). */
  beaten: Candidate[];
  inline?: string;
  ancestor?: string;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** Top-level parts of a value (spaces outside parentheses and strings). */
function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (/\s/.test(ch) && depth === 0) {
      if (i > start) out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (start < value.length) out.push(value.slice(start));
  return out;
}

/** The four sides of a 1–4 value box shorthand; null when it can't be split (a `var()` may stand for several values). */
function box(value: string): Record<(typeof SIDES)[number], string> | null {
  if (/var\(/i.test(value)) return null;
  const v = words(value.replace(/\s*!important\s*$/i, ''));
  if (v.length < 1 || v.length > 4) return null;
  const [t, r = t, b = t, l = r] = v as [string, string?, string?, string?];
  return { top: t, right: r!, bottom: b!, left: l! };
}

/**
 * The longhands a declaration sets among the ones that matter here, with the value it gives each (horizontal, left to right writing:
 * the logical `margin-block`/`-inline` map to top/bottom and left/right). A shorthand that can't be split gives its whole value.
 */
export function longhands(property: string, value: string): { property: string; value: string; via?: string }[] {
  const p = property.toLowerCase();
  const sided = /^(margin|padding)$/.exec(p);
  if (sided) {
    const sides = box(value);
    return SIDES.map((side) => ({ property: `${sided[1]}-${side}`, value: sides ? sides[side] : value, via: p }));
  }
  const logical: Record<string, string[]> = {
    'margin-block': ['margin-top', 'margin-bottom'],
    'margin-inline': ['margin-left', 'margin-right'],
    'padding-block': ['padding-top', 'padding-bottom'],
    'padding-inline': ['padding-left', 'padding-right'],
  };
  if (logical[p]) {
    const v = /var\(/i.test(value) ? null : words(value);
    return logical[p]!.map((longhand, i) => ({ property: longhand, value: v && v.length <= 2 ? (v[i] ?? v[0]!) : value, via: p }));
  }
  const single: Record<string, string> = {
    'margin-block-start': 'margin-top',
    'margin-block-end': 'margin-bottom',
    'margin-inline-start': 'margin-left',
    'margin-inline-end': 'margin-right',
  };
  if (single[p]) return [{ property: single[p]!, value, via: p }];
  if (p === 'font') return ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height'].map((longhand) => ({ property: longhand, value, via: p }));
  if (p === 'background') return [{ property: 'background-color', value, via: p }];
  return [{ property: p, value }];
}

const layerIndex = (rule: CssRuleSource): number => CSS_LAYERS.indexOf(rule.layer);

/** > 0 when `a` wins over `b` (see the file header). */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const ia = a.declaration.important ? 1 : 0;
  const ib = b.declaration.important ? 1 : 0;
  if (ia !== ib) return ia - ib;
  const important = ia === 1;
  const la = layerIndex(a.rule);
  const lb = layerIndex(b.rule);
  if (la !== lb) return important ? lb - la : la - lb;
  const na = a.rule.nestedLayer ? 1 : 0;
  const nb = b.rule.nestedLayer ? 1 : 0;
  if (na !== nb) return important ? na - nb : nb - na;
  return compareSpecificity(a.specificity, b.specificity) || a.rule.order - b.rule.order || a.index - b.index;
}

const CANVAS_ONLY = /^\.pmd-canvas(?=$|[\s:.>+~[])/;

/** Every declaration of the matching rules, grouped by the longhand it sets (unsorted). */
function candidatesOf<E>(element: E, rules: readonly CssRuleSource[], host: CascadeHost<E>): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>();
  for (const rule of rules) {
    if (rule.media && !rule.media.every((m) => host.condition('media', m))) continue;
    if (rule.supports && !rule.supports.every((s) => host.condition('supports', s))) continue;
    let best: { selector: string; specificity: Specificity } | null = null;
    for (const selector of rule.selectors) {
      if (!CANVAS_ONLY.test(selector) || /::/.test(selector) || !host.matches(element, selector)) continue;
      const s = specificity(selector);
      if (!best || compareSpecificity(s, best.specificity) > 0) best = { selector, specificity: s };
    }
    if (!best) continue;
    rule.declarations.forEach((declaration, index) => {
      for (const part of longhands(declaration.property, declaration.value)) {
        const list = out.get(part.property) ?? [];
        list.push({ rule, declaration, value: part.value, ...(part.via ? { via: part.via } : {}), selector: best!.selector, specificity: best!.specificity, index });
        out.set(part.property, list);
      }
    });
  }
  return out;
}

/** The inline style's value for a longhand (a shorthand written inline counts for its parts). */
function inlineValue(inline: Record<string, string>, property: string): string | undefined {
  if (inline[property] !== undefined) return inline[property];
  for (const [name, value] of Object.entries(inline)) {
    const part = longhands(name, value).find((l) => l.property === property);
    if (part && name !== property) return part.value;
  }
  return undefined;
}

/** Where each of `properties` comes from on `element` (see the file header). */
export function attribute<E>(element: E, rules: readonly CssRuleSource[], host: CascadeHost<E>, properties: readonly PropertyInfo[] = PROPERTIES): PropertyTrace[] {
  const cache = new Map<E, Map<string, Candidate[]>>();
  const sorted = (el: E, property: string): Candidate[] => {
    let map = cache.get(el);
    if (!map) cache.set(el, (map = candidatesOf(el, rules, host)));
    return [...(map.get(property) ?? [])].sort((a, b) => compareCandidates(b, a));
  };
  /** The winner on one element: the inline style, else the best rule; `inherit` and `unset` on an inherited property pass to the parent. */
  const own = (el: E, info: PropertyInfo): { inline?: string; winner: Candidate | null; beaten: Candidate[]; passes: boolean } => {
    const list = sorted(el, info.property);
    const inline = inlineValue(host.inline(el), info.property);
    const top = list[0] ?? null;
    if (inline !== undefined && !(top && top.declaration.important)) return { inline, winner: null, beaten: list, passes: false };
    if (!top) return { winner: null, beaten: [], passes: info.inherited };
    const keyword = top.value.trim().toLowerCase();
    const passes = keyword === 'inherit' || (info.inherited && (keyword === 'unset' || keyword === 'revert' || keyword === 'revert-layer'));
    return { winner: top, beaten: list.slice(1), passes };
  };
  return properties.map((info) => {
    const here = own(element, info);
    if (here.inline !== undefined) return { ...info, source: 'inline', winner: null, beaten: here.beaten, inline: here.inline };
    if (here.winner && !here.passes) return { ...info, source: 'rule', winner: here.winner, beaten: here.beaten };
    if (here.passes) {
      for (let el = host.parent(element); el !== null; el = host.parent(el)) {
        const up = own(el, info);
        if (up.inline !== undefined) return { ...info, source: 'inherited', winner: null, beaten: up.beaten, inline: up.inline, ancestor: host.describe(el) };
        if (up.winner && !up.passes) return { ...info, source: 'inherited', winner: up.winner, beaten: up.beaten, ancestor: host.describe(el) };
        if (!up.passes) break;
      }
    }
    return { ...info, source: 'none', winner: null, beaten: here.beaten };
  });
}

/** The real page as a CascadeHost: the browser's own selector engine and conditions; inheritance stops at the canvas (`.pmd-canvas`). */
export function domCascadeHost(win: Window): CascadeHost<Element> {
  const supports = (text: string): boolean => {
    try {
      return (win as Window & { CSS?: { supports(condition: string): boolean } }).CSS?.supports(text) ?? true;
    } catch {
      return true;
    }
  };
  return {
    matches: (element, selector) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    },
    parent: (element) => (element.classList.contains('pmd-canvas') ? null : element.parentElement),
    inline: (element) => {
      const style = (element as HTMLElement).style;
      const out: Record<string, string> = {};
      if (!style) return out;
      for (let i = 0; i < style.length; i++) {
        const name = style.item(i);
        out[name] = style.getPropertyValue(name);
      }
      return out;
    },
    condition: (kind, text) => (kind === 'media' ? win.matchMedia(text).matches : supports(text)),
    describe: (element) => {
      const tag = element.tagName.toLowerCase();
      const cls = [...element.classList].filter((c) => !c.startsWith('pmd-') && c !== 'ProseMirror').slice(0, 2);
      return element.classList.contains('pmd-canvas') ? 'the page (body)' : `<${tag}${cls.length ? ` class="${cls.join(' ')}"` : ''}>`;
    },
  };
}
