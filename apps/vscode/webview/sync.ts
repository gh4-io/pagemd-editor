// Keeps the canvas and VS Code's text document in step (ADR-0007, R-87 amendments 4 and 5).
// Out: after a short pause in typing, the smallest text edits (diffToEdits) go to the host with the version
// they were computed against, so VS Code marks the file dirty and records one undo step per pause.
// In: any change VS Code reports (another editor, git checkout, VS Code's own undo) is re-read, and the cursor
// goes back to the same place in the text. VS Code's text always wins over edits not yet sent.
import type { Node } from 'prosemirror-model';
import { topBlocks, type IDocumentSync } from '@pagemd-editor/core';
import { diffToEdits } from '@pagemd-editor/lossless';
import { recordSource, sourceOf, type Transformer } from '@pagemd-editor/transformer';

/** How long typing must pause before the edits are sent. */
export const SYNC_DELAY_MS = 300;

export interface SessionOptions {
  /**
   * Reads the text. A function picks the reader for each text (P4: a document's frontmatter switches gated
   * syntax on, e.g. `fancy_lists: true`, so a re-read after an outside change may need another reader).
   */
  transformer: Transformer | ((text: string) => Transformer);
  /** IDocumentSync plus the version the host last reported (DocumentSyncClient). */
  sync: IDocumentSync & { readonly version: number };
  /**
   * Shows a re-read document with the cursor at `cursor`. FIX-PGF: may return the document it shows instead, equal to `doc` but
   * sharing its unchanged blocks with the one shown before (the canvas patches the changed blocks only); the session then holds that
   * one, with `doc`'s source recorded on it, so the next save still finds every unchanged block by identity (ADR-0007).
   */
  replace(doc: Node, cursor: number): Node | void;
  /** The cursor position in the document shown now. */
  cursor(): number;
  delay?: number;
  onError?(error: unknown): void;
  /** The host now has the canvas's edits (P8: a property typed into the frontmatter may switch a gate on). */
  onSynced?(): void;
  /**
   * The file's line ending as VS Code keeps it (protocol v11). VS Code turns every line break an edit inserts into this one, so
   * the canvas writes it too; otherwise it is read from the text, and a blank or one-line file has none to read (fix-sync-bugs).
   */
  lineEnding?(): string | undefined;
}

export class DocumentSession {
  readonly #options: SessionOptions;
  /** The document the host has: its source text is recorded (sourceOf). */
  #synced: Node;
  /** The document the canvas shows (the same object as #synced when nothing is pending). */
  #latest: Node;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();
  readonly #subscription: { dispose(): void };

  constructor(text: string, options: SessionOptions) {
    this.#options = options;
    this.#synced = this.#latest = this.#read(text);
    this.#subscription = options.sync.onExternalChange((changed) => this.#external(changed));
  }

  /** The document to show now. */
  get doc(): Node {
    return this.#latest;
  }

  /** The document text the host has (without edits not yet sent). */
  get text(): string {
    return sourceOf(this.#synced)!.text;
  }

  /** The document the host has (its source text and block ranges are recorded: `sourceOf`). P9: the Code view's colors, the source map. */
  get synced(): Node {
    return this.#synced;
  }

  /** True while there are edits the host doesn't have yet. */
  get pending(): boolean {
    return this.#latest !== this.#synced;
  }

  /** The canvas changed the document: send it after the pause. */
  changed(doc: Node): void {
    this.#latest = doc;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), this.#options.delay ?? SYNC_DELAY_MS);
  }

  /** Sends pending edits now; resolves when the host has them (or has refused them as stale). */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#chain = this.#chain.then(() => this.#push()).catch((error: unknown) => this.#options.onError?.(error));
    return this.#chain;
  }

