// @pagemd-editor/code-view: the Code view (P9, R-164): the document's markdown text in CodeMirror 6 (already the raw-block
// editor's engine, P3). It reads no markdown itself (one dialect, I1): the app hands it the transformer's block ranges
// with a kind for each block, and the view colors and folds by them. CodeMirror's own undo history is left out, so
// Ctrl/Cmd+Z goes to VS Code's undo like everywhere else in the editor (R-94). The view keeps the text VS Code has (the
// base) apart from typing not yet sent: the app takes the edits after a pause and sends them (one undo step per pause),
// and a text that arrives from elsewhere is merged under typing not yet sent.
// Line endings (fix-sync-bugs, bug 7): CodeMirror keeps its lines apart and counts every line break as one position, so a
// Windows file's '\r\n' would read back as '\n'. The view keeps the file's own line ending (VS Code keeps one per file) and
// turns text and positions at its edges: `text`, `cursor`, edits and every offset the app hands in are the file's.
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, codeFolding, foldGutter, foldKeymap, foldService, HighlightStyle } from '@codemirror/language';
import { gotoLine, highlightSelectionMatches, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import { Annotation, ChangeSet, Compartment, EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { crosshairCursor, Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection, runScopeHandlers, type DecorationSet } from '@codemirror/view';
import { tags, type Tag } from '@lezer/highlight';
import type { TextEdit } from '@pagemd-editor/core';

/** What a top-level block is, for its color (the app decides from the block's node). */
export type CodeKind = 'heading' | 'code' | 'quote' | 'list' | 'table' | 'html' | 'directive' | 'meta' | 'rule' | 'raw' | 'text';

/** One top-level block: where its text sits ([from, to), the transformer's block range) and what it is. */
export interface CodeBlock {
  from: number;
  to: number;
  kind: CodeKind;
  /** Headings: 1–6 (a heading folds its whole section). */
  level?: number;
}

/** The commands the view hands to VS Code instead of doing them itself. */
export type CodeCommand = 'undo' | 'redo' | 'save';

export interface CodeViewOptions {
  /** The text to show (the text VS Code has). */
  text: string;
  /**
   * The file's line ending as VS Code keeps it (the app asks the host). Absent or undefined: read from the text, '\n' when
   * it has no line break.
   */
  lineEnding?(): string | undefined;
  /** The page's CSP nonce, for CodeMirror's own style elements. */
  nonce?: string;
  editable?: boolean;
  /** The author typed: there are edits to send (the app sends them after a pause). */
  onChange?(): void;
  /** The author moved the cursor (not `reveal`). */
  onCursor?(offset: number): void;
  /** Undo, redo or save was pressed: VS Code's (R-94). */
  onCommand?(command: CodeCommand): void;
  /** The view lost the focus (the app sends what is pending). */
  onBlur?(): void;
  /** The view was scrolled (Split view keeps the canvas's scrolling with it). */
  onScroll?(): void;
}

/** Changes that came from elsewhere (not typed here): never sent back. */
const fromOutside = Annotation.define<boolean>();
/** Selection moves made by `reveal`: not reported as the author's. */
const fromReveal = Annotation.define<boolean>();
const setBlocks = StateEffect.define<CodeBlock[]>();
const setSynced = StateEffect.define<{ from: number; to: number } | null>();

/** Which highlight tag each kind is drawn with (the colors are a HighlightStyle in VS Code's theme colors). */
const KIND_TAGS: Readonly<Record<CodeKind, Tag | null>> = {
  heading: tags.heading,
  code: tags.monospace,
  quote: tags.quote,
  list: tags.list,
  table: tags.content,
  html: tags.angleBracket,
  directive: tags.processingInstruction,
  meta: tags.meta,
  rule: tags.contentSeparator,
  raw: tags.invalid,
  text: null,
};

/** The colors: VS Code's theme variables only (editor UI, like every other panel). */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: 'var(--vscode-symbolIcon-classForeground, inherit)' },
  { tag: tags.monospace, color: 'var(--vscode-textPreformat-foreground, inherit)' },
  { tag: tags.quote, fontStyle: 'italic', color: 'var(--vscode-descriptionForeground, inherit)' },
  { tag: tags.list, color: 'var(--vscode-symbolIcon-enumeratorMemberForeground, inherit)' },
  { tag: tags.content, color: 'var(--vscode-symbolIcon-structForeground, inherit)' },
  { tag: tags.angleBracket, color: 'var(--vscode-symbolIcon-keywordForeground, inherit)' },
  { tag: tags.processingInstruction, color: 'var(--vscode-symbolIcon-keywordForeground, inherit)' },
  { tag: tags.meta, color: 'var(--vscode-symbolIcon-propertyForeground, inherit)' },
  { tag: tags.contentSeparator, color: 'var(--vscode-descriptionForeground, inherit)' },
  { tag: tags.invalid, color: 'var(--vscode-editorWarning-foreground, inherit)' },
]);

