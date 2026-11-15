// P4, per item: what each pagemd construct reads as, how a changed one is written (by @pagemd/syntax's write
// rules), how it shows on the canvas (the renderer's classes, I3), and the safety nets.
import type { Node } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { ItemRegistry, RAW_BLOCK, topBlocks } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer, type Transformer } from '@pagemd-editor/transformer';
import {
  attributeDom,
  codeBlockDom,
  escapeFancyMarkers,
  fancyListDom,
  gateFields,
  pagemdCanvasCss,
  pageMarkerOf,
  pagemdItems,
  pagemdPreset,
  scope,
  tocDecorations,
  tocFields,
  tocHeadings,
  withGateFields,
} from '../src/index.ts';

const make = (fields = {}): Transformer => createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({ fields })]);
const t = make();
const fancy = make({ fancy_lists: true });

/** The top-level blocks' node types. */
const types = (text: string, tr = t): string[] => {
  const out: string[] = [];
  tr.parse(text).forEach((n) => out.push(n.type.name));
  return out;
};
const first = (text: string, tr = t): Node => tr.parse(text).child(0);
/** Written fresh (as a changed block is). */
const fresh = (text: string, tr = t): string => tr.serialize(tr.parse(text));
/** A block's node with some attributes changed, written. */
const withAttrs = (node: Node, attrs: Record<string, unknown>, tr = t): string => tr.serialize(node.type.create({ ...node.attrs, ...attrs }, node.content, node.marks));
const find = (doc: Node, name: string): Node => {
  let found: Node | undefined;
  doc.descendants((n) => {
    if (!found && n.type.name === name) found = n;
    return !found;
  });
  if (!found) throw new Error(`no ${name}`);
  return found;
};
/** The outer element and class of a node's toDOM (no browser needed). */
const dom = (node: Node): { tag: string; attrs: Record<string, string> } => {
  const spec = node.type.spec.toDOM!(node) as unknown as [string, Record<string, string>];
  return { tag: spec[0], attrs: spec[1] ?? {} };
};

describe('registration', () => {
  it('replaces GFM table and alert explicitly; everything else is new', () => {
    const registry = new ItemRegistry([...commonmarkItems, ...gfmItems, ...pagemdItems()]);
    expect(registry.get('table')).toBeUndefined();
    expect(registry.get('alert')).toBeUndefined();
    expect(registry.get('multimd-table')?.overrides).toBe('table');
    expect(registry.get('github-alerts')?.overrides).toBe('alert');
  });

  it("preset-gfm's own alert rule is gone: only the dialect reads `> [!NOTE]` (R-99, amendment 6)", () => {
    expect(t.markdownIt.core.ruler.getRules('').map((r) => r.name)).not.toContain('gfm-alert');
    expect((t.markdownIt.core.ruler as unknown as { __rules__: { name: string }[] }).__rules__.map((r) => r.name)).not.toContain('gfm-alert');
  });

  it('brings the @pagemd/meta property catalogue (amendment 1)', () => {
    const preset = pagemdPreset();
    expect(preset.meta?.gates['fancy-lists']).toEqual({ field: 'fancy_lists', value: true });
    expect(preset.meta?.fields.length).toBeGreaterThan(20);
  });
});

