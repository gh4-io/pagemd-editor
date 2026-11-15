// Fancy lists: `a.` `A.` `i.` `I.` markers (markdown-it-fancy-lists, read by @pagemd/syntax's `fancy-lists` item,
// only when the document has `fancy_lists: true`: the gate, ADR-0016). A fancy list is still CommonMark's
// ordered list, so this item extends that node (ADR-0013 amendment, P4) with the marker the author used; the
// markers are written by @pagemd/syntax's listMarker() and markerGap().
import type { Node } from 'prosemirror-model';
import { listMarker, markerGap } from '@pagemd/syntax';
import { listCommand, type NodeWriter, type SyntaxItem } from '@pagemd-editor/core';
import { syntaxItem } from '../shared/write.ts';
import { withAttributes } from '../shared/dom.ts';

export const FANCY = 'pmdFancy';

interface FancyData {
  type: string;
  start: number;
  delimiter: string;
}

/** Markdown allows up to 4 spaces between a marker and the text; more would start indented code. */
const MAX_GAP = 4;

/** Every item's marker padded to one width (as CommonMark's ordered list does), keeping each marker's gap. */
const writeFancyList = (original: NodeWriter): NodeWriter => (state, node, parent, index) => {
  const fancy = node.attrs[FANCY] as FancyData | null;
  if (!fancy) {
    original(state, node, parent, index);
    return;
  }
  // The list's own start (CommonMark's `order`, the same number when read; the Inspector's start field changes it, P8).
  const data = typeof node.attrs['order'] === 'number' ? { ...fancy, start: node.attrs['order'] } : fancy;
  const markers = listMarkers(node, data);
  const width = Math.max(...markers.map((m) => m.length + markerGap(m).length));
  state.renderList(node, ' '.repeat(width), (i) => {
    const marker = markers[i]!;
    const gap = Math.min(MAX_GAP, Math.max(markerGap(marker).length, width - marker.length));
    return marker + ' '.repeat(gap);
  });
};

function listMarkers(node: Node, data: FancyData): string[] {
  const markers: string[] = [];
  for (let i = 0; i < node.childCount; i++) markers.push(listMarker(data, i));
  return markers;
}

/** The renderer's `type` and class for each marker kind (@pagemd/syntax's htmlContract), for the canvas (I3). */
const LIST_CLASS: Record<string, string> = { a: 'list-lower-alpha', A: 'list-upper-alpha', i: 'list-lower-roman', I: 'list-upper-roman' };

export function fancyListDom(attrs: Record<string, unknown>): Record<string, string> {
  const data = attrs[FANCY] as FancyData | null;
  if (!data) return {};
  return { type: data.type, class: LIST_CLASS[data.type] ?? '' };
}

/**
 * A line of paragraph text that starts like a lettered or Roman list item (`a. `, `iv) `) would be read as a new
 * list in a document with fancy lists on. The paragraph's writer (CommonMark's) escapes number markers only;
 * this escapes the delimiter of these too (`a\\. `), which reads back as the same text in any document.
 */
const FANCY_LINE = /(^|\n)([ \t>]*)([a-zA-Z]|[ivxlcdmIVXLCDM]+)([.)])(?=[ \t]|$)/g;

export const escapeFancyMarkers = (text: string): string => text.replace(FANCY_LINE, '$1$2$3\\$4');

const writeParagraph = (original: NodeWriter): NodeWriter => (state, node, parent, index) => {
  const s = state as unknown as { out: string };
  const start = s.out.length;
  original(state, node, parent, index);
  s.out = s.out.slice(0, start) + escapeFancyMarkers(s.out.slice(start));
};

const fancyDef = syntaxItem('fancy-lists');

export const fancyLists: SyntaxItem = {
  id: 'fancy-lists',
  group: 'lists',
  ...(fancyDef.gate ? { gate: { ...fancyDef.gate } } : {}),
  schema: {},
  fromTokens: {},
  toMarkdown: {},
  extend: {
    nodes: {
      ordered_list: {
        attrs: { [FANCY]: { default: null } },
        fromToken: (tok) => {
          const pmd = (tok.meta as { pmd?: { item: string; data: FancyData } } | null)?.pmd;
          return { [FANCY]: pmd?.item === 'fancy-lists' ? { ...pmd.data } : null };
        },
        write: writeFancyList,
      },
      paragraph: { attrs: {}, write: writeParagraph },
    },
  },
  nodeViews: { ordered_list: withAttributes((node) => fancyListDom(node.attrs)) },
  label: 'Lettered or Roman list',
  icon: 'list-ordered',
  slash: { keywords: ['list', 'letter', 'alpha', 'roman', 'fancy'] },
  commands: [
    ...(
      [
        ['a', 'Lettered list (a. b. c.)', ['letter', 'alpha', 'lowercase']],
        ['A', 'Lettered list (A. B. C.)', ['letter', 'alpha', 'uppercase']],
        ['i', 'Roman list (i. ii. iii.)', ['roman', 'lowercase']],
        ['I', 'Roman list (I. II. III.)', ['roman', 'uppercase']],
      ] as const
    ).map(([type, label, words]) =>
      listCommand(
        { id: `fancy-lists.${type === type.toLowerCase() ? 'lower' : 'upper'}-${type.toLowerCase() === 'a' ? 'alpha' : 'roman'}`, label, icon: 'list-ordered', keywords: ['list', 'fancy', ...words] },
        'ordered_list',
        { order: 1, delim: '.', [FANCY]: { type, start: 1, delimiter: '.' } },
        (node) => (node.attrs[FANCY] as FancyData | null)?.type === type,
      ),
    ),
  ],
};
