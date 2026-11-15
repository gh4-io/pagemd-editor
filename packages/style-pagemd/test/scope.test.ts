// Scoping profile CSS to the canvas (P5, amendment 5, R-131).
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { lightMedia, printMedia, scopeCss, scopedSelectors, scopeSelector } from '../src/index.ts';

const squash = (css: string) => css.replace(/\s+/g, ' ').trim();

describe('scopeSelector', () => {
  it.each([
    [':root', '.pmd-canvas'],
    ['html', '.pmd-canvas'],
    ['BODY', '.pmd-canvas'],
    ['html body', '.pmd-canvas'],
    ['html > body p', '.pmd-canvas p'],
    ['body.dark::before', '.pmd-canvas.dark::before'],
    ['html.dark body .x', '.pmd-canvas.dark .x'],
    [':root[data-theme="a b"] h1', '.pmd-canvas[data-theme="a b"] h1'],
    ['html:not(.print) body > main', '.pmd-canvas:not(.print) > main'],
    ['h1', '.pmd-canvas h1'],
    ['*', '.pmd-canvas *'],
    ['.toc a', '.pmd-canvas .toc a'],
    ['bodyguard', '.pmd-canvas bodyguard'],
    [':root-ish', '.pmd-canvas :root-ish'],
    ['p + body', '.pmd-canvas p + body'],
  ])('%s → %s', (selector, scoped) => {
    expect(scopeSelector(selector)).toBe(scoped);
  });
});

describe('lightMedia (R-131: the canvas is light like the PDF)', () => {
  it.each([
    ['(prefers-color-scheme: dark)', null],
    ['screen and (prefers-color-scheme: dark)', null],
    ['(prefers-color-scheme: light)', ''],
    ['screen and (prefers-color-scheme:light)', ''],
    ['only screen and (prefers-color-scheme: light)', ''],
    ['(min-width: 40em) and (prefers-color-scheme: light)', '(min-width: 40em)'],
    ['print', 'print'],
    ['screen and (max-width: 600px)', 'screen and (max-width: 600px)'],
    ['(prefers-color-scheme: dark), print', 'print'],
    ['not all and (prefers-color-scheme: dark)', 'not all and (prefers-color-scheme: dark)'],
  ])('%s → %j', (params, expected) => {
    expect(lightMedia(params)).toBe(expected);
  });
});

