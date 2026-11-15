// Files in Use, host side (P25, R-242; protocol v12). The webview asks for the report (`filesInUse`) and asks to show one of its files
// (`openFile`). The webview shows document content, so it is never trusted with a path of its own: only a file of the last report
// this host sent is opened (AD-P25-03). A file opens in the editor group beside the document, as a preview tab, at the rule's line;
// Reveal shows it in VS Code's Explorer when it is in the workspace, else in the system's file manager (AD-P25-04). Nothing is written.
import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import type { FilesInUse } from '@pagemd-editor/core';

/** Every path a report lets the webview open: its files, and both files of a duplicate name. */
export function openablePaths(report: FilesInUse): string[] {
  const out = new Set<string>();
  for (const file of report.files) if (file.path) out.add(file.path);
  for (const problem of report.problems) for (const path of problem.paths ?? []) out.add(path);
  return [...out];
}

const key = (path: string): string => {
  const normal = nodePath.normalize(path);
  return process.platform === 'win32' || process.platform === 'darwin' ? normal.toLowerCase() : normal;
};

export class HostFiles {
  readonly #log: (line: string) => void;
  #allowed = new Set<string>();

  constructor(log: (line: string) => void) {
    this.#log = log;
  }

  /** Remembers what the last report lets the webview open (and answers the report). */
  remember(report: FilesInUse): FilesInUse {
    this.#allowed = new Set(openablePaths(report).map(key));
    return report;
  }

  /** Opens (or reveals) a file of the last report; anything else is refused and logged. Answers whether it was done. */
  async open(request: { path: unknown; line?: unknown; reveal?: unknown }): Promise<boolean> {
    const path = typeof request.path === 'string' ? request.path : '';
    if (!path || !nodePath.isAbsolute(path) || !this.#allowed.has(key(path))) {
      this.#log(`Files in Use: not opened (not a file of the last report): ${path || String(request.path)}`);
      return false;
    }
    const uri = vscode.Uri.file(path);
    if (request.reveal === true) {
      const inWorkspace = vscode.workspace.getWorkspaceFolder(uri) !== undefined;
      await vscode.commands.executeCommand(inWorkspace ? 'revealInExplorer' : 'revealFileInOS', uri);
      return true;
    }
    const line = typeof request.line === 'number' && Number.isInteger(request.line) && request.line > 0 ? request.line - 1 : undefined;
    const options: vscode.TextDocumentShowOptions = { viewColumn: vscode.ViewColumn.Beside, preview: true, ...(line !== undefined ? { selection: new vscode.Range(line, 0, line, 0) } : {}) };
    await vscode.commands.executeCommand('vscode.open', uri, options);
    return true;
  }
}
