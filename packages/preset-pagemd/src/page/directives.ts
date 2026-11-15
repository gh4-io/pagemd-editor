// Comment directives `<!-- ::KEYWORD params -->` (@pagemd/syntax's shared directive runner; editor mode keeps
// them as written, C2). Each item with a block form has its own atom node; a directive no item owns (BREAK,
// R-107) or one written where its item has no block form stays a generic `pmd_directive` atom, written back as
// it was. Everything is written by the items' own write rules (C3), from the data on the node.
//
// SECTION_START/END and COVER_START/END are separate start and end markers, not wrappers (amendment 8): a
// wrapper would make a whole section one block, so any edit inside would rewrite it. Since P18 (R-229, reversing that
// amendment's drawing part only) a matched pair is drawn as pagemd draws it, a box (`pmd_section_box`, `<div id class>`)
// around the start marker, the blocks between and the end marker: a TRANSPARENT group (core's groups.ts), which reading,
// saving and the block ranges look through, so an edit inside a section still rewrites only its own block.
import type { Node, NodeSpec } from 'prosemirror-model';
import type { DOMOutputSpec } from 'prosemirror-model';
import { insertBlockCommand, insertInlineCommand, type CommandInfo, type CommandSpec, type OutlineEntry, type SyntaxItem, type TokenSpec } from '@pagemd-editor/core';
import { directiveType } from '../dialect.ts';
import { atomWriter, inlineWriter, UNKNOWN_DIRECTIVE } from '../shared/write.ts';
import { classes } from '../shared/dom.ts';
import { tocNodeView, type DirectiveData } from './toc-view.ts';
import { commentAnchor } from './comment-anchor.ts';

export type { DirectiveData };


const dataOf = (node: Node): DirectiveData => node.attrs['data'] as DirectiveData;
const pmdData = (tok: { meta: unknown }): Record<string, unknown> => ((tok.meta as { pmd?: { data: Record<string, unknown> } } | null)?.pmd?.data ?? {});
const pmdItemOf = (tok: { meta: unknown }): string => (tok.meta as { pmd?: { item: string } } | null)?.pmd?.item ?? UNKNOWN_DIRECTIVE;
const text = (value: unknown): string => (value === true ? '' : typeof value === 'string' ? value : '');

/** An atom block node that shows a chip with a label (editor UI), inside the renderer's own element (I3). */
function atomSpec(dom: (node: Node) => DOMOutputSpec, extraAttrs: NodeSpec['attrs'] = {}): NodeSpec {
  return {
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    attrs: { data: {}, ...extraAttrs },
    toDOM: dom,
  };
}

/** The renderer's element, with the editor's chip inside it (a label an author can see in every view). */
function chip(tag: string, attrs: Record<string, string>, label: string): DOMOutputSpec {
  return [tag, { ...attrs, class: classes(attrs['class'], 'pmd-directive'), contenteditable: 'false' }, ['span', { class: 'pmd-chip' }, label]];
}

/** Inserts the block directive `<!-- ::NAME(parenParams) -->` below the selection (P7). */
function directiveCommand(info: CommandInfo, item: string, name: string, parenParams: string | null = null, attrs: Record<string, string> = {}): CommandSpec {
  const node = directiveType(item);
  return insertBlockCommand(info, node, (schema) => schema.nodes[node]!.create({ data: { name, parenParams, params: '', attrs } }));
}

interface DirectiveItemOptions {
  item: string;
  label: string;
  icon: string;
  keywords: string[];
  dom(data: DirectiveData): DOMOutputSpec;
  commands?: CommandSpec[];
  outline?(data: DirectiveData, pos: number): OutlineEntry | null;
}

/** One block directive item: node `pmd_<item>`, read from its renamed `pagemd_directive` token. */
function directiveItem(options: DirectiveItemOptions): SyntaxItem {
  const name = directiveType(options.item);
  const spec: TokenSpec = { node: name, getAttrs: (tok) => ({ data: pmdData(tok) }) };
  return {
    id: options.item,
    group: options.item === 'include-directive' ? 'document' : 'page',
    schema: { nodes: { [name]: atomSpec((node) => options.dom(dataOf(node))) } },
    fromTokens: { [name]: spec },
    toMarkdown: { nodes: { [name]: atomWriter(() => options.item) } },
    label: options.label,
    icon: options.icon,
    slash: { keywords: options.keywords },
    ...(options.commands ? { commands: options.commands } : {}),
    // (only its own node: since P18 the section item also declares the box around a section, which has no directive data)
    ...(options.outline ? { outline: (node: Node, pos: number) => (node.type.name === name ? options.outline!(dataOf(node), pos) : null) } : {}),
  };
}

