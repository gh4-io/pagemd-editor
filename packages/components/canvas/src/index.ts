// @pagemd-editor/canvas: hosts the ProseMirror view inside `.pmd-canvas` (layered-architecture.md §3). Basic
// in P2: the document, the items' node views, links opened with Ctrl/Cmd+click, and a placeholder for images
// that can't be shown. It knows nothing of files, markdown or VS Code; the app feeds it documents.
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import type { Node, Schema } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { EditorState, NodeSelection, Plugin, PluginKey, Selection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView, type NodeViewConstructor } from 'prosemirror-view';
import { topBlocks, type Registry } from '@pagemd-editor/core';
import { LargeImages } from './large-images.ts';

export { copyPlan, COPY_FACTOR, fullSrcOf, LARGE_IMAGE_SIDE, LargeImages, setFullSrc } from './large-images.ts';

/** Document content styles are scoped to this class. */
export const CANVAS_CLASS = 'pmd-canvas';
/** Added to an image that failed to load (outside the allowed folders, missing, blocked). */
export const IMAGE_MISSING_CLASS = 'pmd-image-missing';

export interface CanvasOptions {
  schema: Schema;
  doc: Node;
  /** Node views come from the items (SyntaxItem.nodeViews). */
  registry?: Registry;
  /** Node views the app supplies directly (e.g. the raw-block-editor's CodeMirror view), merged over the
   *  registry's; a name here wins over the same name from an item. */
  nodeViews?: Record<string, NodeViewConstructor>;
  /**
   * ProseMirror plugins contributed by feature plugins (P3, `Editor.pmPlugins`, ADR-0013 amendment): keymaps,
   * input rules, clipboard handling. Checked before the canvas's own base+list keymap, so a plugin's binding
   * wins over the default one for the same key.
   */
  pmPlugins?: Plugin[];
  editable?: boolean;
  /**
   * Reads a picture's bytes from the host (IAssets.readAsset): with it, a picture over 4000 px on a side is shown from a smaller
   * copy (P13b, AD-P13-07). Without it every picture shows from its file.
   */
  readImage?(path: string): Promise<Uint8Array>;
  /** What a screen reader calls the document's text box (default "Document"). */
  label?: string;
  /** Called after every change to the document (not for selection-only changes). */
  onDocChange?(doc: Node): void;
  /** Ctrl/Cmd+click on a link: the href exactly as written in the document. */
  onOpenLink?(href: string): void;
  /**
   * The selection moved (P9: Split view keeps the Code view's cursor with it). `byAuthor` is false for moves made with
   * `reveal` or `setDocument`, so two views following each other never chase each other.
   */
  onSelectionChange?(head: number, byAuthor: boolean): void;
}

/** Marks a transaction made by `reveal` (not the author's own move). */
const REVEAL_META = 'pmd-reveal';

/**
 * FIX-PGF: marks the transaction `patchDocument` makes (the text read again after an outside change). Add-ons can tell it from the
 * author's own edits; it never goes back to VS Code as an edit (it is applied without the canvas's own dispatch).
 */
export const OUTSIDE_META = 'pmd-outside-change';

/**
 * Enter/Backspace/etc. (`prosemirror-commands`' base keymap) plus list Enter/Tab/Shift-Tab
 * (`prosemirror-schema-list`), when the schema has list nodes (OQ-24, R-95). Always included, after any
 * plugin-contributed keymap, so a plugin's own binding for the same key takes priority.
 */
function defaultKeymapPlugins(schema: Schema): Plugin[] {
  const plugins: Plugin[] = [];
  const listItem = schema.nodes['list_item'];
  if (listItem) {
    plugins.push(
      keymap({
        Enter: splitListItem(listItem),
        Tab: sinkListItem(listItem),
        'Shift-Tab': liftListItem(listItem),
      }),
    );
  }
  plugins.push(keymap(baseKeymap));
  return plugins;
}

export class Canvas {
  readonly element: HTMLElement;
  readonly view: EditorView;
  /** Pictures over 4000 px on a side are shown from a smaller copy (P13b); null without `readImage`. */
  readonly images: LargeImages | null;
  readonly #schema: Schema;
  readonly #plugins: Plugin[];
  #editable: boolean;
  /** P18: what the text area carries for the template element it stands in for (its classes, id, style…). */
  #contentAttributes: Record<string, string> = {};

