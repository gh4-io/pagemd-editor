// ILinks, host side (ADR-0013). The href comes from document content, so the host decides what it may open:
// web and mail links go to the system browser or mail app, relative paths open in VS Code. Everything else
// (command:, file:, javascript:, absolute paths, …) is refused.
import * as vscode from 'vscode';

export type LinkTarget = { kind: 'external'; uri: string } | { kind: 'file'; path: string } | { kind: 'refused'; reason: string };

/** Decides what to do with an href found in the document. Pure, so it can be tested without VS Code. */
export function classifyLink(href: string): LinkTarget {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return { kind: 'refused', reason: 'no target outside this document' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return { kind: 'external', uri: trimmed };
  if (scheme !== undefined && !/^[a-z]$/i.test(scheme)) return { kind: 'refused', reason: `'${scheme}:' links are not opened` };
  if (scheme !== undefined || trimmed.startsWith('/') || trimmed.startsWith('\\')) return { kind: 'refused', reason: 'only paths relative to the document are opened' };
  const path = decodePath(trimmed.replace(/[?#].*$/, ''));
  return path ? { kind: 'file', path } : { kind: 'refused', reason: 'not a valid path' };
}

function decodePath(path: string): string | undefined {
  try {
    return decodeURIComponent(path).replace(/\\/g, '/');
  } catch {
    return undefined;
  }
}

export class HostLinks {
  readonly #document: vscode.Uri;
  readonly #log: (line: string) => void;

  constructor(document: vscode.Uri, log: (line: string) => void) {
    this.#document = document;
    this.#log = log;
  }

  open(href: string): void {
    const target = classifyLink(href);
    if (target.kind === 'external') void vscode.env.openExternal(vscode.Uri.parse(target.uri));
    else if (target.kind === 'file') void vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(this.#document, '..', target.path));
    else this.#log(`Link not opened (${target.reason}): ${href}`);
  }
}