/** The class a kind's lines get (null: plain text). */
export function kindClass(kind: CodeKind): string | null {
  const tag = KIND_TAGS[kind];
  return tag ? codeHighlightStyle.style([tag]) : null;
}

/** The smallest single replacement that turns `from` into `to`. */
export function textDiff(from: string, to: string): TextEdit | null {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { from: start, to: from.length - end, text: to.slice(start, to.length - end) };
}

const changeOf = (edit: TextEdit | null, length: number): ChangeSet => ChangeSet.of(edit ? [{ from: edit.from, to: edit.to, insert: edit.text }] : [], length);

/** Every line break as '\n' (how CodeMirror holds the text). */
const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');

/** The line ending a text uses ('\n' when it has none). */
export function lineEndingOf(text: string): string {
  return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
}

/**
 * `incoming` (a text from elsewhere, against `base`) merged with the typing not yet sent (`current`, against `base`):
 * the incoming change is applied on top of the typing. What the view shows next, in `incoming`'s line ending (each text
 * uses one line ending throughout, as VS Code keeps it).
 */
export function rebase(base: string, current: string, incoming: string): string {
  const [b, c, i] = [toLf(base), toLf(current), toLf(incoming)];
  const local = changeOf(textDiff(b, c), b.length);
  const remote = changeOf(textDiff(b, i), b.length);
  const merged = remote.map(local).apply(EditorState.create({ doc: c }).doc).toString();
  const eol = lineEndingOf(incoming);
  return eol === '\n' ? merged : merged.replace(/\n/g, eol);
}

/** The block ranges, kept in step with typing until the app sends new ones. */
const blocksField = StateField.define<CodeBlock[]>({
  create: () => [],
  update(blocks, tr) {
    for (const effect of tr.effects) if (effect.is(setBlocks)) return effect.value;
    if (!tr.docChanged) return blocks;
    return blocks.map((b) => {
      const from = tr.changes.mapPos(b.from, 1);
      return { ...b, from, to: Math.max(from, tr.changes.mapPos(b.to, -1)) };
    });
  },
});

/** One line decoration per line of each colored block. */
function colors(state: EditorState, blocks: readonly CodeBlock[]): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  for (const block of blocks) {
    const cls = kindClass(block.kind);
    if (!cls || block.from > doc.length) continue;
    const first = doc.lineAt(block.from).number;
    const last = doc.lineAt(Math.min(block.to, doc.length)).number;
    for (let n = first; n <= last; n++) out.push(Decoration.line({ class: cls }).range(doc.line(n).from));
  }
  return Decoration.set(out, true);
}

const colorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.effects.some((e) => e.is(setBlocks))) return colors(tr.state, tr.state.field(blocksField));
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Split view: the lines of the block the canvas's cursor is in. */
const syncedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setSynced)) continue;
      if (!effect.value) return Decoration.none;
      const doc = tr.state.doc;
      const first = doc.lineAt(Math.min(effect.value.from, doc.length)).number;
      const last = doc.lineAt(Math.min(effect.value.to, doc.length)).number;
      const lines: Range<Decoration>[] = [];
      for (let n = first; n <= last; n++) lines.push(Decoration.line({ class: 'pmd-code-synced' }).range(doc.line(n).from));
      return Decoration.set(lines);
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Folding by the blocks: a heading folds its section (up to the next heading of the same or a higher level), any other
 * block of more than one line folds after its first line.
 */
