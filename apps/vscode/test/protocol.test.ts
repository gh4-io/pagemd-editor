// Protocol v2 (P5, amendment 3; v3 in P6 adds commands only; v4 in P7 adds settings and the gated-insert messages; v5 in P8
// adds the properties hints and drops addFrontmatterField; v6 in P9 adds the Code and Split commands and two test-only requests): the message contract's style types stay the same shape as style-pagemd's, so
// the host can send style-pagemd's answer as it is (shared/ may import core only, so it keeps its own copy).
// Checked by the type checker (npm run check); the test below only makes the file part of the test run.
import { describe, expect, it } from 'vitest';
import type { StyleNote as PagemdNote, StyleNoteKind as PagemdNoteKind, StyleResolution } from '@pagemd-editor/style-pagemd';
import { PROTOCOL_VERSION, type StyleNote, type StyleNoteKind, type StylesPayload } from '../shared/protocol.ts';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameKinds: Same<StyleNoteKind, PagemdNoteKind> = true;
const sameNotes: Same<StyleNote, PagemdNote> = true;
const samePayload: Same<StylesPayload, Pick<StyleResolution, 'styles' | 'gateDefaults' | 'notes' | 'properties'>> = true;

describe('protocol v10', () => {
  it('is version 10 (P15: readAsset), and its style types match style-pagemd (checked by the type checker)', () => {
    expect(PROTOCOL_VERSION).toBe(16); // v13 FIX-PGF: the `log` event; v14 readable figures: `SettingsPayload.figureStyle`; v15 native split: `nativeSplit`, `viewMode`, `splitCursor`, `nativeCursor`
    expect([sameKinds, sameNotes, samePayload]).toEqual([true, true, true]);
  });
});
