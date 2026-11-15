// P25 (R-242, AD-P25-07): "where did this come from" picks the rule CSS applies. Each case sets up rules that compete in one way (a
// later layer, a more specific selector, a later rule, !important, a style on the element, a nested @layer, inheritance) and checks
// the winner. Control: the naive answer "the last rule that matches wins" is computed for every case and must differ from the real
// one where the case is about something else than order, so the fixtures really tell the two apart.
import { describe, expect, it } from 'vitest';
import type { CssLayer, CssRuleSource } from '@pagemd-editor/core';
import { attribute, compareSpecificity, longhands, PROPERTIES, specificity, type CascadeHost } from '../src/index.ts';

interface FakeElement {
  name: string;
  matches: string[];
  parent: FakeElement | null;
  style?: Record<string, string>;
}

const host: CascadeHost<FakeElement> = {
  matches: (el, selector) => el.matches.includes(selector),
  parent: (el) => el.parent,
  inline: (el) => el.style ?? {},
  condition: (kind, text) => (kind === 'media' ? text !== '(max-width: 1px)' : true),
  describe: (el) => `<${el.name}>`,
};

let order = 0;
function rule(file: string, layer: CssLayer, selector: string, declarations: Record<string, string>, extra: Partial<CssRuleSource> = {}): CssRuleSource {
  return {
    file,
    line: ++order,
    column: 1,
    selector,
    selectors: [`.pmd-canvas ${selector}`],
    layer,
    order: order,
    declarations: Object.entries(declarations).map(([property, value]) => ({ property, value: value.replace(/\s*!important$/, ''), important: value.endsWith('!important') })),
    ...extra,
  };
}

const canvas: FakeElement = { name: 'canvas', matches: ['.pmd-canvas body', '.pmd-canvas'], parent: null };
const section: FakeElement = { name: 'section', matches: ['.pmd-canvas section'], parent: canvas };
const h1 = (extra: string[] = [], style?: Record<string, string>): FakeElement => ({ name: 'h1', matches: ['.pmd-canvas h1', '.pmd-canvas h1.title', '.pmd-canvas #main h1', ...extra], parent: section, ...(style ? { style } : {}) });

const trace = (el: FakeElement, rules: CssRuleSource[], property: string) => attribute(el, rules, host, PROPERTIES.filter((p) => p.property === property))[0]!;
/** The naive answer: the last rule in the list (file order) that matches. */
const naive = (el: FakeElement, rules: CssRuleSource[], property: string) => [...rules].reverse().find((r) => r.selectors.some((s) => el.matches.includes(s)) && r.declarations.some((d) => longhands(d.property, d.value).some((l) => l.property === property)));

describe('the winner is the one CSS picks', () => {
  it('a later layer beats an earlier one, whatever the specificity (control: the naive answer is the earlier, later-listed rule)', () => {
    const rules = [rule('profile.css', 'profile', 'h1', { color: 'red' }), rule('base.css', 'base', '#main h1', { color: 'blue' })];
    const t = trace(h1(), rules, 'color');
    expect(t.source).toBe('rule');
    expect(t.winner!.rule.file).toBe('profile.css');
    expect(t.beaten.map((c) => c.rule.file)).toEqual(['base.css']);
    expect(naive(h1(), rules, 'color')!.file).toBe('base.css');
  });

  it('in the same layer the more specific selector wins over a later rule', () => {
    const rules = [rule('a.css', 'profile', 'h1.title', { 'font-size': '30px' }), rule('b.css', 'profile', 'h1', { 'font-size': '20px' })];
    const t = trace(h1(), rules, 'font-size');
    expect(t.winner!.rule.file).toBe('a.css');
    expect(t.winner!.specificity).toEqual([0, 2, 1]); // .pmd-canvas + .title, h1
    expect(naive(h1(), rules, 'font-size')!.file).toBe('b.css');
  });

  it('equally specific: the later one wins (file order, then place in the file)', () => {
    const rules = [rule('a.css', 'profile', 'h1', { 'text-align': 'left' }), rule('b.css', 'profile', 'h1', { 'text-align': 'center' })];
    expect(trace(h1(), rules, 'text-align').winner!.rule.file).toBe('b.css');
  });

  it('!important turns the layer order around', () => {
    const rules = [rule('base.css', 'base', 'h1', { color: 'blue !important' }), rule('primary.css', 'primary', 'h1', { color: 'green !important' }), rule('profile.css', 'profile', 'h1', { color: 'red' })];
    const t = trace(h1(), rules, 'color');
    expect(t.winner!.rule.file).toBe('base.css');
    expect(t.beaten.map((c) => c.rule.file)).toEqual(['primary.css', 'profile.css']);
    expect(naive(h1(), rules, 'color')!.file).toBe('profile.css');
  });

  it("the template's own CSS (no layer) beats every layer; a rule in a file's own @layer loses to its unnested rules", () => {
    const rules = [rule('tpl.html', 'template', 'h1', { color: 'black' }), rule('fm.css', 'frontmatter', '#main h1', { color: 'navy' })];
    expect(trace(h1(), rules, 'color').winner!.rule.file).toBe('tpl.html');
    const nested = [rule('p.css', 'profile', 'h1', { color: 'plain' }), rule('p.css', 'profile', 'h1', { color: 'nested' }, { nestedLayer: 'extra' })];
    expect(trace(h1(), nested, 'color').winner!.value).toBe('plain');
  });

  it('a style on the element itself beats normal rules but not !important ones', () => {
    const rules = [rule('a.css', 'profile', 'h1', { 'text-align': 'left' })];
    expect(trace(h1([], { 'text-align': 'right' }), rules, 'text-align')).toMatchObject({ source: 'inline', inline: 'right', winner: null });
    const important = [rule('a.css', 'profile', 'h1', { 'text-align': 'left !important' })];
    expect(trace(h1([], { 'text-align': 'right' }), important, 'text-align').source).toBe('rule');
  });

  it('a rule whose @media does not hold, or with a pseudo-element, does not count', () => {
    const rules = [rule('a.css', 'profile', 'h1', { color: 'red' }), rule('b.css', 'profile', 'h1', { color: 'blue' }, { media: ['(max-width: 1px)'] }), rule('c.css', 'profile', 'h1::before', { color: 'pink' })];
    expect(trace(h1(['.pmd-canvas h1::before']), rules, 'color').winner!.rule.file).toBe('a.css');
  });
});

