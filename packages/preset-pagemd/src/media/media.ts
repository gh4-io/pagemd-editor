// Media items. FIGURE and annotated images are atoms edited through their data (the Inspector, P8; the image
// editor, P15) and drawn on the canvas by @pagemd/syntax's own renderer (D1, D2, I3), so they look exactly as in
// the output. Figure numbers are live: one CSS counter over every captioned FIGURE and annotated image, in
// document order (C9's one numbering), instead of the number the renderer printed for this one block alone.
import type { Node, NodeSpec, Schema } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { MarkdownIt, Token } from 'markdown-it';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import { createDialect, readRedactions } from '@pagemd/syntax';
import { insertInlineCommand, insertBlockCommand, insertBlocksTransaction, type SyntaxItem } from '@pagemd-editor/core';
import { atomWriter, inlineWriter, writeItem } from '../shared/write.ts';
import { withAttributes, classes } from '../shared/dom.ts';
import { attributeDom } from '../text/attributes.ts';
import { diagramView, type DiagramDrawer } from './diagram-view.ts';
import { annotatedImageView, type AnnotatedValue } from './image-tools/annotation-view.ts';
import { pictureEnv } from './picture-sizes.ts';
import { pictureSizeCommands, shapeCommands } from './image-tools/target.ts';
import { SHAPE_LISTS } from './image-tools/geometry.ts';
import { figureStyle, makeFiguresReadable, newFigureData, pastedFigureNode } from './figure-style.ts';

const dataOf = (node: Node): Record<string, unknown> => node.attrs['data'] as Record<string, unknown>;
const pmdData = (tok: { meta: unknown }): Record<string, unknown> => ({ ...((tok.meta as { pmd?: { data: Record<string, unknown> } } | null)?.pmd?.data ?? {}) });
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** pagemd's renderer (render mode: the CLI's exact HTML), made once, on first use. */
let renderer: MarkdownIt | undefined;
const render = (): MarkdownIt => (renderer ??= createDialect({ mode: 'render' }));
/**
 * pagemd's renderer in editor mode, for the annotated image (P27, C13 handoff): the same HTML, except that redactions are drawn
 * as opaque black boxes over the picture (`<rect class="annotation-redact">`, under every shape), where render mode would draw
 * the grey "Redacted picture not prepared" box (it fails closed without pagemd's baked copy). The canvas never shows the
 * picture uncovered: the boxes are part of the same drawing.
 */
let editorRenderer: MarkdownIt | undefined;
const renderEditor = (): MarkdownIt => (editorRenderer ??= createDialect({ mode: 'editor' }));

function mediaAtom(dom: (node: Node) => [string, Record<string, string>]): NodeSpec {
  return { group: 'block', atom: true, selectable: true, draggable: true, attrs: { data: {} }, toDOM: dom };
}

/**
 * A node view showing HTML from pagemd's renderer. The number the renderer put in "Figure N" is left to the
 * canvas's counter (the figure's place in the whole document isn't known when one block is drawn).
 */
function rendered(className: string, html: (node: Node, env: Record<string, unknown>) => string): NodeViewConstructor {
  return (node) => {
    const dom = document.createElement('div');
    dom.className = className;
    dom.contentEditable = 'false';
    // P27: a picture turned a quarter needs its size (pictureEnv); once the browser has it, the figure is drawn again.
    const env = pictureEnv(dom.ownerDocument, () => draw(current));
    const draw = (n: Node): void => {
      dom.innerHTML = html(n, env);
      for (const num of dom.querySelectorAll('.fig-num')) num.textContent = '';
    };
    let current = node;
    draw(node);
    const view: NodeView = {
      dom,
      update(next) {
        if (next.type !== current.type) return false;
        if (JSON.stringify(next.attrs) !== JSON.stringify(current.attrs)) draw(next);
        current = next;
        return true;
      },
      // Its HTML is drawn here, so ProseMirror mustn't read changes to it; selection changes it still sees (ProseMirror's own default for a view without editable content).
      ignoreMutation: (mutation) => mutation.type !== 'selection',
    };
    return view;
  };
}

