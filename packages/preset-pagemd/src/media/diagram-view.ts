// Diagrams on the canvas (P10, R-170 Q9): a ```mermaid fence is still CommonMark's code block (its text is what is edited
// and saved), but Print Layout, Web Layout and Read draw it, with the mermaid version and settings pagemd uses (C6). The
// drawing sits in the block's own element, so pagination measures it like any block. The source shows while the cursor is
// in it (a click on the drawing puts it there); Draft, Code and Split show the source only (the app's `enabled()`).
// The drawing itself is the app's (it loads mermaid in the webview): this file only knows the `DiagramDrawer` it is given.
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeViewConstructor } from 'prosemirror-view';
import { withAttributes } from '../shared/dom.ts';

/** What draws the diagrams (the app's, P10). */
export interface DiagramDrawer {
  /** Whether the current view draws diagrams (Print Layout, Web Layout, Read). */
  enabled(): boolean;
  /** The diagram's SVG markup; rejects with mermaid's message for a broken diagram. */
  draw(code: string): Promise<string>;
  /** A drawing finished (or failed): the block changed height (pagination lays out again). */
  drawn?(): void;
  /** Called by each drawn block: run `repaint` when `enabled()` may have changed; returns the unsubscribe. */
  subscribe(repaint: () => void): () => void;
}

/** The class on a diagram block's outer element; `-editing` while the cursor is in it, `-drawn` once it has a drawing. */
export const DIAGRAM_CLASS = 'pmd-diagram-block';
export const DIAGRAM_EDITING = 'pmd-diagram-editing';

/** How long typing in a diagram's source waits before it is drawn again (ms). */
const REDRAW_DELAY = 400;

/** A diagram's node view: the code block as before (classes included), plus the drawing next to it, not editable. */
export function diagramView(isDiagram: (node: Node) => boolean, plain: Parameters<typeof withAttributes>[0], drawer: DiagramDrawer): NodeViewConstructor {
  const code = withAttributes(plain);
  return (node, view, getPos, decorations, inner) => {
    const base = code(node, view, getPos, decorations, inner);
    if (!isDiagram(node)) return base;
    const wrap = document.createElement('div');
    wrap.className = DIAGRAM_CLASS;
    const drawing = document.createElement('figure');
    drawing.className = 'mermaid-diagram pmd-diagram-drawing';
    drawing.contentEditable = 'false';
    wrap.append(base.dom, drawing);
    let current = node;
    let source = node.textContent;
    let painted: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const paint = (): void => {
      if (!drawer.enabled() || painted === source) return;
      const wanted = source;
      painted = wanted;
      wrap.dataset['state'] = 'pending';
      drawer.draw(wanted).then(
        (svg) => {
          if (wanted !== source) return;
          drawing.innerHTML = svg;
          wrap.dataset['state'] = 'drawn';
          drawer.drawn?.();
        },
        (error: unknown) => {
          if (wanted !== source) return;
          drawing.textContent = `Diagram not drawn: ${error instanceof Error ? error.message : String(error)}`;
          wrap.dataset['state'] = 'error';
          drawer.drawn?.();
        },
      );
    };
    const unsubscribe = drawer.subscribe(paint);
    paint();
    // A click on the drawing puts the cursor in the source (which then shows above it).
    drawing.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined || !view.editable) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
      view.focus();
    });
    return {
      dom: wrap,
      ...(base.contentDOM ? { contentDOM: base.contentDOM } : {}),
      update: (next) => {
        if (next.type !== current.type || !isDiagram(next) || JSON.stringify(next.attrs) !== JSON.stringify(current.attrs)) return false;
        current = next;
        if (next.textContent !== source) {
          source = next.textContent;
          clearTimeout(timer);
          timer = setTimeout(paint, REDRAW_DELAY);
        }
        return true;
      },
      // The drawing and the block's own `data-state` are ours: ProseMirror must not read them back as an edit (it would
      // draw the block anew, which sets the state again: a loop).
      ignoreMutation: (mutation) => (mutation.type === 'attributes' && mutation.target === wrap) || drawing.contains(mutation.target as globalThis.Node),
      stopEvent: (event) => drawing.contains(event.target as globalThis.Node),
      destroy: () => {
        clearTimeout(timer);
        unsubscribe();
      },
    };
  };
}

const editingKey = new PluginKey<DecorationSet>('pmd-diagram-editing');

/** Marks the diagram block the cursor is in (`pmd-diagram-editing`), so its source shows (the canvas CSS). */
export function diagramEditingPlugin(isDiagram: (node: Node) => boolean): Plugin<DecorationSet> {
  const decorate = (state: EditorState): DecorationSet => {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (isDiagram(node)) {
        const start = $from.before(depth);
        return DecorationSet.create(state.doc, [Decoration.node(start, start + node.nodeSize, { class: DIAGRAM_EDITING })]);
      }
    }
    return DecorationSet.empty;
  };
  return new Plugin<DecorationSet>({
    key: editingKey,
    state: { init: (_config, state) => decorate(state), apply: (tr, value, _old, state) => (tr.docChanged || tr.selectionSet ? decorate(state) : value) },
    props: { decorations: (state) => editingKey.getState(state) ?? null },
  });
}

/** The canvas CSS (in the app's structural CSS): in a drawing view the source hides unless the cursor is in it. */
export const diagramCss = `
.pmd-diagram-drawing { margin: 0; cursor: pointer; white-space: normal; }
.pmd-diagram-drawing svg { max-width: 100%; height: auto; }
.pmd-canvas:not(.pmd-draw-diagrams) .pmd-diagram-drawing { display: none; }
.pmd-canvas.pmd-draw-diagrams .${DIAGRAM_CLASS}[data-state="drawn"]:not(.${DIAGRAM_EDITING}) > pre { display: none; }
.pmd-diagram-block[data-state="error"] > .pmd-diagram-drawing { color: var(--vscode-errorForeground, #a1260d); font: 12px var(--vscode-font-family, sans-serif); }
`;

/** Re-exported for the app's tests. */
export type { EditorView };