const isStart = (data: DirectiveData): boolean => data.name.endsWith('_START');

export const pagebreak = directiveItem({
  item: 'pagebreak',
  label: 'Page break',
  icon: 'debug-step-over',
  keywords: ['page break', 'break', 'new page'],
  commands: [directiveCommand({ id: 'pagebreak.insert', label: 'Page break', icon: 'debug-step-over', keywords: ['page break', 'break', 'new page'] }, 'pagebreak', 'PAGEBREAK')],
  dom: () => chip('div', { class: 'break-page' }, 'Page break'),
});

export const toc = directiveItem({
  item: 'toc',
  label: 'Table of contents',
  icon: 'list-tree',
  keywords: ['toc', 'table of contents', 'contents'],
  commands: [directiveCommand({ id: 'toc.insert', label: 'Table of contents', icon: 'list-tree', keywords: ['toc', 'table of contents', 'contents'] }, 'toc', 'TOC')],
  dom: (data) => [
    'div',
    {
      class: 'toc-placeholder pmd-directive pmd-toc',
      contenteditable: 'false',
      'data-levels': text(data.attrs['levels']),
      'data-min-level': text(data.attrs['min']),
    },
    ['span', { class: 'pmd-chip' }, 'Table of contents'],
    ['ol', { class: 'pmd-toc-list' }],
  ],
  outline: (_data, pos) => ({ kind: 'toc', label: 'Table of contents', level: 0, pos }),
});
toc.nodeViews = { pmd_toc: tocNodeView };

export const section = directiveItem({
  item: 'section',
  label: 'Section',
  icon: 'symbol-namespace',
  keywords: ['section'],
  commands: [
    directiveCommand({ id: 'section.start', label: 'Section start', icon: 'symbol-namespace', keywords: ['section', 'start', 'begin'] }, 'section', 'SECTION_START'),
    directiveCommand({ id: 'section.end', label: 'Section end', icon: 'symbol-namespace', keywords: ['section', 'end'] }, 'section', 'SECTION_END'),
  ],
  dom: (data) => {
    const id = text(data.attrs['id']);
    const cls = text(data.attrs['class']);
    const label = `${isStart(data) ? 'Section start' : 'Section end'}${id ? ` #${id}` : ''}${cls ? ` .${cls.split(/\s+/).join(' .')}` : ''}`;
    return chip('div', { class: isStart(data) ? 'pmd-section-start' : 'pmd-section-end', 'data-section-id': id }, label);
  },
  outline: (data, pos) => (isStart(data) ? { kind: 'section', label: text(data.attrs['id']) || text(data.attrs['class']) || 'Section', level: 0, pos } : null),
});

/** P18 (R-229): the box pagemd draws between a section's markers (`<div id="…" class="…">`) or a cover's (`<div class="cover">`). */
export const SECTION_BOX = 'pmd_section_box';

section.schema.nodes![SECTION_BOX] = {
  content: 'block+',
  group: 'block',
  transparent: true, // core's TRANSPARENT: the block ranges and saving look through it
  selectable: false, // (selecting the box itself and pressing Delete would take a whole section)
  attrs: { kind: { default: 'section' }, className: { default: '' }, id: { default: '' } },
  toDOM: (node) => ['div', { class: (node.attrs['className'] as string) || null, id: (node.attrs['id'] as string) || null, 'data-pmd-box': node.attrs['kind'] as string }, 0],
};
// Never asked for by saving (it writes the blocks inside); a document written fresh writes the blocks one after another.
section.toMarkdown.nodes![SECTION_BOX] = (state, node) => state.renderContent(node);
const isMarker = (block: Node, item: string): boolean => block.type.name === directiveType(item);
section.groups = [
  {
    node: SECTION_BOX,
    opens: (block) => (isMarker(block, 'section') && isStart(dataOf(block)) ? { kind: 'section', className: text(dataOf(block).attrs['class']).trim(), id: text(dataOf(block).attrs['id']).trim() } : null),
    // An end closes the innermost open box, whatever opened it (as `</div>` does in pagemd's page).
    closes: (block) => (isMarker(block, 'section') || isMarker(block, 'cover')) && !isStart(dataOf(block)),
  },
];

