/// <reference path="./pagemd-modules.d.ts" />
// The Document tab's profile picker (P10, R-170; phase L2-8): every profile a document can name, from @pagemd/resolver's
// `listProfiles`, the same listing `pagemd profiles list` prints: the document folder's and the project's `profiles/` and
// `.pagemd/profiles/`, the shared profiles folder (profile packs), `~/.pagemd/profiles` and pagemd's own. A name found twice
// is listed twice and marked (R-264: the build stops on it); before L2 the picker quietly kept the later one (F4).
// Browser-safe, like the rest of style-pagemd. Also the shared folder's rule, for the host's `pagemdEnvironment()`.
import { listProfiles as listAll, sharedProfilesFolderInfo, SHARED_FOLDER_REASONS, type SharedFolderInfo } from '@pagemd/resolver';
import { portsOf } from './ports.ts';
import type { StyleEnvironment } from './types.ts';

export { sharedProfilesFolderInfo, SHARED_FOLDER_REASONS, type SharedFolderInfo };

/** Where a profile the picker offers was found. */
export type ProfileSource = 'document' | 'project' | 'workspace' | 'library' | 'home' | 'pagemd';

/** One profile the picker offers. */
export interface ProfileChoice {
  /** The name written into the frontmatter (`profile: <name>`). */
  name: string;
  description: string | null;
  /**
   * Where it was found: the document's folder, the project's `profiles/` or `.pagemd/profiles/`, the shared profiles folder
   * (`library`: a profile pack), `~/.pagemd/profiles` (`home`) or pagemd's own.
   */
  source: ProfileSource;
  path: string;
  /** A profile pack's version (its `<name>/manifest.json`). */
  version?: string;
  /** The other files with this name: a build naming it stops ("found twice"). Empty when the name is unique. */
  duplicates: string[];
}

const SOURCE_OF: Readonly<Record<string, ProfileSource>> = { document: 'document', project: 'project', workspace: 'workspace', shared: 'library', home: 'home', pagemd: 'pagemd' };

export async function listProfiles(documentPath: string, env: StyleEnvironment): Promise<ProfileChoice[]> {
  const entries = await listAll({ documentPath, cliPath: env.pagemdPath }, portsOf(documentPath, env));
  return entries.map((e) => ({
    name: e.name,
    description: e.description ?? null,
    source: SOURCE_OF[e.tier] ?? 'project',
    path: e.path,
    ...(e.version ? { version: e.version } : {}),
    duplicates: e.duplicates,
  }));
}