  /**
   * Reads the document again with the reader `transformer` picks now (P5, R-124: the profile's gate defaults
   * changed, so the same text may parse differently). Pending typing is sent first, so nothing is lost; the cursor
   * stays in the same block. Resolves once the canvas shows the re-read document.
   */
  async reread(): Promise<void> {
    await this.flush();
    if (this.pending) return; // the edits couldn't be sent (onError reported it): keep the typing, skip this re-read
    const text = sourceOf(this.#synced)!.text;
    const doc = this.#read(text);
    const cursor = mapCursor(this.#latest, this.#options.cursor(), this.#synced, text, text, doc);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#show(doc, cursor);
  }

  /**
   * The host now has `text` because of an edit made elsewhere in this page (P9: the Code view's typing, a section moved
   * in the Outline), sent with `applyEdits`, which VS Code doesn't echo back: the canvas reads it through the same path as
   * an outside change (VS Code's text wins over canvas edits not yet sent).
   */
  accept(text: string): void {
    this.#external(text);
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#subscription.dispose();
  }

  async #push(): Promise<void> {
    while (this.#latest !== this.#synced) {
      const base = this.#synced;
      const target = this.#latest;
      const edits = diffToEdits(base, target, sourceOf(base)!.text);
      if (edits.length > 0 && (await this.#options.sync.applyEdits(edits, this.#options.sync.version)) === 'stale') return;
      // Unless an outside change replaced everything meanwhile, the host now has `target`.
      if (this.#synced === base) {
        this.#synced = target;
        if (edits.length > 0) this.#options.onSynced?.();
      }
    }
  }

  #read(text: string): Node {
    const { transformer } = this.#options;
    const doc = (typeof transformer === 'function' ? transformer(text) : transformer).parse(text);
    // New blocks are written with the file's own line ending (diffToEdits uses the one recorded here). Guessed from the text
    // alone, a blank file would get '\n' while VS Code keeps '\r\n' (Windows): VS Code would change the edit, report it as an
    // outside change, and the canvas would read the text again under the author's cursor (fix-sync-bugs, bug 5).
    const eol = this.#options.lineEnding?.();
    const info = sourceOf(doc)!;
    if (eol && info.lineEnding !== eol) recordSource(doc, { ...info, lineEnding: eol });
    return doc;
  }

  #external(text: string): void {
    const known = sourceOf(this.#synced)!.text;
    if (text === known) return;
    const doc = this.#read(text);
    const cursor = mapCursor(this.#latest, this.#options.cursor(), this.#synced, known, text, doc);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#show(doc, cursor);
  }

  /** `doc` (read from the text) shown, and held as what the host has: the very document the canvas shows (FIX-PGF). */
  #show(doc: Node, cursor: number): void {
    this.#synced = this.#latest = doc;
    const shown = this.#options.replace(doc, cursor);
    if (!shown || shown === doc || typeof (shown as Partial<Node>).eq !== 'function' || !shown.eq(doc)) return;
    recordSource(shown, sourceOf(doc)!);
    this.#synced = this.#latest = shown;
  }
}

/**
 * Where the cursor goes after the text changed from `oldText` to `newText`: the same top-level block (counted
 * from the start when the block sits before the changed text, from the end when after it), at the same
 * offset inside it, clamped. `shown` is the document the cursor is in; `synced` carries the old block ranges.
 */
export function mapCursor(shown: Node, cursor: number, synced: Node, oldText: string, newText: string, newDoc: Node): number {
  // Blocks as the block ranges count them (P18: a SECTION's box is looked through).
  const newBlocks = topBlocks(newDoc);
  if (topBlocks(shown).length === 0 || newBlocks.length === 0) return 0;
  const { index, offset } = blockAt(shown, cursor);

  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldText.length - prefix && suffix < newText.length - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;

  const ranges = sourceOf(synced)?.blocks ?? [];
  const oldCount = ranges.length;
  const unchangedBefore = ranges.filter((r) => r.to <= prefix).length;
  const unchangedAfter = ranges.filter((r) => r.from >= oldText.length - suffix).length;
  const b = Math.min(index, oldCount - 1);
  let target: number;
  if (b < unchangedBefore) target = b;
  else if (b >= oldCount - unchangedAfter) target = b + (newBlocks.length - oldCount);
  else target = b;
  target = Math.max(0, Math.min(target, newBlocks.length - 1));

  const block = newBlocks[target]!;
  return block.pos + Math.min(offset, block.node.nodeSize - 1);
}

/** The top-level block containing `pos`, and `pos`'s offset from that block's start. */
function blockAt(doc: Node, pos: number): { index: number; offset: number } {
  const blocks = topBlocks(doc);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (pos < b.pos + b.node.nodeSize || i === blocks.length - 1) return { index: i, offset: Math.max(0, pos - b.pos) };
  }
  return { index: 0, offset: 0 };
}