/** `<!-- ::FIGURE src="…" caption="…" -->` (the legacy two-line form too). */
export const figure: SyntaxItem = {
  id: 'figure',
  group: 'media',
  schema: {
    nodes: {
      pmd_figure: mediaAtom((node) => {
        const attrs = (dataOf(node)['attrs'] as Record<string, unknown> | undefined) ?? {};
        return ['figure', { class: classes('pmd-figure', str(attrs['width']) && `width-${str(attrs['width'])}`), 'data-src': str(attrs['src']) }];
      }),
    },
  },
  fromTokens: { pmd_figure: { node: 'pmd_figure', getAttrs: (tok) => ({ data: pmdData(tok) }) } },
  toMarkdown: { nodes: { pmd_figure: atomWriter(() => 'figure') } },
  // The directive as written, rendered by pagemd (crop, width, caption: exactly the output's HTML).
  nodeViews: { pmd_figure: rendered('pmd-media pmd-figure', (node, env) => render().render(writeItem('figure', dataOf(node)), env)) },
  label: 'Figure',
  icon: 'file-media',
  slash: { keywords: ['figure', 'image', 'picture', 'screenshot'] },
  outline: (node, pos) => {
    const caption = str(((dataOf(node)['attrs'] as Record<string, unknown> | undefined) ?? {})['caption']);
    return { kind: 'figure', label: caption || str(((dataOf(node)['attrs'] as Record<string, unknown> | undefined) ?? {})['src']) || 'Figure', level: 0, pos };
  },
  commands: [
    insertBlockCommand({ id: 'figure.insert', label: 'Figure', icon: 'file-media', keywords: ['figure', 'image', 'picture', 'screenshot'] }, 'pmd_figure', (schema) =>
      schema.nodes['pmd_figure']!.create({ data: newFigureData({ src: 'image.png', caption: 'Caption', ...(figureStyle() === 'native' ? {} : { alt: 'image' }) }) }),
    ),
    // R-255: every figure of the document in the readable style, one undo step.
    {
      id: 'figure.make-readable',
      label: 'Make figures readable',
      icon: 'file-media',
      slash: true,
      keywords: ['readable', 'figure', 'picture', 'markdown'],
      isEnabled: (state) => makeFiguresReadable(state) !== null,
      run: (state, dispatch) => {
        const tr = makeFiguresReadable(state);
        if (!tr) return false;
        dispatch?.(tr);
        return true;
      },
    },
    // P20: Image tab > Size (pagemd's own width, a FIGURE or an annotated image) and Caption > Remove caption.
    ...pictureSizeCommands,
  ],
};

/** A figure for the image at `src` (document-relative), with no caption yet: a figure without one is just the picture (P11). */
function figureNode(schema: Schema, src: string): Node {
  return pastedFigureNode(schema, src); // in the style the figureStyle setting names (R-254)
}

/**
 * One transaction that puts a figure for each of `sources` (document-relative image paths) below the selection, with the
 * first one selected so the Inspector shows its caption (P11, R-174). The whole insert is one edit, so one undo takes every
 * figure back. Null when no figure fits there (read-only places, inside a table cell).
 */
export function insertFigures(state: EditorState, sources: readonly string[]): Transaction | null {
  return insertBlocksTransaction(state, 'pmd_figure', sources.map((src) => figureNode(state.schema, src)), { selectFirst: true });
}

interface AnnotatedData {
  imagePath: string;
  content: string;
  data: { options?: { caption?: string } } | undefined;
}

/**
 * The annotated image drawn by the renderer rule @pagemd/syntax registers (D1), from the data read when the
 * document was opened: the YAML is not read a second time (I1, C2 A1).
 */
export function annotatedHtmlFor(node: Node, env: Record<string, unknown> = {}): string {
  return annotatedHtml(dataOf(node) as unknown as AnnotatedValue, node.attrs['yamlError'], env);
}