export const layout = directiveItem({
  item: 'layout',
  label: 'Page layout',
  icon: 'layout',
  keywords: ['layout', 'page layout', 'landscape'],
  commands: [
    directiveCommand({ id: 'layout.landscape', label: 'Landscape pages', icon: 'layout', keywords: ['layout', 'page layout', 'landscape'] }, 'layout', 'LAYOUT', 'landscape'),
    directiveCommand({ id: 'layout.default', label: 'Default pages', icon: 'layout', keywords: ['layout', 'page layout', 'default', 'portrait'] }, 'layout', 'LAYOUT', 'default'),
  ],
  dom: (data) => {
    const name = data.parenParams ?? text(data.attrs['name']);
    return chip('div', { class: classes('pmd-layout', name && `page-${name}`) }, `Page layout${name ? `: ${name}` : ''}`);
  },
});

export const cover = directiveItem({
  item: 'cover',
  label: 'Cover page',
  icon: 'book',
  keywords: ['cover', 'title page'],
  commands: [
    directiveCommand({ id: 'cover.start', label: 'Cover start', icon: 'book', keywords: ['cover', 'title page', 'start'] }, 'cover', 'COVER_START'),
    directiveCommand({ id: 'cover.end', label: 'Cover end', icon: 'book', keywords: ['cover', 'title page', 'end'] }, 'cover', 'COVER_END'),
  ],
  dom: (data) => chip('div', { class: isStart(data) ? 'pmd-cover-start' : 'pmd-cover-end' }, isStart(data) ? 'Cover start' : 'Cover end'),
  outline: (data, pos) => (isStart(data) ? { kind: 'cover', label: 'Cover', level: 0, pos } : null),
});
cover.groups = [{ node: SECTION_BOX, opens: (block) => (isMarker(block, 'cover') && isStart(dataOf(block)) ? { kind: 'cover', className: 'cover', id: '' } : null), closes: () => false }];

export const indexBlock = directiveItem({
  item: 'index',
  label: 'Index',
  icon: 'symbol-key',
  keywords: ['index'],
  commands: [directiveCommand({ id: 'index.insert', label: 'Index', icon: 'symbol-key', keywords: ['index'] }, 'index', 'INDEX')],
  dom: () => chip('div', { class: 'index-placeholder' }, 'Index'),
  outline: (_data, pos) => ({ kind: 'index', label: 'Index', level: 0, pos }),
});

export const includeDirective = directiveItem({
  item: 'include-directive',
  label: 'Include placeholder',
  icon: 'file-symlink-file',
  keywords: ['include placeholder'],
  commands: [directiveCommand({ id: 'include-directive.insert', label: 'Include placeholder', icon: 'file-symlink-file', keywords: ['include placeholder'] }, 'include-directive', 'INCLUDE', null, { path: 'file.md' })],
  dom: (data) => {
    const path = text(data.attrs['path']);
    return chip('div', { class: 'include-placeholder', 'data-path': path }, `[Include: ${path}]`);
  },
});

/**
 * A directive no item owns (e.g. `<!-- ::BREAK -->`, R-107), or an INDEX term written on its own line: kept
 * exactly as written (its item's write rule, or writeDirective for an unknown keyword).
 */
export const unknownDirective: SyntaxItem = {
  id: UNKNOWN_DIRECTIVE,
  group: 'page',
  schema: {
    nodes: {
      pmd_directive: atomSpec(
        (node) => chip('div', { class: node.attrs['item'] === UNKNOWN_DIRECTIVE ? 'pmd-directive-unknown' : 'pmd-directive-other' }, `<!-- ::${dataOf(node).name} -->`),
        { item: { default: UNKNOWN_DIRECTIVE } },
      ),
    },
  },
  fromTokens: { pmd_directive: { node: 'pmd_directive', getAttrs: (tok) => ({ data: pmdData(tok), item: pmdItemOf(tok) }) } },
  toMarkdown: { nodes: { pmd_directive: atomWriter((node) => node.attrs['item'] as string) } },
  label: 'Directive',
  icon: 'symbol-event',
};

