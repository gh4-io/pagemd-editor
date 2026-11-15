// Editing a table on the canvas (P16): cell selection, mouse and arrow keys, paste of cells (prosemirror-tables'
// plugin props, WITHOUT its clean-up that adds cells to any table that isn't a rectangle: a ragged table's text must
// stay as the author wrote it, amendment 5, AD-P16-03); the tidy step (tidy.ts) in its place; and the table-only keys
// (amendment 8): Tab / Shift+Tab next / previous cell (Tab in the last cell adds a row), Enter the cell below. These are
// a ProseMirror plugin's key handler, not registry keybindings: a bound registry key is kept everywhere (R-158), and Tab
// everywhere would break indenting a list. Outside a table they do nothing. Added by the app, as P15's shapeEditingPlugin.
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { CellSelection, cellAround, goToNextCell, isInTable, nextCell, tableEditing } from 'prosemirror-tables';
import { addRowBelow, throughFill } from './commands.ts';
import { columnResizePlugin } from './resize.ts';
import { isPagemdTable } from './context.ts';
import { tidyTable } from './tidy.ts';

export const tableTidyKey = new PluginKey('pmd-table-tidy');

/** The positions (in the new document) of the pagemd tables the transactions touched. */
function touchedTables(transactions: readonly Transaction[], doc: EditorState['doc']): number[] {
  const ranges: [number, number][] = [];
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    tr.mapping.maps.forEach((map) => {
      for (let k = 0; k < ranges.length; k++) ranges[k] = [map.map(ranges[k]![0], -1), map.map(ranges[k]![1], 1)];
      map.forEach((_a, _b, from, to) => ranges.push([from, to]));
    });
  }
  const found = new Set<number>();
  for (const [from, to] of ranges) {
    const lo = Math.max(0, Math.min(from, doc.content.size));
    const hi = Math.max(lo, Math.min(to, doc.content.size));
    doc.nodesBetween(lo, hi, (node, pos) => {
      if (isPagemdTable(node)) found.add(pos);
      return true;
    });
  }
  return [...found].sort((a, b) => b - a);
}

/** The tidy step: puts every table a change touched in order (a ragged one evened out, AD-FIX-FT-04), in the same undo step. */
function tidyPlugin(): Plugin {
  return new Plugin({
    key: tableTidyKey,
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const tr = state.tr;
      // Last table first: positions before it don't move.
      for (const pos of touchedTables(transactions, state.doc)) tidyTable(tr, pos, true);
      return tr.docChanged ? tr : null;
    },
  });
}

const plain = (event: KeyboardEvent): boolean => !event.ctrlKey && !event.metaKey && !event.altKey;

/** Tab, Shift+Tab and Enter inside a table cell. */
function tableKeys(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (!plain(event) || !view.editable || !isInTable(view.state)) return false;
        const { state } = view;
        if (event.key === 'Tab') {
          const direction = event.shiftKey ? -1 : 1;
          if (goToNextCell(direction)(state, view.dispatch)) return true;
          // Tab in the last cell adds a row (Word's way); the cursor goes to its first cell. A ragged table is evened out first (AD-FIX-FT-05).
          if (direction === 1) throughFill((s, d) => addRowBelow(s, d, true))(state, view.dispatch);
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          const $cell = state.selection instanceof CellSelection ? state.selection.$headCell : cellAround(state.selection.$head);
          if (!$cell) return false;
          const below = nextCell($cell, 'vert', 1);
          // The last row: Enter stays (it never splits a cell, AD-P16-05).
          if (below) view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(below.pos + 1))).scrollIntoView());
          return true;
        }
        return false;
      },
    },
  });
}

/**
 * The table plugins the app adds, before the editor's own (so a table's Tab and Enter go first). The column-border drag
 * (P19) comes before prosemirror-tables' props, so pressing on a border starts a resize, not a cell selection.
 */
export function tableEditingPlugins(): Plugin[] {
  // prosemirror-tables' plugin as it is, minus its appendTransaction (fixTables).
  const library = tableEditing();
  const props = new Plugin({ ...library.spec, appendTransaction: undefined });
  // FIX-FT (AD-FIX-FT-06): no "not in standard form" bar any more: a table that only has short rows is evened out by its first edit.
  return [tableKeys(), columnResizePlugin(), props, tidyPlugin()];
}

/** `state`'s transaction putting the cursor at the start of the text inside the node at `pos` (a cell): the real-host test's way in. */
export function cursorInTransaction(state: EditorState, pos: number): Transaction {
  return state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1)));
}
