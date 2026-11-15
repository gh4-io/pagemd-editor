// The FileSystem port (P2): the few file operations the host services need, over vscode.workspace.fs.
// Services take this port rather than calling workspace.fs, so tests can hand them an in-memory one.
import * as vscode from 'vscode';

export interface FileSystem {
  exists(uri: vscode.Uri): Promise<boolean>;
  createDirectory(uri: vscode.Uri): Promise<void>;
  writeFile(uri: vscode.Uri, bytes: Uint8Array): Promise<void>;
}

/** The port plus reading a file (P12: the side file is read; the services written earlier never needed it). */
export interface ReadingFileSystem extends FileSystem {
  /** The file's bytes; rejects when there is no such file. */
  readFile(uri: vscode.Uri): Promise<Uint8Array>;
}

/** Reading plus a file's size (P15: a picture read for a pixel edit is at most 50 MB, R-196). */
export interface SizedFileSystem extends ReadingFileSystem {
  /** The file's size in bytes; rejects when there is no such file. */
  size(uri: vscode.Uri): Promise<number>;
}

export const workspaceFileSystem: SizedFileSystem = {
  async exists(uri) {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (uri) => Promise.resolve(vscode.workspace.fs.readFile(uri)),
  size: async (uri) => (await vscode.workspace.fs.stat(uri)).size,
  createDirectory: (uri) => Promise.resolve(vscode.workspace.fs.createDirectory(uri)),
  writeFile: (uri, bytes) => Promise.resolve(vscode.workspace.fs.writeFile(uri, bytes)),
};
