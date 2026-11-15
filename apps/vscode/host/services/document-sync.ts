// IDocumentSync, host side (ADR-0013): applies the webview's minimal edits to the real TextDocument, refuses
// edits computed against an old version, and reports every change that didn't come from the webview (git
// checkout, another editor, VS Code's undo/redo) so the webview can re-read the text.
import * as vscode from 'vscode';
import type { TextEdit } from '@pagemd-editor/core';
import type { ApplyEditsResult, LineEnding } from '../../shared/protocol.ts';

/** The document's line ending: VS Code turns every line break an edit inserts into this one (protocol v11). */
export function eolOf(document: vscode.TextDocument): LineEnding {
  return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/** Applies sorted, non-overlapping edits to a string (what VS Code will make of the document). */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return out + text.slice(cursor);
}

/** Sorted by position, inside the text, and not overlapping: what `TextEdit` promises (R-74 c). */
function wellFormed(edits: readonly TextEdit[], length: number): boolean {
  let end = 0;
  return edits.every((e) => {
    const ok = Number.isInteger(e.from) && Number.isInteger(e.to) && e.from >= end && e.to >= e.from && e.to <= length && typeof e.text === 'string';
    end = e.to;
    return ok;
  });
}

export class HostDocumentSync implements vscode.Disposable {
  readonly #document: vscode.TextDocument;
  readonly #onExternal: (text: string, version: number, eol: LineEnding) => void;
  readonly #subscription: vscode.Disposable;
  /** While our own edit is being applied: the text it will produce. */
  #expected: string | undefined;
  /** The line ending the webview was last told. */
  #eol: LineEnding;

  constructor(document: vscode.TextDocument, onExternal: (text: string, version: number, eol: LineEnding) => void) {
    this.#document = document;
    this.#onExternal = onExternal;
    this.#eol = eolOf(document);
    this.#subscription = vscode.workspace.onDidChangeTextDocument((e) => this.#changed(e));
  }

  async applyEdits(edits: readonly TextEdit[], version: number): Promise<ApplyEditsResult> {
    const doc = this.#document;
    const before = doc.getText();
    if (version !== doc.version || !wellFormed(edits, before.length)) return this.#stale();
    if (edits.length === 0) return { status: 'ok', version: doc.version };

    const edit = new vscode.WorkspaceEdit();
    for (const e of edits) edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.from), doc.positionAt(e.to)), e.text);
    this.#expected = applyTextEdits(before, edits);
    try {
      if (!(await vscode.workspace.applyEdit(edit))) return this.#stale();
    } finally {
      this.#expected = undefined;
    }
    return { status: 'ok', version: doc.version };
  }

  dispose(): void {
    this.#subscription.dispose();
  }

  #stale(): ApplyEditsResult {
    return { status: 'stale', text: this.#document.getText(), version: this.#document.version, eol: (this.#eol = eolOf(this.#document)) };
  }

  #changed(e: vscode.TextDocumentChangeEvent): void {
    if (e.document !== this.#document) return;
    const eol = eolOf(e.document);
    // No text changed (a dirty-mark change), unless the line ending did (Change End of Line Sequence on a file with no line break).
    if (e.contentChanges.length === 0 && eol === this.#eol) return;
    this.#eol = eol;
    const text = e.document.getText();
    // Our own edit, echoed back: the webview already has it. Anything else is news to the webview.
    if (this.#expected !== undefined && text === this.#expected) return;
    this.#onExternal(text, e.document.version, eol);
  }
}
