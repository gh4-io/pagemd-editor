/// <reference path="./pagemd-modules.d.ts" />
// The host half of plugin-diagnostics (P14, ADR-0017): run the checks the document's profile asks for with
// @pagemd/validate, the rules `pagemd validate` runs (I7: no checks of our own), over the host's file system. With no
// `validation` setting in the profile there are none (R-30). Browser-safe like style-pagemd: the file system and the
// path functions are passed in, so this file has no Node import (the host gives it VS Code's file API and `node:path`).
import { posix, type FileSystem, type Logger, type PathFunctions, type Ports } from '@pagemd/resolver';
import { validate, type Diagnostic as PagemdDiagnostic, type ValidationResult } from '@pagemd/validate';
import type { Diagnostic } from '@pagemd-editor/core';

export type { PagemdDiagnostic, ValidationResult };

/** Where the checks read files (the same environment style-pagemd gets). */
export interface CheckEnvironment {
  /** The resolver's file system port; methods may answer with Promises. */
  fs: FileSystem;
  /** pagemd's own folder (the resolver's cliPath, R-128). */
  pagemdPath: string;
  /** The user's home folder (`~/.pagemd/`, the search's tier 4; tier 5 for profiles). */
  homePath?: string;
  /** Phase L2: the shared profiles folder (profile packs), the search's tier 4 for profiles; from the host's `pagemdEnvironment()`. */
  sharedProfilesPath?: string;
  /** The working folder; the document's folder when absent. */
  cwd?: string;
  /** Path functions (the host passes `node:path`); POSIX when absent. */
  path?: PathFunctions;
  /** The resolver's profile cache; clear it when a profile changes. */
  cache?: Map<unknown, unknown>;
  log?: (category: string) => Logger;
}

/** What a check answers: @pagemd/validate's result, or `null` for a document that isn't a file (nothing to check). */
export type CheckResult = ValidationResult | null;

/** Runs the profile's checks on the document as it is now (unsaved edits included). Never throws for a document problem. */
export async function checkDocument(doc: { path: string | null; text: string }, env: CheckEnvironment): Promise<CheckResult> {
  if (!doc.path) return null;
  const P = env.path ?? posix;
  const ports: Ports = {
    fs: env.fs,
    env: {
      defaultsPath: env.pagemdPath,
      cwd: env.cwd ?? P.dirname(doc.path),
      path: P,
      ...(env.homePath ? { homePath: env.homePath } : {}),
      ...(env.sharedProfilesPath ? { sharedProfilesPath: env.sharedProfilesPath } : {}),
    },
    ...(env.log ? { log: env.log } : {}),
    ...(env.cache ? { cache: env.cache } : {}),
  };
  return validate({ path: doc.path, text: doc.text }, { cliPath: env.pagemdPath }, ports);
}

/** The character offset where each line of `text` starts. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** The text range of a 0-based line, without its line ending (an empty range at the end for a line past the text). */
export function lineRange(text: string, starts: number[], line: number): { from: number; to: number } {
  if (line >= starts.length) return { from: text.length, to: text.length };
  const from = starts[line]!;
  let to = line + 1 < starts.length ? starts[line + 1]! - 1 : text.length;
  if (to > from && text[to - 1] === '\r') to--;
  return { from, to };
}

/** The `code` the editor shows: `<level>/<code>` (e.g. `meta/missing-required-field`). */
export const codeOf = (d: PagemdDiagnostic): string => `${d.level}/${d.code}`;

/**
 * The checks as the core's `Diagnostic` (character positions in `text`, ADR-0013), for the canvas's hints: a problem on a
 * line of the document covers that line; a problem elsewhere (the profile, the template, a stylesheet; a missing required
 * field) sits at the very start, where the canvas shows no hint (the Problems panel shows it).
 */
export function toCoreDiagnostics(text: string, diagnostics: readonly PagemdDiagnostic[]): Diagnostic[] {
  const starts = lineStarts(text);
  return diagnostics.map((d) => {
    const line = d.where?.line;
    const { from, to } = typeof line === 'number' && line > 0 ? lineRange(text, starts, line) : { from: 0, to: 0 };
    return { from, to, severity: d.severity, message: d.message, code: codeOf(d), source: 'pagemd' };
  });
}
