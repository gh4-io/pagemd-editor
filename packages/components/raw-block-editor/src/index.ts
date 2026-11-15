// @pagemd-editor/raw-block-editor: an inline CodeMirror 6 editor for a raw_block node (layered-architecture.md
// §3, P3, invariant I4). Anything the presets can't model keeps its exact source text; this is how the author
// sees and edits that text on the canvas, following ProseMirror's own documented pattern for embedding a
// foreign editor inside a node view (https://prosemirror.net/examples/codemirror/).
import { defaultKeymap } from '@codemirror/commands';
import { EditorState as CMState } from '@codemirror/state';
import { EditorView as CMView, keymap as cmKeymap } from '@codemirror/view';
import type { Node } from 'prosemirror-model';
import { Selection, TextSelection } from 'prosemirror-state';
import type { EditorView as PMView, NodeView, NodeViewConstructor } from 'prosemirror-view';

/** Added to the wrapper element so the app's CSS can style it (a plain, monospace box). */
export const RAW_BLOCK_EDITOR_CLASS = 'pmd-raw-block-editor';

class RawBlockNodeView implements NodeView {
  readonly dom: HTMLElement;
  readonly #cm: CMView;
  readonly #pm: PMView;
  readonly #getPos: () => number | undefined;
  #node: Node;
  /** True while this view is applying the ProseMirror node's text into CodeMirror (avoids an update loop). */
  #syncing = false;

  constructor(node: Node, pm: PMView, getPos: () => number | undefined) {
    this.#node = node;
    this.#pm = pm;
    this.#getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.className = RAW_BLOCK_EDITOR_CLASS;

    this.#cm = new CMView({
      parent: this.dom,
      state: CMState.create({
        doc: node.textContent,
        extensions: [
          cmKeymap.of([
            { key: 'ArrowUp', run: () => this.#exitIfAtEdge(-1) },
            { key: 'ArrowLeft', run: () => this.#exitIfAtEdge(-1) },
            { key: 'ArrowDown', run: () => this.#exitIfAtEdge(1) },
            { key: 'ArrowRight', run: () => this.#exitIfAtEdge(1) },
            ...defaultKeymap,
          ]),
          CMView.updateListener.of((update) => {
            if (update.docChanged && !this.#syncing) this.#forwardToProseMirror();
          }),
        ],
      }),
    });
  }

  /** The node this view shows (kept for `update`'s type/attrs check and for comparing text). */
  get node(): Node {
    return this.#node;
  }

  update(node: Node): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    const text = node.textContent;
    if (text !== this.#cm.state.doc.toString()) {
      this.#syncing = true;
      this.#cm.dispatch({ changes: { from: 0, to: this.#cm.state.doc.length, insert: text } });
      this.#syncing = false;
    }
    return true;
  }

  selectNode(): void {
    this.#cm.focus();
  }

  stopEvent(): boolean {
    return true; // CodeMirror handles its own events; ProseMirror must not also react to them
  }

  ignoreMutation(): boolean {
    return true; // CodeMirror manages this DOM subtree itself
  }

  destroy(): void {
    this.#cm.destroy();
  }

  #forwardToProseMirror(): void {
    const pos = this.#getPos();
    if (pos === undefined) return;
    const text = this.#cm.state.doc.toString();
    if (text === this.#node.textContent) return;
    const start = pos + 1; // past the raw_block node's own opening
    const end = start + this.#node.content.size;
    const content = text === '' ? undefined : this.#pm.state.schema.text(text);
    this.#pm.dispatch(this.#pm.state.tr.replaceWith(start, end, content ? content : []));
  }

  /** Arrow key at the edge of the CodeMirror content moves the outer selection out of the block, the way
   *  leaving a normal ProseMirror node would; inside the content, lets CodeMirror move the cursor as usual. */
  #exitIfAtEdge(dir: -1 | 1): boolean {
    const sel = this.#cm.state.selection.main;
    const atStart = sel.empty && sel.from === 0;
    const atEnd = sel.empty && sel.from === this.#cm.state.doc.length;
    if ((dir < 0 && !atStart) || (dir > 0 && !atEnd)) return false; // let CodeMirror handle it
    const pos = this.#getPos();
    if (pos === undefined) return false;
    const target = dir < 0 ? pos : pos + this.#node.nodeSize;
    const outer = Selection.near(this.#pm.state.doc.resolve(target), dir) as TextSelection;
    this.#pm.dispatch(this.#pm.state.tr.setSelection(outer));
    this.#pm.focus();
    return true;
  }
}

/** A `NodeViewConstructor` for `raw_block`, to pass as `CanvasOptions.nodeViews`. */
export function rawBlockNodeView(): NodeViewConstructor {
  return (node, pm, getPos) => new RawBlockNodeView(node, pm, getPos);
}
