// The ribbon's tabs that follow the cursor (P19 round 3, P20; ADR-0013 amendment): the rules the app gives the ribbon.
// In order, first match wins (AD-P20-02): a picture selected as an object brings the Image tab (also in a table cell), the
// cursor in a table the Table tab. The Image tab is in the strip only while a picture is selected, and never while the
// canvas is read-only (Read and Print Preview also leave it out of their tab lists, views.ts).
import type { EditorState } from 'prosemirror-state';
import { pictureSelected, tableAt } from '@pagemd-editor/preset-pagemd';
import type { RibbonOptions } from '@pagemd-editor/ribbon';

export function cursorTabs(editable: () => boolean): Required<Pick<RibbonOptions, 'autoTab' | 'contextTabs'>> {
  const image = (state: EditorState): boolean => editable() && pictureSelected(state);
  const rules: readonly (readonly [string, (state: EditorState) => boolean])[] = [
    ['image', image],
    ['table', (state) => tableAt(state) !== null],
  ];
  return {
    autoTab: (state) => rules.find(([, applies]) => applies(state))?.[0] ?? null,
    contextTabs: { image },
  };
}
