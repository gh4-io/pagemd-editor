// @pagemd-editor/plugin-clipboard: copy/paste as markdown (layered-architecture.md §3, P3).
// Copying a selection puts real markdown text on the system clipboard (not just the rendered text); pasting
// plain text parses it as markdown instead of dropping it in as one literal paragraph. Contributed to the
// canvas via the shared pmPlugins mechanism, as a ProseMirror plugin's clipboard props (ProseMirror merges
// these the same way for a direct EditorView prop or a plugin's).
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { Plugin, type Selection } from 'prosemirror-state';
import type { EditorPlugin } from '@pagemd-editor/core';
import { createTransformer, type Transformer } from '@pagemd-editor/transformer';

/**
 * A cell selection copies rows (or cells), which no writer can write alone ("A table row or cell is written by its
 * table", P16 amendment 9): they are wrapped in a copy of the table the selection is in, so the text is a markdown
 * table of just those cells. Nothing here knows table syntax: the roles are prosemirror-tables' `tableRole`.
 */
function wrapInTable(content: Fragment, selection: Selection | undefined): Fragment {
  const first = content.firstChild;
  const role = first?.type.spec.tableRole as string | undefined;
  if (role !== 'row' && role !== 'cell' && role !== 'header_cell') return content;
  const $cell = (selection as { $anchorCell?: { node(depth: number): Node } }).$anchorCell;
  const table = $cell?.node(-1);
  if (!table || table.type.spec.tableRole !== 'table') return content;
  // The table's item may say how its copy is made (a pagemd table keeps only the copied columns' settings).
  const wrap = table.type.spec['clipboardRows'] as ((table: Node, rows: Fragment, selection: Selection) => Node) | undefined;
  if (role === 'row') return Fragment.from(wrap && selection ? wrap(table, content, selection) : table.copy(content));
  return Fragment.from(table.copy(Fragment.from(table.firstChild!.copy(content))));
}

/** The slice's content wrapped in a throwaway doc, or `null` if that content can't stand alone as a document
 *  (an unusual partial slice, e.g. a slice that starts inside a table cell) — falls back to plain text. */
function docFrom(transformer: Transformer, content: Fragment): Node | null {
  try {
    return transformer.schema.topNodeType.create(null, content);
  } catch {
    return null;
  }
}

export function clipboardPlugin(): EditorPlugin<void> {
  return {
    id: '@pagemd-editor/plugin-clipboard:main',
    autoStart: true,
    activate: (app) => {
      const transformer = createTransformer(app.registry.items(), { schema: app.schema });
      app.pmPlugins.push(
        new Plugin({
          props: {
            clipboardTextSerializer: (slice, view) => {
              const doc = docFrom(transformer, wrapInTable(slice.content, (view as { state?: { selection: Selection } } | undefined)?.state?.selection));
              return doc ? transformer.serialize(doc) : slice.content.textBetween(0, slice.content.size, '\n\n');
            },
            clipboardTextParser: (text) => {
              const doc = transformer.parse(text);
              return new Slice(doc.content, 0, 0);
            },
          },
        }),
      );
    },
  };
}