const foldByBlocks = foldService.of((state, lineStart, lineEnd) => {
  const blocks = state.field(blocksField, false) ?? [];
  const i = blocks.findIndex((b) => b.from >= lineStart && b.from <= lineEnd);
  if (i < 0) return null;
  const block = blocks[i]!;
  let to = block.to;
  if (block.kind === 'heading') {
    const level = block.level ?? 1;
    let k = i + 1;
    while (k < blocks.length && !(blocks[k]!.kind === 'heading' && (blocks[k]!.level ?? 1) <= level)) k++;
    to = blocks[k - 1]!.to;
  }
  to = Math.min(to, state.doc.length);
  return to > lineEnd ? { from: lineEnd, to } : null;
});

/** Editor UI: VS Code's theme variables. */
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-editor-background)', fontSize: 'var(--vscode-editor-font-size, 13px)' },
  '.cm-scroller': { fontFamily: 'var(--vscode-editor-font-family, monospace)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground, currentColor)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, currentColor)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground, #264f78)' },
  '.cm-gutters': { backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none' },
  '.cm-activeLineGutter': { color: 'var(--vscode-editorLineNumber-activeForeground, inherit)', backgroundColor: 'transparent' },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--vscode-editor-foldBackground, transparent)', border: 'none', color: 'var(--vscode-descriptionForeground)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--vscode-editor-selectionHighlightBackground, rgba(255,255,255,0.1))' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background, rgba(0,100,0,0.3))', outline: '1px solid var(--vscode-editorBracketMatch-border, transparent)' },
  '.pmd-code-synced': { backgroundColor: 'var(--vscode-editor-rangeHighlightBackground, rgba(255,255,255,0.06))' },
});

export class CodeView {
  readonly element: HTMLElement;
  readonly view: EditorView;
  readonly #o: CodeViewOptions;
  readonly #editable = new Compartment();
  /** The text VS Code has, as far as this view knows. */
  #base: string;
  /** The file's line ending: what `text` joins the lines with. */
  #eol: string;