describe('the gate (fancy lists) from the frontmatter (amendment 3)', () => {
  it('reads fancy_lists the way pagemd does', () => {
    expect(gateFields('# No frontmatter\n')).toEqual({ fancy_lists: false });
    expect(gateFields('---\ntitle: X\nfancy_lists: true\n---\n\nText\n')).toEqual({ fancy_lists: true });
    expect(gateFields('---\r\nfancy_lists: true\r\n---\r\n')).toEqual({ fancy_lists: true });
    expect(gateFields('---\nfancy_lists: [unclosed\n---\n')).toEqual({ fancy_lists: false });
    expect(gateFields('Text\n\n---\nfancy_lists: true\n---\n')).toEqual({ fancy_lists: false });
  });

  it("layers the profile's gate defaults under the frontmatter, as pagemd does (R-124, P5 amendment 2)", () => {
    const profile = { fancy_lists: true };
    expect(gateFields('# No frontmatter\n', profile)).toEqual({ fancy_lists: true });
    expect(gateFields('---\ntitle: X\n---\n', profile)).toEqual({ fancy_lists: true });
    // The frontmatter wins over the profile, both ways.
    expect(gateFields('---\nfancy_lists: false\n---\n', profile)).toEqual({ fancy_lists: false });
    expect(gateFields('---\nfancy_lists: true\n---\n', { fancy_lists: false })).toEqual({ fancy_lists: true });
    // Normalized without built-in defaults: an alias or another built-in-default key doesn't mask the profile.
    expect(gateFields('---\nprofile: sop\nstyles: []\n---\n', profile)).toEqual({ fancy_lists: true });
    // Unreadable YAML still switches nothing on.
    expect(gateFields('---\nfancy_lists: [unclosed\n---\n', profile)).toEqual({ fancy_lists: false });
  });

  it('off: a lettered list is text; on: an ordered list that remembers its markers', () => {
    const text = 'a. one\nb. two\n';
    expect(types(text)).toEqual(['paragraph']);
    const list = first(text, fancy);
    expect(list.type.name).toBe('ordered_list');
    expect(list.attrs['pmdFancy']).toEqual({ type: 'a', start: 1, delimiter: '.' });
  });

  it('withGateFields swaps only the dialect item (same schema)', () => {
    const items = pagemdItems();
    const swapped = withGateFields(items, { fancy_lists: true });
    expect(swapped.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(swapped.filter((item, k) => item !== items[k]).map((i) => i.id)).toEqual(['pagemd-dialect']);
  });

  it('writes fancy markers with listMarker/markerGap (capital letters keep two spaces)', () => {
    expect(fresh('i. one\nii. two\niii. three\n', fancy)).toBe('i.   one\nii.  two\niii. three');
    expect(fresh('A.  one\nB.  two\n', fancy)).toBe('A.  one\nB.  two');
    expect(fresh('c) x\nd) y\n', fancy)).toBe('c) x\nd) y');
  });

  it('escapes a paragraph line that would start a lettered or Roman list', () => {
    expect(escapeFancyMarkers('a. text\nii. more\n  > iv) quoted')).toBe('a\\. text\nii\\. more\n  > iv\\) quoted');
    expect(escapeFancyMarkers('i.e. not a marker')).toBe('i.e. not a marker');
    // Outside a list, a lettered list can't interrupt a paragraph unless it starts at 1 (a / i): the line is text.
    const doc = fancy.parse('Some text\nii. continued\nb) also\n');
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(fancy.serialize(doc)).toBe('Some text\nii\\. continued\nb\\) also');
    expect(fancy.parse(fancy.serialize(doc)).eq(doc)).toBe(true);
  });

  it('the canvas shows the marker kind (the renderer\'s type and class)', () => {
    expect(fancyListDom({ pmdFancy: { type: 'I', start: 1, delimiter: '.' } })).toEqual({ type: 'I', class: 'list-upper-roman' });
    expect(fancyListDom({ pmdFancy: null })).toEqual({});
  });
});

describe('attributes {…} (ADR-0013 amendment: one item extends other items\' nodes)', () => {
  it('heading, paragraph, fence, image and link keep them and write them back', () => {
    const doc = t.parse('# Title {#intro .lead}\n\nText here {.note}\n\n```js {.line-numbers data-file="a.js"}\nx\n```\n\n![alt](p.png){width=50%}\n\n[link](https://x.org){target=_blank}\n');
    expect(doc.child(0).attrs['pmdAttrs']).toEqual([['id', 'intro'], ['class', 'lead']]);
    expect(doc.child(1).attrs['pmdAttrs']).toEqual([['class', 'note']]);
    expect(doc.child(2).attrs['pmdAttrs']).toEqual([['class', 'line-numbers'], ['data-file', 'a.js']]);
    expect(find(doc, 'image').attrs['pmdAttrs']).toEqual([['width', '50%']]);
    expect(t.serialize(doc)).toBe('# Title {#intro .lead}\n\nText here {.note}\n\n```js {.line-numbers data-file="a.js"}\nx\n```\n\n![alt](p.png){width="50%"}\n\n[link](https://x.org){target="_blank"}');
    expect(t.parse(t.serialize(doc)).eq(doc)).toBe(true);
  });

  it('a setext heading keeps them before its underline', () => {
    expect(fresh('Title {.x}\n===\n')).toBe('Title {.x}\n===');
  });

  it('the canvas applies class, id and an image\'s size (I3, D22)', () => {
    expect(attributeDom({ pmdAttrs: [['class', 'a b'], ['id', 'i'], ['data-x', '1'], ['width', '50%']] })).toEqual({ class: 'a b', id: 'i', width: '50%' });
    expect(codeBlockDom({ params: 'mermaid', pmdAttrs: null })).toEqual({ 'data-language': 'mermaid', class: 'pmd-diagram' });
  });

  it('safety net: attributes on a node that can\'t keep them keep the block raw (I4)', () => {
    expect(types('- item {.x}\n\n> quote\n{.y}\n\n*em*{.z} text\n')).toEqual([RAW_BLOCK, RAW_BLOCK, RAW_BLOCK]);
  });
});

describe('directives (atoms; SECTION/COVER are markers, amendment 8; since P18 a matched pair is drawn as a transparent box, R-229)', () => {
  it('each directive has its own node and is written by its item', () => {
    const text = '<!-- ::PAGEBREAK -->\n\n<!-- ::TOC levels="2" -->\n\n<!-- ::SECTION_START id="a" -->\n\n<!-- ::SECTION_END -->\n\n<!-- ::LAYOUT(wide) -->\n\n<!-- ::COVER_START -->\n\n<!-- ::COVER_END -->\n\n<!-- ::INDEX -->\n\n<!-- ::INCLUDE path="x.md" -->\n\n<!-- ::BREAK -->\n';
    // P18: each matched SECTION or COVER pair sits in a box; the blocks themselves (what the ranges and saving see) are unchanged.
    expect(types(text)).toEqual(['pmd_pagebreak', 'pmd_toc', 'pmd_section_box', 'pmd_layout', 'pmd_section_box', 'pmd_index', 'pmd_include_directive', 'pmd_directive']);
    expect(topBlocks(t.parse(text)).map((b) => b.node.type.name)).toEqual(['pmd_pagebreak', 'pmd_toc', 'pmd_section', 'pmd_section', 'pmd_layout', 'pmd_cover', 'pmd_cover', 'pmd_index', 'pmd_include_directive', 'pmd_directive']);
    expect(fresh(text)).toBe(text.replace(/\n$/, ''));
  });

  it('a changed parameter is rewritten in place; the others keep their text', () => {
    const toc = first('<!-- ::TOC levels=\'2\' min=1 -->\n');
    const data = toc.attrs['data'] as { attrs: Record<string, string> };
    expect(withAttrs(toc, { data: { ...data, attrs: { ...data.attrs, levels: '3' } } })).toBe('<!-- ::TOC levels="3" min=1 -->');
  });

  it('an INDEX term in text is an inline atom', () => {
    const doc = t.parse('Some <!-- ::INDEX term="safety" -->text.\n');
    expect(find(doc, 'pmd_index_marker').attrs['data']).toMatchObject({ name: 'INDEX', attrs: { term: 'safety' } });
    expect(t.serialize(doc)).toBe('Some <!-- ::INDEX term="safety" -->text.');
  });

  it('the canvas uses the renderer\'s classes, with a chip', () => {
    const doc = t.parse('<!-- ::PAGEBREAK -->\n\n<!-- ::TOC -->\n\n<!-- ::INDEX -->\n\n<!-- ::INCLUDE path="a.md" -->\n');
    expect(dom(doc.child(0)).attrs['class']).toContain('break-page');
    expect(dom(doc.child(1)).attrs['class']).toContain('toc-placeholder');
    expect(dom(doc.child(2)).attrs['class']).toContain('index-placeholder');
    expect(dom(doc.child(3)).attrs).toMatchObject({ 'data-path': 'a.md' });
  });

  it('page markers for Print Layout (P6, amendment 6): PAGEBREAK, SECTION and COVER wrappers, LAYOUT', () => {
    const doc = t.parse(
      '<!-- ::PAGEBREAK -->\n\n<!-- ::SECTION_START class="chapter wide" id="a" -->\n\n<!-- ::SECTION_END -->\n\n<!-- ::COVER_START -->\n\n<!-- ::COVER_END -->\n\n<!-- ::LAYOUT(landscape) -->\n\n<!-- ::LAYOUT name="tall" -->\n\n<!-- ::LAYOUT -->\n\n<!-- ::TOC -->\n\nText\n',
    );
    const markers: unknown[] = [];
    for (const { node } of topBlocks(doc)) markers.push(pageMarkerOf(node)); // (P18: inside their boxes)
    expect(markers).toEqual([
      { kind: 'pagebreak' },
      { kind: 'wrapper-start', className: 'chapter wide' },
      { kind: 'wrapper-end' },
      { kind: 'wrapper-start', className: 'cover' },
      { kind: 'wrapper-end' },
      { kind: 'layout', name: 'landscape' },
      { kind: 'layout', name: 'tall' },
      { kind: 'layout', name: 'default' },
      null,
      null,
    ]);
  });

  it('outline: section starts, TOC, index and cover', () => {
    const registry = new ItemRegistry([...commonmarkItems, ...gfmItems, ...pagemdItems()]);
    const doc = t.parse('<!-- ::SECTION_START id="intro" -->\n\n<!-- ::SECTION_END -->\n\n<!-- ::TOC -->\n');
    const entries: string[] = [];
    doc.descendants((node, pos) => {
      const entry = registry.itemForType(node.type.name)?.outline?.(node, pos);
      if (entry) entries.push(`${entry.kind}:${entry.label}`);
    });
    expect(entries).toEqual(['section:intro', 'toc:Table of contents']);
  });

  it("TOC: the live heading list follows pagemd's rules (R-148): levels, min (default 2), frontmatter settings", () => {
    const doc = t.parse('# One\n\n## Two\n\n### Three\n\n#### Four\n\n<!-- ::TOC levels="2" -->\n');
    const tocNode = find(doc, 'pmd_toc');
    const data = tocNode.attrs['data'] as never;
    // pagemd's default shallowest level is 2 (renderer-web fillTocPlaceholder: toc_min_level ?? 2).
    expect(tocHeadings(doc, data)).toEqual([{ level: 2, text: 'Two' }]);
    // The directive wins over the frontmatter; without the directive's own value, toc_levels / toc_min_level count.
    expect(tocHeadings(doc, data, { levels: 4, minLevel: 1 })).toEqual([{ level: 1, text: 'One' }, { level: 2, text: 'Two' }]);
    const bare = t.parse('# One\n\n## Two\n\n### Three\n\n#### Four\n\n<!-- ::TOC -->\n');
    const bareData = find(bare, 'pmd_toc').attrs['data'] as never;
    expect(tocHeadings(bare, bareData).map((h) => h.text)).toEqual(['Two', 'Three']);
    expect(tocHeadings(bare, bareData, { levels: 4 }).map((h) => h.text)).toEqual(['Two', 'Three', 'Four']);
    const state = EditorState.create({ doc, plugins: [tocDecorations] });
    const set = tocDecorations.props.decorations!.call(tocDecorations, state) as unknown as { find(): { spec: { pmdToc: unknown } }[] };
    expect(set.find()[0]!.spec.pmdToc).toHaveLength(1);
  });

  it('TOC: no frontmatter blocks, no headings with inline markup (like pagemd), section scope', () => {
    const doc = t.parse('---\ntitle: x\n---\n\n## Plain\n\n## With *emphasis*\n\n## Sub\n\n<!-- ::TOC section -->\n\n### A\n\n#### B\n\n## Next\n\n### C\n');
    const data = find(doc, 'pmd_toc').attrs['data'] as never;
    let tocPos = 0;
    doc.forEach((node, pos) => {
      if (node.type.name === 'pmd_toc') tocPos = pos;
    });
    // The frontmatter is one node since P8 (it was a rule plus the setext heading "title: x"): no heading to leave out.
    expect(doc.child(0).type.name).toBe('pmd_frontmatter');
    const bodyFrom = doc.child(0).nodeSize;
    expect(tocHeadings(doc, { ...(data as object), attrs: {} } as never, { bodyFrom }).map((h) => h.text)).toEqual(['Plain', 'Sub', 'A', 'Next', 'C']);
    expect(tocHeadings(doc, { ...(data as object), attrs: {} } as never).map((h) => h.text)).toEqual(['Plain', 'Sub', 'A', 'Next', 'C']);
    expect(tocHeadings(doc, data, { bodyFrom }, tocPos).map((h) => h.text)).toEqual(['A']);
    expect(tocHeadings(doc, data, { bodyFrom, levels: 4 }, tocPos).map((h) => h.text)).toEqual(['A', 'B']);
  });

  it('tocFields: toc_levels / toc_min_level from the frontmatter, aliases included', () => {
    expect(tocFields('---\ntoc_depth: 2\ntoc_min_level: 1\n---\n# x\n')).toEqual({ levels: 2, minLevel: 1 });
    // @pagemd/meta's built-in defaults are pagemd's own (3 and 2).
    expect(tocFields('# no frontmatter\n')).toEqual({ levels: 3, minLevel: 2 });
  });
});

describe('wrappers (written by their item with the children\'s markdown)', () => {
  it('callouts: multi-line and single-line forms', () => {
    const text = '[[WARNING]]\nCheck *this*.\n[[/WARNING]]\n\n[[DANGER]] Stop. [[/DANGER]]\n';
    expect(types(text)).toEqual(['pmd_callout', 'pmd_callout']);
    expect(fresh(text)).toBe(text.replace(/\n$/, ''));
    expect(dom(first(text)).attrs['class']).toBe('callout callout-warning');
  });

  it('named containers, ::: {…} and alerts', () => {
    const text = ':::details Title here\nInside.\n:::\n\n::: {.box #b}\nBoxed.\n:::\n\n> [!TIP]\n> A tip.\n';
    expect(types(text)).toEqual(['pmd_container', 'pmd_div', 'alert']);
    expect(fresh(text)).toBe(text.replace(/\n$/, ''));
    const doc = t.parse(text);
    expect(dom(doc.child(0)).attrs).toMatchObject({ class: 'container container-details', 'data-title': 'Title here' });
    expect(dom(doc.child(1)).attrs).toMatchObject({ class: 'box pmd-div', id: 'b' });
    expect(dom(doc.child(2)).attrs['class']).toBe('markdown-alert markdown-alert-tip');
  });

  it('a ::: {…} the author never closed is written without a closing line (C2 meta.closed)', () => {
    const text = '::: {.outer}\n::: {.inner}\nText\n:::\n';
    const doc = t.parse(text);
    // pagemd's reader closes the outer box at the first `:::`; the inner one is never closed.
    expect(find(doc, 'pmd_div').child(0).attrs['closed']).toBe(false);
    expect(t.serialize(doc)).toBe('::: {.outer}\n::: {.inner}\nText\n:::');
    expect(t.parse(t.serialize(doc)).eq(doc)).toBe(true);
  });

  it('an edit inside a wrapper writes the wrapper and reads back', () => {
    const doc = t.parse(':::note\nOld text\n:::\n');
    const container = doc.child(0);
    const paragraph = container.child(0);
    const changed = container.copy(container.content.replaceChild(0, paragraph.copy(paragraph.content.append(paragraph.content.cut(0, 0)).addToEnd(doc.type.schema.text(' new')))));
    expect(t.serialize(changed)).toBe(':::note\nOld text new\n:::');
  });
});

describe('tables (replace GFM tables; written from the table model)', () => {
  const text = '| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 ||\n| 3 | 4 | 5 |\n| ^^ | 6 | 7 |\n{.grid #t1}\n';
  const captioned = 'Table: Numbers\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';

  it('reads spans, alignment and the attribute line under it into one block', () => {
    const doc = t.parse(text);
    expect(types(text)).toEqual(['table']);
    const table = doc.child(0);
    expect(table.attrs['pmdAttrs']).toEqual([['class', 'grid'], ['id', 't1']]);
    expect(table.child(1).child(1).attrs['colspan']).toBe(2);
    expect(table.child(2).child(0).attrs['rowspan']).toBe(2);
    expect(dom(table).attrs['class']).toBe('pmd-table');
  });

  it('a changed table is written by writeTable and reads back the same', () => {
    const doc = t.parse(text);
    const written = t.serialize(doc);
    expect(written).toBe('| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 ||\n| 3 | 4 | 5 |\n| ^^ | 6 | 7 |\n{.grid #t1}');
    expect(t.parse(written).eq(doc)).toBe(true);
  });

  it('a "Table:" caption is part of the table block and written with it', () => {
    const doc = t.parse(captioned);
    expect(types(captioned)).toEqual(['table']);
    expect(doc.child(0).attrs['model']).toMatchObject({ tableCaption: { text: 'Numbers', form: 'table', position: 'top' } });
    expect(t.serialize(doc)).toBe('Table: Numbers\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it("the cell after a `||` span is kept (pagemd-common's attrs-fix, OQ-29, R-200): an editable table that writes back as written", () => {
    const source = '| A | B | C |\n|---|---|---|\n| 1 || 2 |\n';
    expect(types(source)).toEqual(['table']);
    const row = t.parse(source).child(0).child(1);
    expect([row.childCount, row.child(0).attrs['colspan'], row.child(1).textContent]).toEqual([2, 2, '2']);
    expect(t.serialize(t.parse(source))).toBe('| A | B | C |\n| --- | --- | --- |\n| 1 || 2 |');
  });

  it('a pipe typed in a cell is escaped; a table with a list in a multi-line cell stays raw (amendment 7)', () => {
    const doc = t.parse('| A |\n|---|\n| x |\n');
    const cell = find(doc, 'table_cell');
    const table = doc.child(0);
    const row = table.child(1);
    const newCell = cell.type.create(cell.attrs, doc.type.schema.text('a|b'));
    const edited = table.copy(table.content.replaceChild(1, row.copy(row.content.replaceChild(0, newCell))));
    expect(t.serialize(edited)).toBe('| A |\n| --- |\n| a\\|b |');
    expect(types('| A | B |\n|---|---|\n| - one \\\n| - two | x |\n')).toEqual([RAW_BLOCK]);
  });
});

describe('media', () => {
  it('FIGURE is an atom with its data; written back as written', () => {
    const text = '<!-- ::FIGURE src="shot.png" caption="A shot" width="half" -->\n';
    const node = first(text);
    expect(node.type.name).toBe('pmd_figure');
    expect(fresh(text)).toBe(text.replace(/\n$/, ''));
    expect(dom(node).attrs['class']).toBe('pmd-figure width-half');
  });

  it('annotated image: the parsed YAML is on the node (not read again), and it writes back as written', () => {
    const text = '::: annotated-image shot.png\noptions:\n  caption: "Screen"  # the main one\nmarkers:\n  - { id: 1, x: 10, y: 20, label: "Menu" }\n:::\n';
    const node = first(text);
    expect(node.type.name).toBe('pmd_annotated_image');
    expect((node.attrs['data'] as { data: { markers: unknown[] } }).data.markers).toHaveLength(1);
    expect(fresh(text)).toBe(text.replace(/\n$/, ''));
  });

  it('embeds and wikilinks are inline atoms (R-117)', () => {
    const doc = t.parse('See [[Other Page|the page]] and ![[pic.png|A pic]].\n');
    expect(find(doc, 'pmd_wikilink').attrs['data']).toEqual({ target: 'Other Page', display: 'the page' });
    expect(find(doc, 'pmd_embed').attrs['data']).toEqual({ path: 'pic.png', alt: 'A pic' });
    expect(t.serialize(doc)).toBe('See [[Other Page|the page]] and ![[pic.png|A pic]].');
    expect(dom(find(doc, 'pmd_wikilink')).attrs['class']).toBe('wikilink');
    expect(dom(find(doc, 'pmd_embed')).attrs['class']).toBe('embedded-image');
  });

  it('include on its own line is an atom; the canvas shows its path', () => {
    const node = first('!!!include(chapters/one.md)!!!\n');
    expect(node.type.name).toBe('pmd_include');
    expect(fresh('!!!include(chapters/one.md)!!!\n')).toBe('!!!include(chapters/one.md)!!!');
    expect(dom(node).attrs['data-path']).toBe('chapters/one.md');
  });

  it('inline badge callouts', () => {
    const doc = t.parse('Careful [!WARNING] here.\n');
    expect(dom(find(doc, 'pmd_inline_callout')).attrs['class']).toBe('callout callout-warning callout-inline');
    expect(t.serialize(doc)).toBe('Careful [!WARNING] here.');
  });
});

describe('canvas CSS (D18, R-116)', () => {
  it('the structural CSS from @pagemd/syntax, scoped to the canvas', () => {
    expect(pagemdCanvasCss).toContain('.pmd-canvas .marker {');
    expect(pagemdCanvasCss).toContain('.pmd-canvas .image-wrapper {');
    expect(scope('.a, .b img {\n  x: 1;\n}\n.c {\n}', '.s')).toBe('\n.s .a, .s .b img {\n  x: 1;\n}\n.s .c {\n}');
  });
});


describe('the annotated-image node view calls the renderer rule @pagemd/syntax registers (D1)', () => {
  it('draws from the data on the node, with markers placed by the structural CSS classes', async () => {
    const { annotatedHtmlFor } = await import('../src/media/media.ts');
    const node = first('::: annotated-image shot.png\noptions:\n  caption: "Screen"\nmarkers:\n  - { id: 1, x: 10, y: 20, label: "Menu" }\n:::\n');
    const html = annotatedHtmlFor(node);
    expect(html).toContain('class="image-wrapper"');
    expect(html).toContain('class="marker"');
    expect(html).toContain('<span class="fig-num">');
    expect(html).toContain('Screen');
  });
});

describe('named containers the author never closed (R-118)', () => {
  it(':::aside inside :::details with the same `:::` is written back unclosed and reads back the same', () => {
    const text = ':::details\n**Outer**\n\n:::aside\nNested.\n:::\n\nThe nesting.\n:::\n';
    const doc = t.parse(text);
    expect(find(doc, 'pmd_container').child(1).attrs['closed']).toBe(false);
    expect(t.parse(t.serialize(doc)).eq(doc)).toBe(true);
  });
});

describe('feature plugins start with the pagemd preset', () => {
  it('plugin-clipboard builds its transformer from the registry (overrides already applied) and starts', async () => {
    const { createEditor } = await import('@pagemd-editor/core');
    const { clipboardPlugin } = await import('@pagemd-editor/plugin-clipboard');
    const { commonmarkPreset } = await import('@pagemd-editor/preset-commonmark');
    const { gfmPreset } = await import('@pagemd-editor/preset-gfm');
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const editor = await createEditor({ presets: [commonmarkPreset, gfmPreset, pagemdPreset()], plugins: [clipboardPlugin()] });
      expect(errors).toEqual([]);
      expect(editor.pmPlugins).toHaveLength(2); // the clipboard's, and (P18) the one that keeps SECTION/COVER boxes matched
    } finally {
      console.error = original;
    }
  });
});