describe('scopeCss', () => {
  it('turns :root/html/body into the canvas and puts every other rule inside it', () => {
    const { css } = scopeCss(':root { --a: 1 }\nhtml, body { margin: 0 }\nh1, .x > p { color: red }');
    expect(squash(css)).toBe('.pmd-canvas { --a: 1 } .pmd-canvas, .pmd-canvas { margin: 0 } .pmd-canvas h1, .pmd-canvas .x > p { color: red }');
  });

  it('drops every @page rule, also nested ones and their margin boxes', () => {
    const { css } = scopeCss('@page { size: letter; @top-left { content: "x" } }\n@page :first { margin: 0 }\n@layer layout { @page landscape { size: letter landscape } p { color: blue } }\n@media print { @page { margin: 1in } }');
    expect(css).not.toMatch(/@page|@top-left/);
    expect(squash(css)).toContain('@layer layout { .pmd-canvas p { color: blue } }');
  });

  it('scopes inside @layer, @media, @supports and @container, recursively; keeps layer order statements', () => {
    const { css } = scopeCss('@layer base, primary;\n@layer base { @media screen { @supports (display: grid) { body { display: grid } } } }\n@container side (min-width: 1px) { a { b: c } }');
    expect(squash(css)).toBe('@layer base, primary; @layer base { @supports (display: grid) { .pmd-canvas:not(:where(.pmd-print)) { display: grid } } } @container side (min-width: 1px) { .pmd-canvas a { b: c } }');
  });

  it('keeps @font-face, @keyframes and @property global and unchanged', () => {
    const input = '@font-face { font-family: X; src: url(data:font/woff2;base64,AA==) }\n@keyframes spin { from { opacity: 0 } 50% { opacity: 1 } }\n@property --x { syntax: "*"; inherits: false }';
    expect(scopeCss(input).css).toBe(input);
  });

  it('drops @import and @charset, reporting each @import', () => {
    const { css, droppedImports } = scopeCss('@charset "utf-8";\n@import url("fonts.css");\n@import "print.css" print;\np { a: b }');
    expect(droppedImports).toEqual(['url("fonts.css")', '"print.css" print']);
    expect(squash(css)).toBe('.pmd-canvas p { a: b }');
  });

  it('drops dark-mode rules, unwraps light-mode ones (R-131); print rules become .pmd-print rules (P6)', () => {
    const { css } = scopeCss('@media (prefers-color-scheme: dark) { body { color: white } }\n@media (prefers-color-scheme: light) { body { color: black } }\n@media print { h1 { break-after: avoid } }\n@media screen and (prefers-color-scheme: dark) { a { b: c } }');
    expect(squash(css)).toBe('.pmd-canvas { color: black } .pmd-canvas:where(.pmd-print) h1 { break-after: avoid }');
  });

  it('leaves nested (CSS nesting) selectors relative to their scoped parent', () => {
    const { css } = scopeCss('.card { color: red; & .title { font-weight: bold } }');
    expect(squash(css)).toBe('.pmd-canvas .card { color: red; & .title { font-weight: bold } }');
  });

  it('keeps the rest of the text as written (comments, spacing)', () => {
    const input = '/* heading */\nh1 {\n  color: red; /* why */\n}\n';
    expect(scopeCss(input).css).toBe('/* heading */\n.pmd-canvas h1 {\n  color: red; /* why */\n}\n');
  });

  it('scopedSelectors lists every scoped selector, not keyframe steps or nested ones', () => {
    const { css } = scopeCss('@keyframes k { from { a: b } }\nh1 { & span { c: d } }\n@media print { p { e: f } }');
    expect(scopedSelectors(css)).toEqual(['.pmd-canvas h1', '.pmd-canvas:where(.pmd-print) p']);
  });

  it('throws on CSS postcss cannot read (the caller turns it into a note)', () => {
    expect(() => scopeCss('p { color: red')).toThrow(postcss.CssSyntaxError);
  });
});

describe('printMedia (P6, amendment 5: print and screen rules as canvas classes)', () => {
  it.each([
    ['print', 'print', ''],
    ['only print', 'print', ''],
    ['screen', 'screen', ''],
    ['not print', 'screen', ''],
    ['not screen', 'print', ''],
    ['screen and (max-width: 600px)', 'screen', '(max-width: 600px)'],
    ['print, screen', 'any', ''],
    ['all', 'any', ''],
    ['(min-width: 40em)', 'any', '(min-width: 40em)'],
    ['speech', 'any', null],
    ['screen and (min-width: 1px), print', 'any', 'screen and (min-width: 1px), print'],
    ['not print and (color)', 'any', 'not print and (color)'],
  ])('%s → %s %j', (params, medium, rest) => {
    expect(printMedia(params)).toEqual({ medium, params: rest });
  });
});

describe('scopeCss print and screen rules (P6, amendment 5)', () => {
  it('turns @media print/screen into zero-specificity .pmd-print conditions, recursively', () => {
    const { css } = scopeCss('@media print { body { a: b } h1 { break-before: page } }\n@media screen { p { c: d } }\n@media screen and (max-width: 600px) { p { e: f } }\n@layer x { @media print { li { g: h } } }\n@media print { @media screen { q { i: j } } }\n@media speech { s { k: l } }');
    expect(squash(css)).toBe(
      '.pmd-canvas:where(.pmd-print) { a: b } .pmd-canvas:where(.pmd-print) h1 { break-before: page } ' +
        '.pmd-canvas:not(:where(.pmd-print)) p { c: d } @media (max-width: 600px) { .pmd-canvas:not(:where(.pmd-print)) p { e: f } } ' +
        '@layer x { .pmd-canvas:where(.pmd-print) li { g: h } }',
    );
  });

  it('keeps the cascade: a print rule ties with the plain rule it overrides (same specificity, source order)', () => {
    const { css } = scopeCss('h1 { color: red }\n@media print { h1 { color: black } }');
    const selectors = scopedSelectors(css);
    // :where() counts for nothing, so both are one class + one type.
    expect(selectors).toEqual(['.pmd-canvas h1', '.pmd-canvas:where(.pmd-print) h1']);
  });
});
