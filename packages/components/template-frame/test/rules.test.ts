// P18: what a template may bring onto the canvas (the DOM parts are checked in the browser, test/e2e/print-fidelity.spec.ts).
import { describe, expect, it } from 'vitest';
import { carriedAttributes, DROPPED_ELEMENTS, keepsAttribute } from '../src/index.ts';

describe('keepsAttribute', () => {
  it('drops event handlers, srcdoc and script addresses (however they are written), keeps the rest', () => {
    expect(keepsAttribute('onerror', 'x()')).toBe(false);
    expect(keepsAttribute('ONCLICK', 'x()')).toBe(false);
    expect(keepsAttribute('srcdoc', '<p>')).toBe(false);
    expect(keepsAttribute('href', 'javascript:alert(1)')).toBe(false);
    expect(keepsAttribute('href', ' \tJaVaScRiPt:alert(1)')).toBe(false);
    expect(keepsAttribute('src', 'java\nscript:x')).toBe(false);
    expect(keepsAttribute('xlink:href', 'vbscript:x')).toBe(false);
    expect(keepsAttribute('href', 'https://example.com/javascript:x')).toBe(true);
    expect(keepsAttribute('src', '.pagemd/assets/img/logo.png')).toBe(true);
    expect(keepsAttribute('class', 'javascript:')).toBe(true); // not an address
    expect(keepsAttribute('alt', 'Uncertified Organic Farmers Org')).toBe(true);
  });
});

describe('carriedAttributes (what the text area takes from the element it stands in for)', () => {
  it("keeps the element's classes, id, style and data; leaves the editor's own attributes alone", () => {
    expect(
      carriedAttributes([
        ['class', 'invitation-body'],
        ['id', 'body'],
        ['style', 'color: red'],
        ['data-x', '1'],
        ['contenteditable', 'true'],
        ['role', 'main'],
        ['aria-label', 'Body'],
        ['tabindex', '0'],
        ['spellcheck', 'false'],
        ['onclick', 'x()'],
      ]),
    ).toEqual({ class: 'invitation-body', id: 'body', style: 'color: red', 'data-x': '1' });
  });
});

describe('DROPPED_ELEMENTS', () => {
  it('names scripts, frames, plug-ins and document-level tags', () => {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'style']) expect(DROPPED_ELEMENTS.has(tag)).toBe(true);
    for (const tag of ['div', 'img', 'h1', 'main', 'span']) expect(DROPPED_ELEMENTS.has(tag)).toBe(false);
  });
});