/** An inline atom showing its chip. */
function inlineAtom(dom: (node: Node) => DOMOutputSpec, extraAttrs: NodeSpec['attrs'] = {}): NodeSpec {
  return { inline: true, group: 'inline', atom: true, selectable: true, attrs: { data: {}, ...extraAttrs }, toDOM: dom };
}

/** An INDEX term in the text: `<!-- ::INDEX term="…" -->` (item `index-marker`). */
export const indexMarker: SyntaxItem = {
  id: 'index-marker',
  group: 'text',
  schema: {
    nodes: {
      pmd_index_marker: inlineAtom((node) => {
        const data = dataOf(node);
        const term = text(data.attrs['term']);
        return ['span', { class: 'index-marker pmd-directive', 'data-term': term, 'data-sort': text(data.attrs['sort']), contenteditable: 'false' }, ['span', { class: 'pmd-chip' }, term]];
      }),
    },
  },
  fromTokens: { pmd_index_marker: { node: 'pmd_index_marker', getAttrs: (tok) => ({ data: pmdData(tok) }) } },
  toMarkdown: { nodes: { pmd_index_marker: inlineWriter(() => 'index-marker') } },
  label: 'Index entry',
  icon: 'symbol-key',
  slash: { keywords: ['index entry', 'index term'] },
  commands: [
    insertInlineCommand(
      { id: 'index-marker.insert', label: 'Mark index entry', icon: 'symbol-key', toolbar: true, keywords: ['index entry', 'index term'] },
      'pmd_index_marker',
      (schema, text) => schema.nodes['pmd_index_marker']!.create({ data: { name: 'INDEX', parenParams: null, params: '', attrs: { term: text || 'term' } } }),
      { keepSelection: true },
    ),
  ],
};

/** Any other directive written inside text (kept as written). */
export const inlineDirective: SyntaxItem = {
  id: 'inline-directive',
  group: 'text',
  schema: {
    nodes: {
      pmd_directive_inline: inlineAtom(
        (node) => ['span', { class: 'pmd-directive pmd-directive-inline', contenteditable: 'false' }, ['span', { class: 'pmd-chip' }, `<!-- ::${dataOf(node).name} -->`]],
        { item: { default: UNKNOWN_DIRECTIVE } },
      ),
    },
  },
  fromTokens: { pmd_directive_inline: { node: 'pmd_directive_inline', getAttrs: (tok) => ({ data: pmdData(tok), item: pmdItemOf(tok) }) } },
  toMarkdown: { nodes: { pmd_directive_inline: inlineWriter((node) => node.attrs['item'] as string) } },
  label: 'Directive in text',
  icon: 'symbol-event',
};

/**
 * What a node means for Print Layout's pages (P6, amendment 6), in the shape `@pagemd-editor/pagination` expects
 * (its `PageMarker`; the two packages don't import each other, the app passes this function on). pagemd's HTML
 * contract: PAGEBREAK is `<div class="break-page">`; SECTION wraps in `<div class="{class}">`; COVER in
 * `<div class="cover">`; LAYOUT(name) opens `<div class="page-{name}">` (name "default" when none is given).
 */
export type PagemdPageMarker =
  | { kind: 'pagebreak' }
  | { kind: 'wrapper-start'; className: string }
  | { kind: 'wrapper-end' }
  | { kind: 'layout'; name: string };

export function pageMarkerOf(node: Node): PagemdPageMarker | null {
  switch (node.type.name) {
    case directiveType('pagebreak'):
      return { kind: 'pagebreak' };
    case directiveType('section'): {
      const data = dataOf(node);
      return isStart(data) ? { kind: 'wrapper-start', className: text(data.attrs['class']) } : { kind: 'wrapper-end' };
    }
    case directiveType('cover'):
      return isStart(dataOf(node)) ? { kind: 'wrapper-start', className: 'cover' } : { kind: 'wrapper-end' };
    case directiveType('layout'): {
      const data = dataOf(node);
      return { kind: 'layout', name: data.parenParams || text(data.attrs['name']) || 'default' };
    }
    default:
      return null;
  }
}

export const pageItems: readonly SyntaxItem[] = [pagebreak, toc, section, layout, cover, indexBlock, includeDirective, unknownDirective, commentAnchor, indexMarker, inlineDirective];