  constructor(parent: HTMLElement, options: CanvasOptions) {
    this.#schema = options.schema;
    this.#plugins = [...(options.pmPlugins ?? []), ...defaultKeymapPlugins(options.schema), pdfLook()];
    this.element = parent.ownerDocument.createElement('div');
    this.element.className = CANVAS_CLASS;
    parent.append(this.element);

    this.#editable = options.editable ?? true;
    // P13b (amendment 11, AD-P13-07): a picture over 4000 px is shown from a smaller copy. Watching starts before the pictures exist.
    this.images = options.readImage ? new LargeImages(this.element, { read: options.readImage }) : null;
    this.view = new EditorView(this.element, {
      state: EditorState.create({ schema: options.schema, doc: options.doc, selection: near(options.doc, 0), plugins: this.#plugins }),
      nodeViews: { ...nodeViewsOf(options.registry), ...options.nodeViews },
      editable: () => this.#editable,
      // P13b (amendment 8a): a screen reader names the page it types into; Read (not editable) says so.
      attributes: () => ({ role: 'textbox', 'aria-label': options.label ?? 'Document', 'aria-multiline': 'true', 'aria-readonly': String(!this.#editable), ...this.#contentAttributes }),
      dispatchTransaction: (tr) => {
        this.view.updateState(this.view.state.apply(tr));
        if (tr.docChanged) options.onDocChange?.(this.view.state.doc);
        if (tr.selectionSet || tr.docChanged) options.onSelectionChange?.(this.view.state.selection.head, tr.getMeta(REVEAL_META) !== true && this.view.hasFocus());
      },
      handleDOMEvents: {
        click: (_view, event) => {
          const link = (event.target as Element | null)?.closest?.('a[href]');
          if (!link || !this.element.contains(link)) return false;
          event.preventDefault(); // never navigate the webview itself
          if (event.ctrlKey || event.metaKey) options.onOpenLink?.(link.getAttribute('href') ?? '');
          return true;
        },
      },
    });

    // Images: mark the ones that fail (PM ignores attribute changes on leaf nodes, so this is safe).
    this.element.addEventListener('error', (e) => markImage(e.target, true), true);
    this.element.addEventListener('load', (e) => markImage(e.target, false), true);
  }

  get doc(): Node {
    return this.view.state.doc;
  }

  /** The cursor position (the selection's head). */
  get cursor(): number {
    return this.view.state.selection.head;
  }

  /**
   * Shows another document read from the text (an outside change: VS Code's undo or redo, another program), changing only the
   * blocks that differ (FIX-PGF, item 3, AD-FIX-PGF-09). One transaction, not a new editor state, so every add-on keeps what it has:
   * the pages' paper and the gaps between them stay on screen and the pagination measures again from the changed page only, the
   * unchanged blocks keep their place on screen. Returns the document now shown (equal to `doc`, sharing its unchanged blocks with
   * the one shown before); falls back to `setDocument` (and returns `doc`) when the patched document would not be exactly `doc`, e.g.
   * when an add-on changed something on the way.
   */
  patchDocument(doc: Node, cursor?: number): Node {
    const state = this.view.state;
    const old = state.doc;
    const start = old.content.findDiffStart(doc.content);
    const tr = state.tr.setMeta('addToHistory', false).setMeta(OUTSIDE_META, true);
    if (start !== null) {
      let { a: endA, b: endB } = old.content.findDiffEnd(doc.content)!;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      try {
        tr.replace(start, endA, doc.slice(start, endB));
      } catch {
        this.setDocument(doc, cursor);
        return doc;
      }
    }
    if (cursor !== undefined) tr.setSelection(near(tr.doc, cursor));
    const next = state.apply(tr);
    if (!next.doc.eq(doc)) {
      this.setDocument(doc, cursor);
      return doc;
    }
    this.view.updateState(next);
    return next.doc;
  }

  /** Shows another document in a brand-new editor state, with the cursor near `cursor` (every add-on starts again). */
  setDocument(doc: Node, cursor?: number): void {
    const state = EditorState.create({
      schema: this.#schema,
      doc,
      selection: cursor === undefined ? undefined : near(doc, cursor),
      plugins: this.#plugins,
    });
    this.view.updateState(state);
  }

  /**
   * Puts the selection at `pos` and scrolls it into view (P9: the Outline's entries, Split view's cursor): the node itself
   * when an atom (a figure, a box's chip) starts there, else the nearest place to type. Focuses the canvas with `focus`.
   */
  reveal(pos: number, focus = false): void {
    const doc = this.view.state.doc;
    const at = Math.max(0, Math.min(pos, doc.content.size));
    const node = doc.nodeAt(at);
    const selection = node && node.isAtom && NodeSelection.isSelectable(node) ? NodeSelection.create(doc, at) : near(doc, node && !node.isAtom && !node.isText ? at + 1 : at);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView().setMeta(REVEAL_META, true));
    if (focus) this.view.focus();
  }

  /** Types `text` at the end of top-level block `index` (groups looked through, P18), as a user would (one transaction). */
  typeAtEndOfBlock(index: number, text: string): void {
    const doc = this.view.state.doc;
    const blocks = topBlocks(doc);
    if (index < 0 || index >= blocks.length) throw new RangeError(`No top-level block ${index} (the document has ${blocks.length}).`);
    const end = blocks[index]!.pos + blocks[index]!.node.nodeSize;
    const at = Selection.findFrom(doc.resolve(end - 1), -1, true) ?? Selection.near(doc.resolve(end - 1), -1);
    this.view.dispatch(this.view.state.tr.setSelection(at).insertText(text));
  }

  /** Read view (P6, amendment 10) turns editing off, the other views on; the document stays selectable. */
  setEditable(editable: boolean): void {
    this.#editable = editable;
    this.view.setProps({ editable: () => this.#editable });
  }

  get editable(): boolean {
    return this.#editable;
  }

  /**
   * P18 (R-228): attributes for the text area itself, merged after the editor's own (a `class` adds to ProseMirror's): the
   * template element the text area stands in for gives its classes, id and style this way, so ProseMirror keeps them.
   */
  setContentAttributes(attributes: Readonly<Record<string, string>>): void {
    const next = { ...attributes };
    if (JSON.stringify(next) === JSON.stringify(this.#contentAttributes)) return;
    this.#contentAttributes = next;
    this.view.setProps({ attributes: this.view.props.attributes });
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.images?.destroy();
    this.view.destroy();
    this.element.remove();
  }
}

/**
 * A cursor as close as possible to `pos` (clamped into the document), in text when there is any. ProseMirror's
 * own default would select a leading atom instead (a `---` rule: every document with frontmatter), and a first
 * click into text then left that selection in place, so typing replaced the rule (P4, R-120).
 */
export function near(doc: Node, pos: number): Selection {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  return Selection.findFrom($pos, 1, true) ?? Selection.findFrom($pos, -1, true) ?? Selection.near($pos);
}

function nodeViewsOf(registry: Registry | undefined): Record<string, NodeViewConstructor> {
  const views: Record<string, NodeViewConstructor> = {};
  for (const item of registry?.items() ?? []) Object.assign(views, item.nodeViews);
  return views;
}

function markImage(target: EventTarget | null, missing: boolean): void {
  if (target instanceof HTMLImageElement) target.classList.toggle(IMAGE_MISSING_CLASS, missing);
}

/** The class on every soft line break (a line break inside a paragraph, kept in the text, R-85 B) (P18). */
export const SOFT_BREAK_CLASS = 'pmd-soft-break';
/** On the code block (a raw HTML block, a fence) that holds the cursor or is selected (P18). */
export const CURSOR_IN_CLASS = 'pmd-cursor-in';
/** The attribute on a tight list (no blank line between its items), whose items' paragraphs have no gap between them (P18). */
export const TIGHT_ATTRIBUTE = 'data-tight';
/**
 * On the canvas in the views styled by the profile (P18): the text is drawn as pagemd's PDF draws it: soft line breaks as
 * spaces, and the items of a tight list without paragraph gaps (markdown-it writes a tight list's items without `<p>`).
 */
export const PDF_LOOK_CLASS = 'pmd-pdf-look';

const pdfLookKey = new PluginKey<DecorationSet>('pmd-pdf-look');

/**
 * Between `from` and `to`: every line break inside a non-code textblock, as an inline decoration on that one character, and
 * every tight list, as a node decoration with TIGHT_ATTRIBUTE.
 */
function pdfLookDecorations(doc: Node, from: number, to: number): Decoration[] {
  const out: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.attrs['tight'] === true && !node.isTextblock && !node.isAtom) out.push(Decoration.node(pos, pos + node.nodeSize, { [TIGHT_ATTRIBUTE]: 'true' }));
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    node.forEach((child, offset) => {
      if (!child.isText) return;
      const text = child.text!;
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
        const at = pos + 1 + offset + i;
        out.push(Decoration.inline(at, at + 1, { class: SOFT_BREAK_CLASS }));
      }
    });
    return false;
  });
  return out;
}

/**
 * P18: marks each soft line break, so the views styled by the profile can draw it as a space (`white-space: normal` on that one
 * character: the line break collapses to a space there, while the rest of the text keeps ProseMirror's `break-spaces`), and each
 * tight list. View only: the text keeps the line break. Kept up to date per change: only the top-level blocks a change touched are
 * read again.
 */
export function pdfLook(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: pdfLookKey,
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, pdfLookDecorations(state.doc, 0, state.doc.content.size)),
      apply: (tr, set) => {
        if (!tr.docChanged) return set;
        let next = set.map(tr.mapping, tr.doc);
        const ranges: Array<[number, number]> = [];
        tr.mapping.maps.forEach((map, i) => {
          map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
            const rest = tr.mapping.slice(i + 1);
            ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
          });
        });
        for (const [a, b] of ranges) {
          const from = Math.max(0, Math.min(a, tr.doc.content.size));
          const to = Math.max(from, Math.min(b, tr.doc.content.size));
          const $from = tr.doc.resolve(from);
          const $to = tr.doc.resolve(to);
          const start = $from.depth > 0 ? $from.before(1) : from;
          const end = $to.depth > 0 ? $to.after(1) : to;
          next = next.remove(next.find(start, end)).add(tr.doc, pdfLookDecorations(tr.doc, start, end));
        }
        return next;
      },
    },
    props: {
      decorations: (state) => {
        const set = pdfLookKey.getState(state) ?? DecorationSet.empty;
        // The code block holding the cursor (or selected) is marked, so a raw HTML block shows its source while it is edited.
        const sel = state.selection as Selection & { node?: Node };
        let at: { pos: number; node: Node } | null = null;
        if (sel.node?.type.spec.code) at = { pos: sel.from, node: sel.node };
        else if (sel.$head.parent.type.spec.code && sel.$head.depth > 0) at = { pos: sel.$head.before(), node: sel.$head.parent };
        return at ? set.add(state.doc, [Decoration.node(at.pos, at.pos + at.node.nodeSize, { class: CURSOR_IN_CLASS })]) : set;
      },
    },
  });
}

