// style-pagemd's resolve → read → build → scope with an in-memory file system holding pagemd's own files (P5).
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { createMemoryFileSystem } from '@pagemd/resolver';
import { FALLBACK_PAGE } from '@pagemd/theme-kit';
import { PLAIN_PAGE } from '@pagemd-editor/style-default';
import { GATE_FIELDS, gateDefaultsOf, resolveStyles, scopedSelectors, type StyleEnvironment } from '../src/index.ts';
import { memoryEnv, pagemdFiles, THEME_KIT_DEFAULTS, filesUnder } from './fixtures.ts';

const LETTER = { width: 215.9, height: 279.4, margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } };
const PROJECT = { '/proj/package.json': '{}' };

function hasPageRule(css: string): boolean {
  let found = false;
  postcss.parse(css).walkAtRules(/^page$/i, () => void (found = true));
  return found;
}

async function resolve(text: string, files: Record<string, string> = {}, extra: Partial<StyleEnvironment> = {}, path = '/proj/doc.md') {
  const env = memoryEnv({ ...PROJECT, [path]: text, ...files }, extra);
  return { env, result: await resolveStyles({ path, text }, env) };
}

describe('resolveStyles: the default profile (standard_letter, pagemd\'s letter.css)', () => {
  it('finds pagemd\'s profile, layout and CSS, scoped to the canvas, with the Letter page', async () => {
    const { result } = await resolve('# Hello\n');
    const styles = result.styles!;
    expect(result.notes).toEqual([]);
    expect(styles.profile).toBe('standard_letter');
    expect(styles.usingDefault).toBe(false);
    expect(styles.layout).toEqual({ path: '/pagemd/layouts/letter.css', bundled: true });
    expect(styles.page).toEqual(LETTER);
    expect(styles.namedPages?.['landscape']).toMatchObject({ width: 279.4, height: 215.9 });
    expect(hasPageRule(styles.css)).toBe(false);
    expect(scopedSelectors(styles.css).filter((s) => !s.startsWith('.pmd-canvas'))).toEqual([]);
    expect(styles.sources).toEqual(
      expect.arrayContaining(['/pagemd/profiles/standard_letter.json', '/pagemd/layouts/letter.css', '/pagemd/styles/base.css', '/pagemd/styles/primary.css', '/pagemd/styles/syntax/shiki-base.css']),
    );
    expect(styles.header).toBeUndefined();
    expect(result.basis).toMatchObject({ documentPath: '/proj/doc.md', documentDir: '/proj', profileId: 'standard_letter', profilePath: '/pagemd/profiles/standard_letter.json', usingDefault: false });
    expect(result.basis!.layoutText).toContain('@top-left');
  });

  it('works with a synchronous file system too, and fills the shared profile cache', async () => {
    const memory = createMemoryFileSystem({ ...pagemdFiles(), ...PROJECT, '/proj/doc.md': '' });
    const cache = new Map();
    const result = await resolveStyles({ path: '/proj/doc.md', text: '' }, { fs: memory, pagemdPath: '/pagemd', cache });
    expect(result.styles?.profile).toBe('standard_letter');
    expect(cache.size).toBeGreaterThan(0);
  });

  // FIX-FT item 1 (AD-FIX-FT-01): the editor's own copy of pagemd's files (theme-kit's defaults/, R-128) prints the
  // document header's title, id, status and revision only when they have a value, as pagemd's template now does.
  it.each([
    ['only a title', '---\ntitle: Memo\n---\n# Memo\n', ['Memo'], ['document-status', 'document-revision', 'document-id', 'Rev ', 'Draft']],
    ['every field', '---\ntitle: Memo\ndocument_id: M-1\nstatus: Approved\nrevision: 3\n---\n', ['Memo', 'M-1', 'Approved', 'Rev 3'], []],
    ['nothing', '# Hello\n', [], ['document-title', 'document-status', 'document-revision', 'Draft']],
  ])('the default header with %s (the bundled copy)', async (_name, text, shown, hidden) => {
    const memory = createMemoryFileSystem({ ...pagemdFiles(THEME_KIT_DEFAULTS), ...PROJECT, '/proj/doc.md': text });
    const result = await resolveStyles({ path: '/proj/doc.md', text }, { fs: memory, pagemdPath: '/pagemd' });
    const html = result.styles!.template!.html;
    for (const s of shown) expect(html).toContain(s);
    for (const s of hidden) expect(html).not.toContain(s);
  });

  it('style-default\'s plain page is theme-kit\'s fallback page (Letter, 1 in; amendment 10)', () => {
    expect(PLAIN_PAGE).toEqual(FALLBACK_PAGE);
  });
});