/**
 * The same from the data itself (P15: a shape being dragged is drawn from data not yet in the document). Editor mode (P27): a
 * redaction is an opaque box over the picture; `env` gives the picture's size for a quarter turn (C13).
 */
export function annotatedHtml(value: AnnotatedValue, yamlError: unknown, env: Record<string, unknown> = {}): string {
  const md = renderEditor();
  if (yamlError) return `<div class="pmd-yaml-error">Annotated image: the YAML could not be read (${escapeHtml(String(yamlError))})</div>`;
  // markdown-it's Token class, as its own rules reach it: through a core state.
  const State = (md.core as unknown as { State: new (src: string, md: MarkdownIt, env: object) => { Token: new (type: string, tag: string, nesting: number) => Token } }).State;
  const token = new (new State('', md, {}).Token)('annotated_image', '', 0);
  token.content = value.content ?? '';
  // The reader always gives options and all seven lists (C2); data made in the editor (a new or converted block) may not.
  const data = { options: {}, ...Object.fromEntries(SHAPE_LISTS.filter((list) => list !== 'redact').map((list) => [list, []])), ...(value.data ?? {}) } as NonNullable<AnnotatedData['data']>;
  // A caption only shows with a number; the canvas's counter replaces it.
  token.meta = { imagePath: value.imagePath, data, figureNumber: data.options?.caption ? 1 : null };
  const rule = md.renderer.rules['annotated_image'];
  return rule ? rule([token], 0, md.options, env, md.renderer) : '';
}

/**
 * The pictures of `doc` that carry redactions (R-251, P27 amendment 6), by path: an annotated image whose `redact:` has
 * rectangles, or is not a list of rectangles, or whose YAML can't be read but mentions `redact` (fail closed: such a picture must
 * not reach an output that does not bake it). The editor's own HTML fallback refuses a document with any.
 */
export function redactedPictures(doc: Node): string[] {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'pmd_annotated_image') return true;
    const value = dataOf(node) as unknown as AnnotatedValue;
    const redacted = node.attrs['yamlError'] ? /(^|\n)\s*redact\s*:/.test(value.content ?? '') : (() => {
      const read = readRedactions((value.data as Record<string, unknown> | undefined)?.['redact']);
      return read.rects.length > 0 || read.error !== null;
    })();
    if (redacted) found.push(value.imagePath);
    return false;
  });
  return found;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * `::: annotated-image path` … YAML … `:::`, with markers, arrows, boxes, text, lines, ellipses, highlights. Its shapes
 * are edited on the canvas (P15: annotation-view.ts) and in the Inspector (P8).
 */
export const annotatedImage: SyntaxItem = {
  id: 'annotated-image',
  group: 'media',
  schema: {
    nodes: {
      pmd_annotated_image: {
        ...mediaAtom((node) => ['figure', { class: 'annotated-image-container', 'data-src': str((dataOf(node) as unknown as AnnotatedData).imagePath) }]),
        attrs: { data: {}, yamlError: { default: null } },
      },
    },
  },
  fromTokens: {
    annotated_image: {
      node: 'pmd_annotated_image',
      getAttrs: (tok) => ({ data: pmdData(tok), yamlError: (tok.meta as { yamlError?: string } | null)?.yamlError ?? null }),
    },
  },
  toMarkdown: { nodes: { pmd_annotated_image: atomWriter(() => 'annotated-image') } },
  nodeViews: { pmd_annotated_image: annotatedImageView(annotatedHtml) },
  label: 'Annotated image',
  icon: 'pinned',
  slash: { keywords: ['annotated image', 'screenshot', 'markers', 'callouts'] },
  outline: (node, pos) => {
    const caption = (dataOf(node) as unknown as AnnotatedData).data?.options?.caption;
    return caption ? { kind: 'figure', label: caption, level: 0, pos } : null;
  },
  commands: [
    insertBlockCommand({ id: 'annotated-image.insert', label: 'Annotated image', icon: 'pinned', keywords: ['annotated image', 'screenshot', 'markers', 'callouts'] }, 'pmd_annotated_image', (schema) =>
      schema.nodes['pmd_annotated_image']!.create({
        data: { imagePath: 'image.png', content: 'markers:\n  - { id: 1, x: 50, y: 50, label: "Marker" }', data: { options: {}, markers: [{ id: 1, x: 50, y: 50, label: 'Marker' }] } },
      }),
    ),
    // P15 (D4, D5, D7): the Image tab's Shapes (P20; Insert ▸ Shapes before). Crop, rotate, flip, redact and Convert are the app's (they read and write files).
    ...shapeCommands,
  ],
};

