// IAssets, host side (ADR-0013; image inventory C2). Every path it returns follows one contract: relative to
// the `.md` file, forward slashes, never a leading '/'. Its first user is image paste (P11); P2 fixes the contract.
import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { FileSystem, SizedFileSystem } from './file-system.ts';

/** Where pasted images go unless the setting `pagemdEditor.imageFolder` says otherwise, relative to the document (ADR-0008). */
export const ASSET_FOLDER = '.pagemd/assets/img';

/**
 * The folder the setting names (P11, R-174): a path below the document's folder, forward slashes, no `./`, no trailing slash.
 * Anything else (empty, absolute, `..` anywhere, a drive letter) is refused: the canvas can only show images under the
 * document's folder, and pagemd reads `src` relative to it. `invalid` is the text refused, for the warning.
 */
export function resolveImageFolder(value: unknown): { folder: string; invalid?: string } {
  if (typeof value !== 'string' || value.trim() === '') return { folder: ASSET_FOLDER };
  const cleaned = value.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const parts = cleaned.split('/');
  const bad = cleaned === '' || cleaned === '.' || cleaned.startsWith('/') || /^[a-z]:/i.test(cleaned) || parts.some((p) => p === '..' || p === '' || p === '.');
  return bad ? { folder: ASSET_FOLDER, invalid: value } : { folder: cleaned };
}

/** A safe file name: no folders, only letters, digits, '.', '_' and '-'; never empty or hidden. */
export function cleanAssetName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const dot = cleaned.lastIndexOf('.');
  return dot <= 0 ? cleaned || 'image' : cleaned;
}

/**
 * `file` relative to the folder of `document`, both URI paths ('/c:/docs/a.md'), in the contract's form; or
 * undefined when there is no relative path (another drive).
 */
export function documentRelative(documentPath: string, filePath: string): string | undefined {
  // Windows drive letters ('/c:' vs '/C:') name the same drive: compare and join them in one case.
  const lowerDrive = (p: string): string => p.replace(/^\/[a-z]:/i, (d) => d.toLowerCase());
  const drive = (p: string): string => /^\/[a-z]:/i.exec(p)?.[0].toLowerCase() ?? '';
  if (drive(documentPath) !== drive(filePath)) return undefined;
  const relative = posix.relative(posix.dirname(lowerDrive(documentPath)), lowerDrive(filePath));
  return relative === '' || relative.startsWith('/') ? undefined : relative;
}

/** The picture types `readAsset` reads (R-196): what a pixel edit can decode. SVG is drawn, not pixels, so it is not read. */
export const READABLE_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];

/** The largest picture `readAsset` reads (R-196): 50 MB. */
export const MAX_READ_BYTES = 50 * 1024 * 1024;

/** What `readAsset` needs besides writing: reading a file and its size, and the folders the canvas may show images from. */
export interface AssetReading {
  fs: SizedFileSystem;
  /** The folders the canvas can show images from besides the document's own: the workspace folders (read at each call). */
  roots(): readonly vscode.Uri[];
  /** File names compare without case (Windows, macOS's default file system). */
  ignoreCase?: boolean;
}

/**
 * The document-relative image path `path` as a file path below the document's folder, or the reason it is refused (R-196).
 * The text's path is a URL: `%20` is a space, and a `?…` or `#…` ending is not part of the file name.
 */
