// Test fixtures for style-pagemd: pagemd's own folder read into an in-memory file system (P5), and Node's file
// system as the resolver's port (the corpus check). pagemd and pagemd-common are only read, never written.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryFileSystem, type FileSystem } from '@pagemd/resolver';
import type { StyleEnvironment } from '../src/index.ts';

/** The pagemd checkout: its root holds profiles/, layouts/, styles/ and templates/, as an install does. */
export const PAGEMD_ROOT = fileURLToPath(new URL('../../../../pagemd/', import.meta.url));
/** @pagemd/theme-kit's defaults/ folder (C5; R-128 grows it in part 2 of P5). */
export const THEME_KIT_DEFAULTS = fileURLToPath(new URL('../../../../pagemd-common/packages/theme-kit/defaults/', import.meta.url));

/** Every file under `dir` (recursively), as `prefix/relative/path` → text. */
export function filesUnder(dir: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[`${prefix}/${path.relative(dir, full).split(path.sep).join('/')}`] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** pagemd's bundled files (profiles, layouts, styles, templates) under `/pagemd` in memory. */
export function pagemdFiles(root = PAGEMD_ROOT): Record<string, string> {
  return Object.assign({}, ...['profiles', 'layouts', 'styles', 'templates'].map((folder) => filesUnder(path.join(root, folder), `/pagemd/${folder}`)));
}

/** An in-memory environment: pagemd at /pagemd, the given project files, POSIX paths, async file system. */
export function memoryEnv(files: Record<string, string>, extra: Partial<StyleEnvironment> = {}): StyleEnvironment & { memory: ReturnType<typeof createMemoryFileSystem> } {
  const memory = createMemoryFileSystem({ ...pagemdFiles(), ...files });
  return { fs: memory.async(), pagemdPath: '/pagemd', homePath: '/home/user', memory, ...extra };
}

/** Node's file system as the resolver's async port (what the host's adapter does over workspace.fs). */
export const nodeFs: FileSystem = {
  async exists(p) {
    return existsSync(p);
  },
  readText: (p) => fsp.readFile(p, 'utf8'),
  async stat(p) {
    try {
      const s = statSync(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  list: (p) => fsp.readdir(p),
};