describe('resolveStyles: running content, first page, gate defaults (R-127, R-124)', () => {
  it('maps header, footer, first page and margin font size per position, tokens as written', async () => {
    const text = [
      '---',
      'running_header: { left: "Acme", right: "Rev 2" }',
      'page_numbers: "Page X of Y"',
      'first_page: { header: false, footer: { span: "Title page" } }',
      'page_margin_font_size: 8pt',
      '---',
      'x',
    ].join('\n');
    const styles = (await resolve(text)).result.styles!;
    expect(styles.header).toEqual({ left: 'Acme', right: 'Rev 2' });
    expect(styles.footer).toEqual({ center: 'Page :::PAGE of :::PAGES' });
    expect(styles.firstPage).toEqual({ header: false, footer: { center: 'Title page', spansWidth: true } });
    expect(styles.marginFontSize).toBe('8pt');
    // The frontmatter layer's variables are scoped too.
    expect(styles.css).toContain('.pmd-canvas {\n  --page-header-left: "Acme";');
  });

  it("book-wiki: header/footer written in its layout's margin boxes, read-only (R-141, OQ-35)", async () => {
    const styles = (await resolve('---\nprofile: book-wiki\n---\n# One\n')).result.styles!;
    expect(styles.header).toEqual({ left: ':::STRING(book-title)', right: ':::STRING(chapter-title)' });
    expect(styles.footer).toEqual({ center: ':::PAGE' });
    expect(styles.firstPage).toEqual({ header: false, footer: false });
    expect(styles.strings).toEqual({ 'book-title': '.book-title-string', 'chapter-title': '.book-content h1' });
  });

  it("the layout's own box texts win (as in pagemd's PDF); the properties fill the other positions (R-141)", async () => {
    // book-wiki's defaults say `page_numbers: true` ("1 of 12"), but book.css writes `counter(page)` itself.
    const text = '---\nprofile: book-wiki\nrunning_header: { left: "Mine", center: "Middle" }\nfirst_page: { footer: "Cover" }\n---\n';
    const styles = (await resolve(text)).result.styles!;
    expect(styles.header).toEqual({ left: ':::STRING(book-title)', center: 'Middle', right: ':::STRING(chapter-title)' });
    expect(styles.footer).toEqual({ center: ':::PAGE' });
    expect(styles.firstPage).toEqual({ header: false, footer: false });
  });

  it("pagemd's letter.css adds nothing (its boxes take the document's properties through var())", async () => {
    const styles = (await resolve('# x\n')).result.styles!;
    expect(styles.header).toBeUndefined();
    expect(styles.firstPage).toBeUndefined();
    expect(styles.strings).toBeUndefined();
  });

  it('first_page: false stays false', async () => {
    expect((await resolve('---\nfirst_page: false\n---\n')).result.styles!.firstPage).toBe(false);
  });

  it("a profile's defaults are not masked by built-in defaults (normalizeMetadata without defaults, amendment 2)", async () => {
    // Built-ins have `styles: []` and `pipeline_profile: standard_letter`; normalizing the frontmatter with them
    // would hide the profile's `styles` default.
    const files = {
      '/proj/profiles/house.json': JSON.stringify({ id: 'house', extends: 'standard_letter', metadata: { defaults: { styles: ['extra.css'], fancy_lists: true, title: 'T' } } }),
      '/proj/styles/extra.css': '.house-marker { color: teal }',
    };
    const { result } = await resolve('---\nprofile: house\n---\n', files);
    expect(result.styles!.css).toContain('.pmd-canvas .house-marker');
    expect(result.styles!.profile).toBe('house');
    expect(result.gateDefaults).toEqual({ fancy_lists: true });
  });

  it('gate fields come from the catalogue', () => {
    expect(GATE_FIELDS).toEqual(['fancy_lists']);
    expect(gateDefaultsOf({ fancy_lists: false, title: 'x' })).toEqual({ fancy_lists: false });
    expect(gateDefaultsOf(undefined)).toEqual({});
  });
});