/** `![[image.png|alt]]` */
export const embeds: SyntaxItem = {
  id: 'embeds',
  group: 'media',
  schema: {
    nodes: {
      pmd_embed: {
        inline: true,
        group: 'inline',
        atom: true,
        draggable: true,
        attrs: { data: {} },
        toDOM: (node) => {
          const data = dataOf(node);
          const path = str(data['path']);
          return ['img', { src: path, alt: str(data['alt']) || path, class: 'embedded-image' }];
        },
      },
    },
  },
  fromTokens: { pmd_embed: { node: 'pmd_embed', getAttrs: (tok) => ({ data: pmdData(tok) }) } },
  toMarkdown: { nodes: { pmd_embed: inlineWriter(() => 'embeds') } },
  label: 'Embedded image',
  icon: 'file-media',
  slash: { keywords: ['embed', 'image'] },
  commands: [
    insertInlineCommand({ id: 'embeds.insert', label: 'Embedded image', icon: 'file-media', keywords: ['embed', 'image'] }, 'pmd_embed', (schema, text) =>
      schema.nodes['pmd_embed']!.create({ data: { path: 'image.png', alt: text } }),
    ),
  ],
};

/** A ```mermaid fence: CommonMark's code block whose language is `mermaid` (P10: drawn on the canvas by plugin-diagrams). */
export function isDiagram(node: { type: { name: string }; attrs: Record<string, unknown> }): boolean {
  return node.type.name === 'code_block' && (str(node.attrs['params']).trim().split(/\s+/)[0] ?? '') === 'mermaid';
}

/** A ```mermaid fence stays CommonMark's code block; the canvas labels it "Diagram" and (P10) draws it in the paged and web views. */
export function codeBlockDom(attrs: Record<string, unknown>): Record<string, string> {
  const dom = attributeDom(attrs);
  const language = str(attrs['params']).trim().split(/\s+/)[0] ?? '';
  if (language) dom['data-language'] = language;
  if (language === 'mermaid') dom['class'] = classes(dom['class'], 'pmd-diagram');
  return dom;
}

export const mermaid: SyntaxItem = {
  id: 'mermaid',
  group: 'media',
  schema: {},
  fromTokens: {},
  toMarkdown: {},
  nodeViews: { code_block: withAttributes((node) => codeBlockDom(node.attrs)) },
  label: 'Diagram',
  icon: 'type-hierarchy',
  slash: { keywords: ['diagram', 'mermaid', 'chart', 'flowchart'] },
  commands: [
    insertBlockCommand({ id: 'mermaid.insert', label: 'Diagram', icon: 'type-hierarchy', keywords: ['diagram', 'mermaid', 'chart', 'flowchart'] }, 'code_block', (schema) =>
      schema.nodes['code_block']!.create({ params: 'mermaid', fence: '```' }, schema.text('graph TD\n  A[Start] --> B[End]')),
    ),
  ],
};

export const mediaItems: readonly SyntaxItem[] = [figure, annotatedImage, embeds, mermaid];

/** The media items with diagrams drawn by `drawer` (P10); without one, the code block only (the host, tests). */
export function mediaItemsWith(drawer?: DiagramDrawer): readonly SyntaxItem[] {
  if (!drawer) return mediaItems;
  const drawn: SyntaxItem = { ...mermaid, nodeViews: { code_block: diagramView(isDiagram, (node) => codeBlockDom(node.attrs), drawer) } };
  return [figure, annotatedImage, embeds, drawn];
}