export function readablePath(path: string): { segments: string[] } | { refused: string } {
  const raw = path.trim().replace(/[?#].*$/, '');
  if (raw === '') return { refused: 'no image path' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return { refused: `"${path}" is not a path relative to the document` };
  let decoded: string;
  try {
    decoded = decodeURI(raw);
  } catch {
    decoded = raw;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(decoded)?.[1]?.toLowerCase() ?? '';
  if (!READABLE_IMAGE_EXTENSIONS.includes(extension)) return { refused: `"${path}" is not a picture this editor can change (${READABLE_IMAGE_EXTENSIONS.join(', ')})` };
  return { segments: decoded.replace(/\\/g, '/').split('/') };
}

/** Is `uri` inside the folder `root` (same scheme and authority; the path below it)? */
export function isInside(uri: vscode.Uri, root: vscode.Uri, ignoreCase = false): boolean {
  if (uri.scheme !== root.scheme || uri.authority !== root.authority) return false;
  const fold = (p: string): string => (ignoreCase ? p.toLowerCase() : p);
  const base = fold(root.path.replace(/\/+$/, ''));
  return fold(uri.path).startsWith(`${base}/`);
}

export class HostAssets {
  readonly #document: vscode.Uri;
  readonly #fs: FileSystem;
  readonly #folder: () => string;
  readonly #reading: AssetReading | undefined;
  /** Writes happen one at a time: two files with the same name must not both see the name as free (never overwrite). */
  #queue: Promise<unknown> = Promise.resolve();

  /** `folder` is read at every write (the setting can change while the editor is open). Without `reading`, readAsset refuses. */
  constructor(document: vscode.Uri, fs: FileSystem, folder: () => string = () => ASSET_FOLDER, reading?: AssetReading) {
    this.#document = document;
    this.#fs = fs;
    this.#folder = folder;
    this.#reading = reading;
  }

  /**
   * P15 (R-196): the bytes of the picture at the document-relative `path`, for a pixel edit. Only what the canvas can already
   * show: inside the document's folder or a workspace folder (not pagemd's own folder), a picture file, at most 50 MB.
   */
  async readAsset(path: string): Promise<Uint8Array> {
    const reading = this.#reading;
    if (!reading) throw new Error('Reading pictures is not available here.');
    const checked = readablePath(path);
    if ('refused' in checked) throw new Error(`Not read: ${checked.refused}.`);
    const folder = vscode.Uri.joinPath(this.#document, '..');
    const file = vscode.Uri.joinPath(folder, ...checked.segments);
    const roots = [folder, ...reading.roots()];
    if (!roots.some((root) => isInside(file, root, reading.ignoreCase))) throw new Error(`Not read: "${path}" is outside the document's folder and the workspace.`);
    let size: number;
    try {
      size = await reading.fs.size(file);
    } catch {
      throw new Error(`Not read: "${path}" was not found.`);
    }
    if (size > MAX_READ_BYTES) throw new Error(`Not read: "${path}" is larger than 50 MB.`);
    // A plain Uint8Array: VS Code's file system answers with a Node Buffer, whose own toJSON() runs before VS Code's message
    // serializer can send it as binary, so it would reach the webview as { type: 'Buffer', data: [...] } (test:vscode step 17).
    const bytes = await reading.fs.readFile(file);
    return bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes);
  }

  /** Writes `bytes` into the image folder under a clean, unused name; returns its document-relative path. */
  writeAsset(bytes: Uint8Array, name: string): Promise<string> {
    const job = this.#queue.then(() => this.#write(bytes, name));
    this.#queue = job.catch(() => undefined);
    return job;
  }

  async #write(bytes: Uint8Array, name: string): Promise<string> {
    const assetFolder = this.#folder();
    const folder = vscode.Uri.joinPath(this.#document, '..', assetFolder);
    await this.#fs.createDirectory(folder);
    const clean = cleanAssetName(name);
    const dot = clean.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ''];
    let file = clean;
    for (let n = 1; await this.#fs.exists(vscode.Uri.joinPath(folder, file)); n++) file = `${stem}-${n}${ext}`;
    await this.#fs.writeFile(vscode.Uri.joinPath(folder, file), bytes);
    return `${assetFolder}/${file}`;
  }

  /** Lets the author pick a file; its document-relative path, or undefined (cancelled, or on another drive). */
  async pickFile(filter?: string[]): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: vscode.Uri.joinPath(this.#document, '..'),
      ...(filter && filter.length > 0 ? { filters: { Files: filter } } : {}),
    });
    const file = picked?.[0];
    if (!file || file.scheme !== this.#document.scheme || file.authority !== this.#document.authority) return undefined;
    return documentRelative(this.#document.path, file.path);
  }
}
