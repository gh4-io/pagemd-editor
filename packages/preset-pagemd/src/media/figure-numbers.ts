// Figure numbers for the outline (P9, D9, R-164): FIGUREs and annotated images share one counter, and only captioned ones
// get a number (C9's one numbering). The editor never counts them itself (I1): each figure on the canvas is written with
// @pagemd/syntax's own write rule, the figures are read back by @pagemd/syntax's reader, and the numbers are the ones its
// numbering rule (`pagemd_figure_numbers`) puts on the tokens.
import type { Node } from 'prosemirror-model';
import type { MarkdownIt } from 'markdown-it';
import { createDialect } from '@pagemd/syntax';
import type { OutlineEntry, Registry } from '@pagemd-editor/core';
import { writeItem } from '../shared/write.ts';

/** The figure nodes, by node name, with the @pagemd/syntax item that writes each. */
const FIGURE_ITEMS: Readonly<Record<string, string>> = { pmd_figure: 'figure', pmd_annotated_image: 'annotated-image' };

/** The figure tokens the numbering rule numbers (one per figure node). */
const FIGURE_TOKENS = new Set(['figure_open', 'annotated_image']);

let reader: MarkdownIt | undefined;
const read = (): MarkdownIt => (reader ??= createDialect({ mode: 'editor' }));

/** The last answer, by the figures' written text: typing elsewhere doesn't read the figures again. */
let last: { key: string; numbers: (number | undefined)[] } = { key: '', numbers: [] };

/**
 * The number each figure in `doc` gets, by the figure node's position; figures without a number (no caption) are not in
 * the map. Empty when the figures can't be written or read back one token each (then nothing is numbered rather than
 * something numbered wrongly).
 */
export function figureNumbers(doc: Node): Map<number, number> {
  const figures: { pos: number; text: string }[] = [];
  let writable = true;
  doc.descendants((node, pos) => {
    const item = FIGURE_ITEMS[node.type.name];
    if (!item) return true;
    try {
      figures.push({ pos, text: writeItem(item, node.attrs['data'] as Record<string, unknown>) });
    } catch {
      writable = false;
    }
    return false;
  });
  const out = new Map<number, number>();
  if (!writable || figures.length === 0) return out;
  const key = figures.map((f) => f.text).join('\n\n');
  if (key !== last.key) {
    const tokens = read().parse(`${key}\n`, {}).filter((t) => FIGURE_TOKENS.has(t.type));
    const numbers = tokens.map((t) => (t.meta as { figureNumber?: unknown } | null)?.figureNumber);
    last = { key, numbers: tokens.length === figures.length ? numbers.map((n) => (typeof n === 'number' ? n : undefined)) : [] };
  }
  figures.forEach((figure, i) => {
    const n = last.numbers[i];
    if (n !== undefined) out.set(figure.pos, n);
  });
  return out;
}

/**
 * The registry's outline with each numbered figure's `number` filled in (D9). The one outline the Outline panel and
 * the native Outline (the host's symbol provider) both show.
 */
export function numberedOutline(registry: Pick<Registry, 'outline'>, doc: Node): OutlineEntry[] {
  const entries = registry.outline(doc);
  if (!entries.some((e) => e.kind === 'figure')) return entries;
  const numbers = figureNumbers(doc);
  return entries.map((e) => {
    const number = e.kind === 'figure' ? numbers.get(e.pos) : undefined;
    return number === undefined ? e : { ...e, number };
  });
}

/** The words an outline entry shows: a numbered figure as pagemd prints it ("Figure 3: Caption", D9), else its label. */
export function outlineLabel(entry: OutlineEntry): string {
  if (entry.kind === 'figure' && entry.number !== undefined) return `Figure ${entry.number}: ${entry.label}`;
  return entry.label || entry.kind;
}