describe('shorthands and inheritance', () => {
  it('margin: 0 0 1em counts for margin-bottom, with the part it gives', () => {
    const rules = [rule('a.css', 'profile', 'h1', { 'margin-bottom': '5px' }), rule('b.css', 'profile', 'h1', { margin: '0 0 1em' })];
    const t = trace(h1(), rules, 'margin-bottom');
    expect(t.winner).toMatchObject({ value: '1em', via: 'margin' });
    expect(longhands('margin', 'var(--x)').map((l) => l.value)).toEqual(['var(--x)', 'var(--x)', 'var(--x)', 'var(--x)']);
    expect(longhands('margin-block', '2px 4px')).toEqual([
      { property: 'margin-top', value: '2px', via: 'margin-block' },
      { property: 'margin-bottom', value: '4px', via: 'margin-block' },
    ]);
  });

  it('an inherited property no rule sets on the element comes from the nearest ancestor that has one', () => {
    const rules = [rule('base.css', 'base', 'body', { 'font-family': 'Georgia' }), rule('p.css', 'profile', 'section', { 'font-family': 'Arial' })];
    const t = trace(h1(), rules, 'font-family');
    expect(t).toMatchObject({ source: 'inherited', ancestor: '<section>' });
    expect(t.winner!.rule.file).toBe('p.css');
    // `inherit` passes it up too
    const passing = [...rules, rule('x.css', 'profile', 'h1', { 'font-family': 'inherit' })];
    expect(trace(h1(), passing, 'font-family')).toMatchObject({ source: 'inherited', ancestor: '<section>' });
  });

  it('a property that is not inherited, set on no rule: none', () => {
    const rules = [rule('p.css', 'profile', 'section', { 'margin-top': '9px' })];
    expect(trace(h1(), rules, 'margin-top')).toMatchObject({ source: 'none', winner: null });
  });
});

describe('specificity', () => {
  it.each([
    ['h1', [0, 0, 1]],
    ['.pmd-canvas h1', [0, 1, 1]],
    ['#a .b c', [1, 1, 1]],
    ['a[href^="x,y"]:hover::before', [0, 2, 2]],
    ['p:first-letter', [0, 0, 2]],
    [':where(#a, .b) p', [0, 0, 1]],
    [':is(#a, .b) p', [1, 0, 1]],
    [':not(.a, h1 h2) p', [0, 1, 1]],
    ['.pmd-canvas:where(.pmd-print) h2', [0, 1, 1]],
    ['li:nth-child(2n+1 of .x)', [0, 2, 1]],
    ['*', [0, 0, 0]],
    ['svg|rect', [0, 0, 1]],
    ['h1, #x', [1, 0, 0]],
  ])('%s', (selector, expected) => {
    expect(specificity(selector)).toEqual(expected);
  });

  it('compares ids before classes before types', () => {
    expect(compareSpecificity([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareSpecificity([0, 1, 0], [0, 0, 9])).toBeGreaterThan(0);
    expect(compareSpecificity([0, 1, 1], [0, 1, 1])).toBe(0);
  });
});
