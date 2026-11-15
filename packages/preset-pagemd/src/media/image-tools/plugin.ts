// Shape editing on the canvas (P15, R-194 amendment 9): which shape of which annotated image should be selected, asked
// for by a command (a new shape is selected right away) or by the Inspector (its row was focused, D6 in step with the
// canvas). The request travels as a node decoration, so the annotated image's node view sees it on its next update.
// Enter on a selected annotated image starts editing its shapes (Esc in the overlay ends it).
import { NodeSelection, Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { ShapeList, ShapeRef } from './geometry.ts';

/** What the node view reads from the decoration: start editing, select `ref` (null: the first shape), focus the overlay or not. */
export interface ShapeRequest {
  seq: number;
  ref: ShapeRef | null;
  focus: boolean;
  /** P27: end shape editing instead (crop mode starts: one mode at a time). */
  stop?: boolean;
  /** FIX-S50: the shape was just created (not only selected): the app opens the Inspector on it. */
  created?: boolean;
}

interface RequestState {
  pos: number;
  request: ShapeRequest;
}

export const shapeEditingKey = new PluginKey<RequestState | null>('pmd-shape-editing');

let seq = 0;

/** `tr` plus a request to edit the shapes of the annotated image at `pos` (in `tr.doc`), with `ref` selected. */
export function requestShape(tr: Transaction, pos: number, ref: ShapeRef | null, focus: boolean, created = false): Transaction {
  return tr.setMeta(shapeEditingKey, { pos, request: { seq: ++seq, ref, focus, ...(created ? { created } : {}) } } satisfies RequestState);
}

/** `tr` plus a request to end the shape editing of the annotated image at `pos`, if it is on (P27: crop mode starts). */
export function stopShapeEditing(tr: Transaction, pos: number): Transaction {
  return tr.setMeta(shapeEditingKey, { pos, request: { seq: ++seq, ref: null, focus: false, stop: true } } satisfies RequestState);
}

/** A request to draw a shape of `list` by dragging on the picture at `pos` (FIX-S50, OQ-63; draw-mode.ts reads it). */
export interface DrawRequest {
  seq: number;
  pos: number;
  list: ShapeList;
}

export const drawModeKey = new PluginKey<DrawRequest | null>('pmd-draw-mode');

/** `tr` plus a request to start draw mode for `list` on the picture at `pos`. */
export function requestDraw(tr: Transaction, pos: number, list: ShapeList): Transaction {
  return tr.setMeta(drawModeKey, { seq: ++seq, pos, list } satisfies DrawRequest);
}

/** The decoration spec key the node view looks for. */
export const SHAPE_REQUEST = 'pmdShapeRequest';

export function shapeEditingPlugin(): Plugin<RequestState | null> {
  return new Plugin<RequestState | null>({
    key: shapeEditingKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const asked = tr.getMeta(shapeEditingKey) as RequestState | undefined;
        if (asked) return asked;
        if (!value || !tr.docChanged) return value;
        const mapped = tr.mapping.mapResult(value.pos, 1);
        return mapped.deleted ? null : { ...value, pos: mapped.pos };
      },
    },
    props: {
      decorations(state: EditorState) {
        const value = shapeEditingKey.getState(state);
        const node = value ? state.doc.nodeAt(value.pos) : null;
        if (!value || !node || node.type.name !== 'pmd_annotated_image') return null;
        return DecorationSet.create(state.doc, [Decoration.node(value.pos, value.pos + node.nodeSize, {}, { [SHAPE_REQUEST]: value.request })]);
      },
      handleKeyDown(view, event) {
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
        const sel = view.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'pmd_annotated_image' || sel.node.attrs['yamlError'] || !view.editable) return false;
        view.dispatch(requestShape(view.state.tr, sel.from, null, true));
        return true;
      },
    },
  });
}
