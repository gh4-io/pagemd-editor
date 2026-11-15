// ISidecar, host side (P12, ADR-0015, R-180): the review comments' side file `.pagemd/comments/<doc>.json` next to the
// document (`<doc>` is the file name without its extension, like the document's layout file, R-129). It reads and writes
// JSON and nothing more: what the JSON means is plugin-comments' business. A file that is not valid JSON fails the read with
// the reason, so the webview never writes over it.
import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { Json, SidecarKind } from '../../shared/protocol.ts';
import type { ReadingFileSystem } from './file-system.ts';

/** Where a document's side files live, relative to the document's folder. */
export const SIDECAR_FOLDER = '.pagemd/comments';

/** `.pagemd/comments/<doc>.json` for the document file at `documentPath` (a URI path). */
export function sidecarName(documentPath: string): string {
  const base = posix.basename(documentPath);
  const dot = base.lastIndexOf('.');
  return `${dot > 0 ? base.slice(0, dot) : base}.json`;
}

export class HostSidecar {
  readonly #document: vscode.Uri;
  readonly #fs: ReadingFileSystem;
  /** Writes happen one at a time, in the order they came. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(document: vscode.Uri, fs: ReadingFileSystem) {
    this.#document = document;
    this.#fs = fs;
  }

  /** The side file itself. */
  get uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.#document, '..', SIDECAR_FOLDER, sidecarName(this.#document.path));
  }

  /** The folder the file sits in (watched for changes). */
  get folder(): vscode.Uri {
    return vscode.Uri.joinPath(this.#document, '..', SIDECAR_FOLDER);
  }

  /** The parsed JSON, null for no file; throws (with the reason) for a file that is not JSON. */
  async read(kind: SidecarKind): Promise<Json> {
    this.#check(kind);
    const uri = this.uri;
    if (!(await this.#fs.exists(uri))) return null;
    const text = new TextDecoder().decode(await this.#fs.readFile(uri)).replace(/^﻿/, '');
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as Json;
    } catch (error) {
      throw new Error(`${SIDECAR_FOLDER}/${sidecarName(this.#document.path)} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Writes `data` as two-space JSON with a final newline; a file that used CRLF keeps it. */
  write(kind: SidecarKind, data: Json): Promise<void> {
    this.#check(kind);
    const job = this.#queue.then(() => this.#write(data));
    this.#queue = job.catch(() => undefined);
    return job;
  }

  async #write(data: Json): Promise<void> {
    const uri = this.uri;
    let text = `${JSON.stringify(data, null, 2)}\n`;
    if (await this.#fs.exists(uri)) {
      const old = new TextDecoder().decode(await this.#fs.readFile(uri));
      if (old.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
    } else {
      await this.#fs.createDirectory(this.folder);
    }
    await this.#fs.writeFile(uri, new TextEncoder().encode(text));
  }

  #check(kind: SidecarKind): void {
    if (kind !== 'comments') throw new Error(`There is no side file of kind "${String(kind)}".`);
  }
}
