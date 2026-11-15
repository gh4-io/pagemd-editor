// Which style the editor writes a NEW figure in (the `pagemdEditor.figureStyle` setting, R-254), and "Make figures readable".
// Reading never depends on it: every style is read for ever. Existing figures keep the form they were read in (ADR-0007).
//
//   readable (default)  ![alt](src "caption")  then, only when plain markdown can't hold it, <!-- ::FIGURE id="…" width="…" -->
//   native              <!-- ::FIGURE src="…" caption="…" … -->  (one line, nothing else)
//   legacy              <!-- ::FIGURE caption="…" … -->  then  ![alt](src)
import type { Node, Schema } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

type Data = Record<string, unknown>;

export type FigureStyle = 'readable' | 'native' | 'legacy';

let current: FigureStyle = 'readable';

/** Set from the setting (the app calls it when the editor opens and when the setting changes). Anything unknown is `readable`. */
export function setFigureStyle(style: unknown): void {
  current = style === 'native' || style === 'legacy' ? style : 'readable';
}

export const figureStyle = (): FigureStyle => current;

/** The data of a figure the editor makes now, in the chosen style (the writer in @pagemd/syntax does the rest). */
export function newFigureData(attrs: Data, style: FigureStyle = current): Data {
  const base = { attrs, raw: '', legacy: false, image: '' };
  return style === 'native' ? base : { ...base, form: style };
}

/** The file's name without its folder and extension: the alt text a pasted picture starts with. */
export function altFromSource(src: string): string {
  const name = src.split('/').pop() ?? src;
  return name.replace(/\.[A-Za-z0-9]+$/, '');
}

const LEGACY_IMAGE = /^!\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^<>\n]*>|[^\s()<>]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)\s*$/;

/** The readable data for a figure node in another style; null when it is already readable or can't be (an embed, no picture). */
function readableData(data: Data): Data | null {
  if (data['form'] === 'after' || data['form'] === 'readable') return null;
  const attrs = { ...((data['attrs'] as Data | undefined) ?? {}) };
  if (data['legacy'] === true && !attrs['src']) {
    const m = LEGACY_IMAGE.exec(String(data['image'] ?? '').trim());
    if (!m) return null;
    attrs['src'] = m[2]!.startsWith('<') ? m[2]!.slice(1, -1) : m[2]!;
    if (m[1] && !attrs['alt']) attrs['alt'] = m[1].replace(/\\(.)/g, '$1');
  }
  if (!attrs['src']) return null;
  // `raw` goes: the parameters are written afresh, in the canonical order (src, alt and caption move to the picture line).
  return { attrs, raw: '', legacy: false, image: '', form: 'readable' };
}

/**
 * "Make figures readable": every FIGURE in the document written in the readable style, as ONE transaction (one undo step).
 * Null when there is nothing to change. Annotated images and plain pictures are left as they are.
 */
export function makeFiguresReadable(state: EditorState): Transaction | null {
  const changes: { pos: number; node: Node; data: Data }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'pmd_figure') return true;
    const data = readableData((node.attrs['data'] as Data | undefined) ?? {});
    if (data) changes.push({ pos, node, data });
    return false;
  });
  if (changes.length === 0) return null;
  const tr = state.tr;
  for (const { pos, node, data } of changes) tr.setNodeMarkup(pos, undefined, { ...node.attrs, data });
  return tr;
}

/** A figure node in the chosen style for a picture at `src` (a pasted or dropped file). */
export function pastedFigureNode(schema: Schema, src: string): Node {
  const attrs: Data = { src };
  if (current !== 'native') attrs['alt'] = altFromSource(src);
  return schema.nodes['pmd_figure']!.create({ data: newFigureData(attrs) });
}