describe('resolveStyles: the default layout (ADR-0014)', () => {
  const noLayout = { '/proj/profiles/bare.json': JSON.stringify({ id: 'bare', resources: { css: ['bare.css'] } }), '/proj/styles/bare.css': 'p { color: navy }' };

  it("a profile without a layout gets pagemd's default layout, marked usingDefault, with a note", async () => {
    const { result } = await resolve('---\nprofile: bare\n---\n', noLayout);
    const styles = result.styles!;
    expect(styles.usingDefault).toBe(true);
    expect(styles.layout).toBeNull();
    expect(styles.page).toEqual(LETTER);
    expect(result.notes).toEqual([{ kind: 'using-default-layout', message: 'Using default layout', source: '/pagemd/layouts/letter.css' }]);
    expect(result.basis!.layoutText).toContain('size: Letter;');
    expect(styles.sources).toContain('/pagemd/layouts/letter.css');
  });

  it("works with the real @pagemd/theme-kit defaults/ folder as pagemd's folder (R-128) for a workspace profile", async () => {
    const defaults = filesUnder(THEME_KIT_DEFAULTS, '/defaults');
    const memory = createMemoryFileSystem({ ...defaults, ...PROJECT, ...noLayout, '/proj/doc.md': '' });
    const result = await resolveStyles({ path: '/proj/doc.md', text: '---\nprofile: bare\n---\n' }, { fs: memory.async(), pagemdPath: '/defaults' });
    expect(result.styles?.usingDefault).toBe(true);
    expect(result.styles?.page).toEqual(LETTER);
    expect(result.styles?.css).toContain('.pmd-canvas p {');
  });
});