  constructor(parent: HTMLElement, options: CodeViewOptions) {
    this.#o = options;
    this.#base = options.text;
    this.#eol = this.#eolFor(options.text);
    this.element = parent.ownerDocument.createElement('div');
    this.element.className = 'pmd-code';
    parent.append(this.element);
    const command = (name: CodeCommand) => () => (options.onCommand?.(name), true);
    const extensions: Extension[] = [
      ...(options.nonce ? [EditorView.cspNonce.of(options.nonce)] : []),
      // VS Code's everyday editing (session 54): several cursors (Ctrl+D next occurrence, Ctrl+Shift+L all, Alt+click, Shift+Alt+drag for a
      // block), the other occurrences of the selection and the matching bracket marked, Ctrl+G for a line.
      EditorState.allowMultipleSelections.of(true),
      drawSelection(),
      EditorView.clickAddsSelectionRange.of((event) => event.altKey),
      rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
      crosshairCursor({ key: 'Alt' }),
      highlightSelectionMatches(),
      bracketMatching(),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      codeFolding(),
      foldGutter(),
      foldByBlocks,
      blocksField,
      colorField,
      syncedField,
      EditorView.styleModule.of(codeHighlightStyle.module!),
      EditorView.lineWrapping,
      // P13b (amendment 8a): the text box has a name for a screen reader, and the scrolling area holds an explicit Tab stop (axe: scrollable-region-focusable).
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', tabindex: '0' }),
      theme,
      this.#editable.of(editableExt(options.editable ?? true)),
      // VS Code's undo, redo and save (R-94); no CodeMirror history at all.
      keymap.of([
        { key: 'Mod-z', run: command('undo'), preventDefault: true },
        { key: 'Mod-y', run: command('redo'), preventDefault: true },
        { key: 'Mod-Shift-z', run: command('redo'), preventDefault: true },
        { key: 'Mod-s', run: command('save'), preventDefault: true },
        { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
        { key: 'Mod-Shift-l', run: selectSelectionMatches, preventDefault: true },
        { key: 'Mod-g', run: gotoLine, preventDefault: true },
        ...foldKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.domEventHandlers({ scroll: () => void options.onScroll?.() }),
      EditorView.updateListener.of((update) => {
        const outside = update.transactions.some((tr) => tr.annotation(fromOutside));
        if (update.docChanged && !outside) options.onChange?.();
        const revealed = update.transactions.some((tr) => tr.annotation(fromReveal));
        if (update.selectionSet && !revealed && !outside && update.view.hasFocus) options.onCursor?.(this.#toText(update.state.selection.main.head));
        if (update.focusChanged && !update.view.hasFocus) options.onBlur?.();
      }),
    ];
    this.view = new EditorView({ parent: this.element, state: EditorState.create({ doc: options.text, extensions }) });
  }

  /** The text shown now (with typing not yet sent), in the file's line ending. */
  get text(): string {
    return this.view.state.doc.sliceString(0, undefined, this.#eol);
  }

  /** True while there is typing VS Code doesn't have yet. */
  get pending(): boolean {
    return this.text !== this.#base;
  }

  get focused(): boolean {
    return this.view.hasFocus;
  }

  /** The cursor's offset in the text. */
  get cursor(): number {
    return this.#toText(this.view.state.selection.main.head);
  }

  /**
   * The typing not yet sent as edits against the text VS Code has, plus the text they make; null when there is none.
   * From now on that text counts as VS Code's (`reset` puts VS Code's back if it refuses them).
   */
  takeEdits(): { edits: TextEdit[]; base: string; text: string } | null {
    const text = this.text;
    const edit = textDiff(this.#base, text);
    if (!edit) return null;
    const base = this.#base;
    this.#base = text;
    return { edits: [edit], base, text };
  }

  /** A text from elsewhere (the canvas's edits, VS Code's undo, another editor): typing not yet sent stays on top. */
  receive(text: string): void {
    if (text === this.#base) return;
    const eol = this.#eolFor(text);
    // The file's line ending changed (VS Code's Change End of Line Sequence): its text wins, as for a stale answer.
    if (eol !== this.#eol) return this.reset(text);
    const next = this.pending ? rebase(this.#base, this.text, text) : text;
    this.#base = text;
    this.#show(next);
  }

  /** VS Code's text wins (edits refused as stale): show it, drop typing not yet sent. */
  reset(text: string): void {
    this.#base = text;
    this.#eol = this.#eolFor(text);
    this.#show(text);
  }

  /** The blocks to color and fold, as ranges in `text` (moved onto the text shown now when typing changed it). */
  setBlocks(blocks: readonly CodeBlock[], text: string): void {
    const shown = this.text;
    let mapped = [...blocks];
    if (text !== shown) {
      const change = changeOf(textDiff(text, shown), text.length);
      mapped = blocks.map((b) => {
        const from = change.mapPos(b.from, 1);
        return { ...b, from, to: Math.max(from, change.mapPos(b.to, -1)) };
      });
    }
    mapped = mapped.map((b) => ({ ...b, from: this.#toView(b.from), to: this.#toView(b.to) }));
    this.view.dispatch({ effects: setBlocks.of(mapped), annotations: fromOutside.of(true) });
  }

  setEditable(editable: boolean): void {
    this.view.dispatch({ effects: this.#editable.reconfigure(editableExt(editable)) });
  }

  /**
   * Puts the cursor at `offset` and scrolls it into view, without taking the focus; `block` (Split view) is marked as
   * the block the other side's cursor is in.
   */
  reveal(offset: number, block?: { from: number; to: number }): void {
    const at = this.#toView(offset);
    this.view.dispatch({
      selection: { anchor: at },
      effects: [EditorView.scrollIntoView(at, { y: 'center' }), setSynced.of(block ? { from: this.#toView(block.from), to: this.#toView(block.to) } : null)],
      annotations: fromReveal.of(true),
    });
  }

  /**
   * Marks `block` as the block the other side's cursor is in (Split view) without moving or clearing the selection here. The Code
   * view's own cursor and selection are the author's while they drag or click in it (FIX-S50, OQ-66: `reveal` put the cursor back to
   * one point at every step of a drag, so no text could be selected).
   */
  mark(block: { from: number; to: number }): void {
    this.view.dispatch({ effects: setSynced.of({ from: this.#toView(block.from), to: this.#toView(block.to) }), annotations: fromReveal.of(true) });
  }

  focus(): void {
    this.view.focus();
  }

  /**
   * Presses `key` as the author would, through the view's own key handling (tests in the VS Code host, where no real key can
   * reach the page): one character is typed, any other is a key name ('Enter', 'Backspace', …). False when nothing took it.
   */
  press(key: string): boolean {
    if ([...key].length === 1) {
      this.view.dispatch({ ...this.view.state.replaceSelection(key), userEvent: 'input.type', scrollIntoView: true });
      return true;
    }
    return runScopeHandlers(this.view, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }), 'editor');
  }

  /** The offset in the text at the top edge of the view (between lines by how far the top line is scrolled). */
  topOffset(): number {
    const block = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop);
    const frac = block.height > 0 ? Math.min(1, Math.max(0, (this.view.scrollDOM.scrollTop - block.top) / block.height)) : 0;
    return this.#toText(block.from + Math.floor(frac * block.length));
  }

  /** Scrolls so `offset` is at the top edge of the view (no cursor move). */
  scrollToOffset(offset: number): void {
    const at = this.#toView(offset);
    const block = this.view.lineBlockAt(at);
    this.view.scrollDOM.scrollTop = block.top + (block.length > 0 ? ((at - block.from) / block.length) * block.height : 0);
  }

  /** Types `text` at `offset` as the author would (tests in the VS Code host). */
  insertAt(offset: number, text: string): void {
    const at = Math.min(this.#toView(offset), this.view.state.doc.length);
    this.view.dispatch({ changes: { from: at, insert: text } });
  }

  /** Lays the view out again (after it was hidden). */
  refresh(): void {
    this.view.requestMeasure();
  }

  destroy(): void {
    this.view.destroy();
    this.element.remove();
  }

  /** Shows `text` (in any line ending): the smallest change to CodeMirror's '\n' lines. */
  #show(text: string): void {
    const edit = textDiff(this.view.state.doc.toString(), toLf(text));
    if (!edit) return;
    const tr: Parameters<EditorView['dispatch']>[0] = { changes: { from: edit.from, to: edit.to, insert: edit.text }, annotations: fromOutside.of(true) };
    this.view.dispatch(tr);
  }

  #eolFor(text: string): string {
    const eol = this.#o.lineEnding?.() ?? lineEndingOf(text);
    return eol === '\r\n' ? '\r\n' : '\n';
  }

  /** A CodeMirror position as an offset in the file's text (each line break before it may be two characters there). */
  #toText(pos: number): number {
    return this.#eol.length === 1 ? pos : pos + (this.#eol.length - 1) * (this.view.state.doc.lineAt(pos).number - 1);
  }

  /** An offset in the file's text as a CodeMirror position (one inside a line break goes to the end of its line), clamped. */
  #toView(offset: number): number {
    const doc = this.view.state.doc;
    const extra = this.#eol.length - 1;
    if (extra === 0) return Math.max(0, Math.min(offset, doc.length));
    // The last line whose start, counted in the file's text, is at or before `offset`.
    let lo = 1;
    let hi = doc.lines;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (doc.line(mid).from + extra * (mid - 1) <= offset) lo = mid;
      else hi = mid - 1;
    }
    const line = doc.line(lo);
    return Math.max(line.from, Math.min(offset - extra * (lo - 1), line.to));
  }
}

function editableExt(editable: boolean): Extension {
  return [EditorView.editable.of(editable), EditorState.readOnly.of(!editable)];
}

/** The view's frame. Editor UI: VS Code's theme variables. */
export const codeViewCss = `
.pmd-code { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--vscode-editor-background); }
.pmd-code[hidden] { display: none; }
.pmd-code .cm-editor { flex: 1; min-height: 0; }
.pmd-code .cm-editor.cm-focused { outline: none; }
`;

