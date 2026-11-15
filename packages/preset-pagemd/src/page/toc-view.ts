// The TOC's live heading list on the canvas (cohesion matrix: "live heading list, page numbers '…' until
// Preview"). A small ProseMirror plugin, added through the shared pmPlugins mechanism (ADR-0013 amendment, P3),
// gives every TOC node the document's headings as a node decoration; the TOC's node view redraws its list when
// they change. Which headings: pagemd's own rules (R-148, see tocHeadings).
import { DOMSerializer, type Node } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type NodeViewConstructor } from 'prosemirror-view';
import type { EditorPlugin } from '@pagemd-editor/core';

/** What a directive token carries (itemOccurrences, C3). */
export interface DirectiveData {
  name: string;
  parenParams: string | null;
  params: string;
  attrs: Record<string, string | true>;
}

export interface TocHeading {
  level: number;
  text: string;
}

const TOC_NODE = 'pmd_toc';

/**
 * Settings from outside the directive (R-148): the document's `toc_levels` / `toc_min_level` (frontmatter, see
 * `tocFields`), and how far the frontmatter reaches (its blocks show on the canvas but aren't part of pagemd's HTML,
 * so they are never listed).
 */
export interface TocSettings {
  levels?: number;
  minLevel?: number;
  /** Document position where the body starts (after the frontmatter's blocks); headings before it aren't listed. */
  bodyFrom?: number;
}

/**
 * The headings a TOC lists, in document order, the way pagemd fills its placeholder (renderer-web `toc.js`
 * `fillTocPlaceholder`, R-148): deepest level = the directive's `levels` || `toc_levels` || 3; shallowest = the
 * directive's `min` || (`toc_min_level` ?? 2); `section` lists only the headings under the heading before the TOC,
 * down to the next heading at that heading's level or above (no shallowest level). Like pagemd's heading pattern
 * (`<hN …>text</hN>`), a heading with inline markup (emphasis, code, links, atoms) isn't listed.
 */
export function tocHeadings(doc: Node, data: DirectiveData, settings: TocSettings = {}, tocPos?: number): TocHeading[] {
  const max = Number(data.attrs['levels']) || settings.levels || 3;
  const min = Number(data.attrs['min']) || (settings.minLevel ?? 2);
  const section = data.attrs['section'] !== undefined;
  const from = settings.bodyFrom ?? 0;
  const all: Array<TocHeading & { pos: number; plain: boolean }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      let plain = true;
      node.forEach((child) => {
        if (!child.isText || child.marks.length > 0) plain = false;
      });
      if (pos >= from) all.push({ level: node.attrs['level'] as number, text: node.textContent.trim(), pos, plain });
      return false;
    }
    return true;
  });
  const out: TocHeading[] = [];
  if (section) {
    if (tocPos === undefined) return out;
    const before = all.filter((h) => h.pos < tocPos && h.plain).pop();
    if (!before) return out;
    for (const h of all) {
      if (h.pos < tocPos || !h.plain) continue;
      if (h.level <= before.level) break;
      if (h.level <= max && h.text) out.push({ level: h.level, text: h.text });
    }
    return out;
  }
  for (const h of all) if (h.plain && h.text && h.level >= min && h.level <= max) out.push({ level: h.level, text: h.text });
  return out;
}

const key = new PluginKey('pmd-toc');

/** Node decorations carrying each TOC's headings (a changed list changes the decoration, so the view redraws). */
export function tocDecorationsWith(settings: (doc: Node) => TocSettings): Plugin {
  return new Plugin({
    key,
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        const now = settings(state.doc);
        state.doc.descendants((node, pos) => {
          if (node.type.name === TOC_NODE) {
            decorations.push(Decoration.node(pos, pos + node.nodeSize, {}, { pmdToc: tocHeadings(state.doc, node.attrs['data'] as DirectiveData, now, pos) }));
          }
          return node.isBlock && !node.isAtom;
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

/** The TOC decorations with only the directive's own settings (no frontmatter). */
export const tocDecorations = tocDecorationsWith(() => ({}));

/** Adds the TOC decorations to the canvas, with `settings` from the document (frontmatter, R-148). */
export function tocPluginWith(settings: (doc: Node) => TocSettings): EditorPlugin<void> {
  const plugin = tocDecorationsWith(settings);
  return {
    id: '@pagemd-editor/preset-pagemd:toc',
    autoStart: true,
    activate: (app) => {
      if (app.schema.nodes[TOC_NODE]) app.pmPlugins.push(plugin);
    },
  };
}

/** Adds the TOC decorations to the canvas (register it with the editor's plugins, like plugin-input-rules). */
export const tocPlugin: EditorPlugin<void> = {
  id: '@pagemd-editor/preset-pagemd:toc',
  autoStart: true,
  activate: (app) => {
    if (app.schema.nodes[TOC_NODE]) app.pmPlugins.push(tocDecorations);
  },
};

const headingsOf = (decorations: readonly Decoration[]): TocHeading[] =>
  ((decorations.find((d) => (d.spec as { pmdToc?: TocHeading[] }).pmdToc)?.spec as { pmdToc?: TocHeading[] } | undefined)?.pmdToc) ?? [];

/** The TOC node as its toDOM draws it, with the list filled in from the decorations. */
export const tocNodeView: NodeViewConstructor = (node, _view, _getPos, decorations) => {
  const { dom } = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node));
  const element = dom as HTMLElement;
  const list = element.querySelector('.pmd-toc-list');
  let shown = '';
  const draw = (headings: TocHeading[]): void => {
    const next = JSON.stringify(headings);
    if (!list || next === shown) return;
    shown = next;
    list.replaceChildren(
      ...headings.map((h) => {
        const li = document.createElement('li');
        li.className = `pmd-toc-level-${h.level}`;
        li.textContent = `${h.text} …`;
        return li;
      }),
    );
  };
  draw(headingsOf(decorations));
  let current = node;
  return {
    dom: element,
    update(next, nextDecorations) {
      if (next.type !== current.type || JSON.stringify(next.attrs) !== JSON.stringify(current.attrs)) return false;
      current = next;
      draw(headingsOf(nextDecorations));
      return true;
    },
    // Its list is drawn here, so ProseMirror mustn't read changes to it; selection changes it still sees (ProseMirror's own default for a view without editable content).
    ignoreMutation: (mutation) => mutation.type !== 'selection',
  };
};
