// Types for the parts of @pagemd/packs the editor uses (plain JavaScript, no type files of their own; phase L3).
// Source: pagemd-common packages/packs/src/{verify,install,sources,zip}.js.

declare module '@pagemd/packs' {
  export const EXIT: Readonly<{ ok: 0; refused: 1; usage: 2; wouldOverwrite: 3; existsElsewhere: 4 }>;
  export class PackError extends Error {
    constructor(message: string, code?: number);
    code: number;
  }
  export interface VerifiedPack {
    id: string;
    files: { name: string; data: Uint8Array }[];
    manifest: { id: string; version?: string | null; type?: string | null; look?: string | null; pagemdMinVersion?: string | null; requires?: string | null };
  }
  export function verifyPack(zip: Uint8Array, expectedSha256: string): VerifiedPack;
  export interface InstallResult { id: string; version: string | null; written: number; unchanged: number; removed: number; target: string }
  export function installPack(
    pack: VerifiedPack,
    target: string,
    options?: { dryRun?: boolean; elsewhere?: string[]; pagemdVersion?: string; onWrite?: (name: string, index: number) => void },
  ): InstallResult;
  export function uninstallPack(id: string, target: string): { id: string; removed: number; kept: string[]; target: string };
  export interface InstalledPack {
    id: string;
    version: string | null;
    built: string | null;
    type: string | null;
    look: string | null;
    pagemdMinVersion: string | null;
    requires: string | null;
    profile: string | null;
    changed: string[];
    missing: string[];
    installing: boolean;
    keptAfterUninstall: boolean;
  }
  export function listInstalled(target: string): InstalledPack[];
  export function findElsewhere(id: string, folders: (string | null | undefined)[], target: string): { path: string; pointer: boolean }[];
  export function compareVersions(a: string, b: string): number;
  export function otherProfileFolders(options?: { projectRoot?: string | null; homePath?: string; cliPath?: string | null }): string[];
  export function defaultTarget(options?: { env?: Record<string, string | undefined>; platform?: string; homePath?: string }): string;
  export interface IndexPack { id: string; type?: string; look?: string; version?: string; file: string; size?: number; sha256: string }
  export interface PackIndex {
    schema?: number;
    version?: string;
    built?: string;
    release?: { repo?: string; tag?: string; indexAsset?: string };
    latest: Record<string, { version?: string; file?: string }>;
    packs: IndexPack[];
  }
  export const MAX_INDEX: number;
  export const MAX_PACK: number;
  export function parseIndex(text: string, where?: string): PackIndex;
  export function latestPacks(index: PackIndex, compare: (a: string, b: string) => number): IndexPack[];
  // zip.js (used by the editor's tests to make a hostile pack)
  export function readZip(zip: Uint8Array): { name: string; data: Uint8Array; isDir: boolean }[];
  export function writeZip(files: { name: string; data: Uint8Array }[]): Uint8Array;
}
