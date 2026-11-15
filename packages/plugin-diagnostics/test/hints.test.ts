// plugin-diagnostics' webview entry (P14): the results become hints on the blocks they are about, only while the canvas
// shows the text that was checked; the hints follow edits, take no room and are no undo step.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Diagnostic } from '@pagemd-editor/core';
import { transformerFor } from '../../preset-pagemd/test/corpus-files.ts';
import { diagnosticsPlugin, hintsFor, hintsKey, hintsOf } from '../src/index.ts';

const TEXT = '---\ntitle: T\n---\n# Heading\n\nFirst paragraph.\n\n<!-- ::BREAK -->\n\nLast paragraph.\n';
const at = (line: number, severity: Diagnostic['severity'], message: string): Diagnostic => {
  const starts = [0, ...[...TEXT].flatMap((ch, i) => (ch === '\n' ? [i + 1] : []))];
  return { from: starts[line]!, to: starts[line + 1]! - 1, severity, message, source: 'pagemd' };
};

function setup() {
  const doc = transformerFor(TEXT).parse(TEXT);
  const state = EditorState.create({ doc, plugins: [diagnosticsPlugin()] });
  return { doc, state };
}

describe('hintsFor', () => {
  it('marks the block holding each problem, with its worst severity and every message', () => {
    const { doc } = setup();
    // blocks: 0 frontmatter, 1 heading, 2 paragraph, 3 BREAK, 4 paragraph
    const hints = hintsFor(doc, TEXT, [at(7, 'warning', 'Unknown directive'), at(5, 'info', 'a note'), at(5, 'error', 'an error')]);
    expect(hints).toEqual([
      { block: 2, severity: 'error', messages: ['a note', 'an error'] },
      { block: 3, severity: 'warning', messages: ['Unknown directive'] },
    ]);
  });

  it('a problem at the very start (a missing property, the profile, the template) gets no hint', () => {
    const { doc } = setup();
    expect(hintsFor(doc, TEXT, [{ from: 0, to: 0, severity: 'error', message: 'Missing required field', source: 'pagemd' }])).toEqual([]);
  });

  it('null when the canvas does not show the checked text', () => {
    const { doc } = setup();
    expect(hintsFor(doc, `${TEXT}more\n`, [at(7, 'warning', 'x')])).toBe(null);
  });
});

describe('the hints plugin', () => {
  it('decorates the blocks (no content change), follows edits, and an empty list clears them', () => {
    const { doc, state } = setup();
    const hints = hintsFor(doc, TEXT, [at(9, 'warning', 'last')])!;
    let next = state.apply(state.tr.setMeta(hintsKey, { hints }).setMeta('addToHistory', false));
    expect(next.doc).toBe(state.doc);
    expect(hintsOf(next)).toEqual([{ block: 4, severity: 'warning', messages: ['last'] }]);
    // a paragraph typed at the start: the hint stays on the same paragraph, now block 5
    const tr = next.tr.insert(0, next.schema.nodes['paragraph']!.create(null, next.schema.text('new')));
    next = next.apply(tr);
    expect(hintsOf(next)).toEqual([{ block: 5, severity: 'warning', messages: ['last'] }]);
    next = next.apply(next.tr.setMeta(hintsKey, { hints: [] }));
    expect(hintsOf(next)).toEqual([]);
  });

  it('draws a class per severity and the messages as the tooltip', () => {
    const { doc, state } = setup();
    const hints = hintsFor(doc, TEXT, [at(5, 'info', 'one'), at(5, 'info', 'two')])!;
    const next = state.apply(state.tr.setMeta(hintsKey, { hints }));
    const set = hintsKey.getState(next)!.decorations;
    const [decoration] = set.find();
    expect((decoration as unknown as { type: { attrs: Record<string, string> } }).type.attrs).toEqual({ class: 'pmd-hint pmd-hint-info', title: 'one\ntwo' });
  });
});
