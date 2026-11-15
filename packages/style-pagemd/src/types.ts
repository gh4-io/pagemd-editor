/// <reference path="./pagemd-modules.d.ts" />
// The shapes style-pagemd takes and gives (P5). Its own file so index.ts and layout-file.ts share them without
// importing each other.
import type { FileSystem, Logger, PathFunctions, ResolvedDocument } from '@pagemd/resolver';
import type { FieldSpec, PageGeometry, ResolvedStyles } from '@pagemd-editor/core';

/** Where style-pagemd reads files, and how it names them. The host fills it in (amendment 6). */
export interface StyleEnvironment {
  /** The resolver's file system port; methods may answer with Promises. */
  fs: FileSystem;
  /** pagemd's own folder (profiles/, layouts/, styles/, templates/): the resolver's cliPath = defaultsPath (R-128). */
  pagemdPath: string;
  /** The user's home folder (`~/.pagemd/`, tier 4; tier 5 for profiles). */
  homePath?: string;
  /** Phase L2: the shared profiles folder (profile packs; `$PAGEMD_CONFIG_DIR/profiles` when set), searched for profiles after the
   * project and before `~/.pagemd/profiles`. The host fills it from `pagemdEnvironment()`; absent: no shared tier. */
  sharedProfilesPath?: string;
  /** The working folder for relative paths; the document's folder when absent (amendment 6). */
  cwd?: string;
  /** Path functions (the host passes `node:path`); POSIX when absent. */
  path?: PathFunctions;
  /** The resolver's profile cache, shared for a session; clear it when a profile changes (amendment 6). */
  cache?: Map<unknown, unknown>;
  /** The resolver's logger factory (the host sends it to an Output channel). */
  log?: (category: string) => Logger;
}

export interface StyleDocument {
  /** The document's file path; null for a document that isn't a file (e.g. a `git diff` view): plain styles. */
  path: string | null;
  /** Its text as it is now (unsaved edits included): the frontmatter names the profile and `styles:`. */
  text: string;
}

/** Why the canvas shows what it shows (amendment 9's data; the host turns these into page notes / status bar). */
export type StyleNoteKind =
  | 'using-default-layout'
  | 'not-a-file'
  | 'frontmatter-error'
  | 'profile-not-found'
  | 'profile-error'
  | 'missing-stylesheet'
  | 'missing-pagemd-files'
  | 'css-error'
  /** P18: the profile's template has no `{{content}}`, so the canvas shows the text without it. */
  | 'template-without-content'
  | 'import-dropped';

export interface StyleNote {
  kind: StyleNoteKind;
  message: string;
  /** The file or name concerned, as written (a stylesheet path, a profile name, an @import). */
  source?: string;
}

/** What create-layout needs from the current resolution (layout-file.ts). */
export interface LayoutBasis {
  documentPath: string;
  documentDir: string;
  /**
   * The profile as the document asks for it (frontmatter `profile`, else the default): a name or a path. The
   * per-document profile `extends` exactly this (ResolvedStyles.profile is the profile's `id` instead, R-139).
   */
  profileId: string;
  /** The file of the named profile (the first in its `extends` chain). */
  profilePath: string | null;
  /** The layout layer's text: the profile's layout file, or pagemd's default layout when `usingDefault`. */
  layoutText: string | null;
  layout: { path: string; bundled: boolean } | null;
  usingDefault: boolean;
  page: PageGeometry;
}

export interface StyleResolution {
  /** null: plain styles (the notes say why). */
  styles: ResolvedStyles | null;
  /** The profile's defaults for the syntax gates (e.g. `fancy_lists`), layered under the frontmatter (R-124). */
  gateDefaults: Record<string, unknown>;
  notes: StyleNote[];
  /** Every file the answer depends on (watch them, amendment 8), also when the styles fell back to plain. */
  sources: string[];
  /** Present when the styles resolved: what create-layout starts from. */
  basis?: LayoutBasis;
  /** What the profile and template say about the properties (P8): empty when no profile was found. */
  properties: PropertiesInfo;
  /**
   * P25: what the Files in Use report is built from (`filesInUse`), kept with the resolution so the report never resolves again.
   * Host-side only: it is not part of the styles message.
   */
  trace?: TraceInput;
}

/** P25: one stylesheet as theme-kit layered it (lowest priority first), with the text it was read from. */
export interface TraceSheet {
  layer: 'base' | 'primary' | 'layout' | 'syntax' | 'profile' | 'frontmatter';
  /** null: the CSS theme-kit made from the document's properties. */
  path: string | null;
  content: string;
  /** As written (a profile's `resources.css` entry, a `styles:` entry). */
  source?: string;
}

/** P25: the ingredients of the Files in Use report. */
export interface TraceInput {
  documentPath: string | null;
  /** The frontmatter as written (normalized, no defaults); null when it could not be read. */
  frontmatter: Record<string, unknown> | null;
  resolved?: ResolvedDocument;
  /** Why the resolution stopped early (frontmatter error, profile not found). */
  failure?: StyleNote;
  /** Every layered stylesheet in cascade order, lowest priority first; absent when the CSS was never built. */
  sheets?: TraceSheet[];
  usingDefault?: boolean;
  defaultLayoutPath?: string;
  /** The template's text as read ('' for none). */
  templateText?: string;
  /** FIX-template-asset-paths (R-259): every relative path the template, the layout and the profile's CSS name, and where each was found. */
  assets?: AssetUse[];
}

/** One relative path in a template or stylesheet (@pagemd/resolver's TemplateAsset), with the file that names it. */
export interface AssetUse {
  written: string;
  outcome: 'file' | 'document' | 'missing';
  path: string | null;
  tried: string[];
  rewritten: string | null;
  /** The template or stylesheet that names it. */
  file: string;
  from: 'template' | 'layout' | 'stylesheet';
}

/** The Document tab's hints (P8): the same shape as the protocol's PropertiesInfo. */
export interface PropertiesInfo {
  required: string[];
  shownOnPage: string[];
  profileFields: FieldSpec[];
  defaults: Record<string, unknown>;
}

export const NO_PROPERTIES: PropertiesInfo = Object.freeze({ required: [], shownOnPage: [], profileFields: [], defaults: {} }) as PropertiesInfo;