/**
 * The CSS ProseMirror needs to behave (from prosemirror-view 1.42.6 `style/prosemirror.css`), plus the image
 * placeholder. Document styles come from a style package (style-default in Draft).
 */
export const canvasCss = `
.ProseMirror { position: relative; word-wrap: break-word; white-space: pre-wrap; white-space: break-spaces;
  -webkit-font-variant-ligatures: none; font-variant-ligatures: none; font-feature-settings: "liga" 0; outline: none; }
.ProseMirror pre { white-space: pre-wrap; }
.ProseMirror li { position: relative; }
.ProseMirror-hideselection *::selection { background: transparent; }
.ProseMirror-hideselection { caret-color: transparent; }
.ProseMirror [draggable][contenteditable=false] { user-select: text; }
.ProseMirror-selectednode { outline: 2px solid var(--vscode-focusBorder, #8cf); }
li.ProseMirror-selectednode { outline: none; }
li.ProseMirror-selectednode:after { content: ""; position: absolute; left: -32px; right: -2px; top: -2px; bottom: -2px;
  border: 2px solid var(--vscode-focusBorder, #8cf); pointer-events: none; }
img.ProseMirror-separator { display: inline !important; border: none !important; margin: 0 !important;
  padding: 0 !important; background: none !important; box-shadow: none !important; }
.${CANVAS_CLASS}.${PDF_LOOK_CLASS} .${SOFT_BREAK_CLASS} { white-space: normal; }
.${CANVAS_CLASS}.${PDF_LOOK_CLASS} [${TIGHT_ATTRIBUTE}="true"] > li > p { margin-top: 0; margin-bottom: 0; }
.${CANVAS_CLASS}:not(.${PDF_LOOK_CLASS}) .pmd-html-preview { display: none; }
.${CANVAS_CLASS}.${PDF_LOOK_CLASS} .pmd-html-preview { display: contents; }
.${CANVAS_CLASS}.${PDF_LOOK_CLASS} .pmd-html-view { break-inside: avoid; white-space: normal; }
.${CANVAS_CLASS}.${PDF_LOOK_CLASS} .pmd-html-view:not(.${CURSOR_IN_CLASS}) > pre.pmd-html-block { display: none; }
.${CANVAS_CLASS}.${PDF_LOOK_CLASS} .pmd-html-view.${CURSOR_IN_CLASS} > .pmd-html-preview { display: none; }
.${CANVAS_CLASS} img.${IMAGE_MISSING_CLASS} { display: inline-block; min-width: 4em; min-height: 1.5em; padding: 0.25em;
  border: 1px dashed var(--vscode-editorWarning-foreground, #c90); color: var(--vscode-descriptionForeground, #888); }
`;