describe('resolveStyles: problems give plain styles plus a note (amendment 9)', () => {
  it('a document that is not a file', async () => {
    const env = memoryEnv({});
    expect(await resolveStyles({ path: null, text: '# x' }, env)).toMatchObject({ styles: null, gateDefaults: {}, notes: [{ kind: 'not-a-file' }] });
  });

  it('a frontmatter YAML error', async () => {
    const { result } = await resolve('---\ntitle: [unclosed\n---\n');
    expect(result.styles).toBeNull();
    expect(result.notes).toMatchObject([{ kind: 'frontmatter-error' }]);
  });

  it('a profile not found (named in the frontmatter)', async () => {
    const { result } = await resolve('---\nprofile: nowhere\n---\n');
    expect(result).toMatchObject({ styles: null, notes: [{ kind: 'profile-not-found', message: 'Profile not found in inheritance chain: nowhere', source: 'nowhere' }] });
  });

  it("the default profile not found (pagemd's folder lacks it, R-128)", async () => {
    const memory = createMemoryFileSystem({ ...PROJECT, '/proj/doc.md': '' });
    const result = await resolveStyles({ path: '/proj/doc.md', text: '' }, { fs: memory, pagemdPath: '/empty' });
    expect(result.notes).toMatchObject([{ kind: 'profile-not-found', message: 'Profile not found in inheritance chain: standard_letter' }]);
  });

  it('a profile that cannot be read', async () => {
    const { result } = await resolve('---\nprofile: broken\n---\n', { '/proj/profiles/broken.json': '{ nope' });
    expect(result).toMatchObject({ styles: null, notes: [{ kind: 'profile-error' }] });
  });

  it('a missing profile stylesheet, keeping the sources to watch', async () => {
    const files = { '/proj/profiles/gap.json': JSON.stringify({ id: 'gap', extends: 'standard_letter', resources: { css: ['missing.css'] } }) };
    const { result } = await resolve('---\nprofile: gap\n---\n', files);
    expect(result.styles).toBeNull();
    expect(result.notes).toMatchObject([{ kind: 'missing-stylesheet', source: 'missing.css' }]);
    expect(result.sources).toContain('/proj/profiles/gap.json');
  });

  it('a missing frontmatter stylesheet', async () => {
    const { result } = await resolve('---\nstyles: [nope.css]\n---\n');
    expect(result.notes).toMatchObject([{ kind: 'missing-stylesheet', source: 'nope.css' }]);
  });

  it("pagemd's own files incomplete", async () => {
    const files = Object.fromEntries(Object.entries(pagemdFiles()).filter(([p]) => !p.endsWith('/styles/base.css')));
    const memory = createMemoryFileSystem({ ...files, ...PROJECT, '/proj/doc.md': '' });
    const result = await resolveStyles({ path: '/proj/doc.md', text: '' }, { fs: memory, pagemdPath: '/pagemd' });
    expect(result.notes).toMatchObject([{ kind: 'missing-pagemd-files' }]);
  });

  it('CSS postcss cannot read', async () => {
    const files = { '/proj/profiles/bad.json': JSON.stringify({ id: 'bad', extends: 'standard_letter', resources: { css: ['bad.css'] } }), '/proj/styles/bad.css': 'p { color: red' };
    const { result } = await resolve('---\nprofile: bad\n---\n', files);
    expect(result.notes).toMatchObject([{ kind: 'css-error' }]);
  });

  it('template problems are ignored until P10', async () => {
    const files = { '/proj/profiles/t.json': JSON.stringify({ id: 't', extends: 'standard_letter', resources: { template: 'missing.html' } }) };
    const { result } = await resolve('---\nprofile: t\n---\n', files);
    expect(result.styles).not.toBeNull();
    expect(result.notes).toEqual([]);
  });

  it('an @import in a profile stylesheet is dropped with a note; the rest applies', async () => {
    const files = { '/proj/profiles/imp.json': JSON.stringify({ id: 'imp', extends: 'standard_letter', resources: { css: ['imp.css'] } }), '/proj/styles/imp.css': '@import url("other.css");\nh2 { color: green }' };
    const { result } = await resolve('---\nprofile: imp\n---\n', files);
    expect(result.notes).toEqual([{ kind: 'import-dropped', message: '@import url("other.css") is not loaded on the canvas.', source: 'url("other.css")' }]);
    expect(result.styles!.css).toContain('.pmd-canvas h2');
  });
});

describe('resolveStyles: the Document tab\'s hints (P8, protocol v5): @pagemd/meta\'s requirements and catalogue', () => {
  it('required from the profile, shown on the page from its template, the profile\'s own fields and defaults', async () => {
    const { result } = await resolve('# Hello\n');
    expect(result.properties.required).toEqual([]); // R-191 (OQ-42): standard_letter has no validation block, so a plain document needs no fields
    expect(result.properties.shownOnPage).toEqual(expect.arrayContaining(['title', 'document_id', 'revision', 'status'])); // its template's tokens
    const sop = (await resolve('---\nprofile: sop\n---\n# SOP\n')).result.properties;
    expect(sop.required).toEqual(['document_id', 'title', 'owner', 'approver']);
    expect(sop.profileFields.map((f) => f.key)).toEqual(expect.arrayContaining(['doc_type', 'review_status', 'review_cycle']));
    expect(sop.profileFields.every((f) => f.sources.join() === 'profile')).toBe(true);
    expect(sop.defaults).toMatchObject({ approver: 'TBD', doc_type: 'Standard Operating Procedure' });
  });
  it('none for plain styles (not a file, or a profile that is not found)', async () => {
    expect((await resolveStyles({ path: null, text: '' }, memoryEnv({}))).properties).toEqual({ required: [], shownOnPage: [], profileFields: [], defaults: {} });
    expect((await resolve('---\nprofile: nope\n---\n')).result.properties.required).toEqual([]);
  });
});
