// Types for the pagemd-common packages style-pagemd uses (plain JavaScript, no type files of their own; P5,
// amendment 4). Only what style-pagemd calls is declared. Source: pagemd-common packages/resolver/src
// (index.js, ports.js, resolve.js, memory-fs.js), packages/theme-kit/src (build.js, geometry.js) and
// packages/meta/src (normalize.js, catalogue.js, gates.js), phases C4, C5 and C7; theme-kit's template.js, P18.
// preset-pagemd declares other parts of '@pagemd/meta' (its own file); declarations of one module merge, so only
// functions are declared here (a function declared in both files is an overload, not a clash).

declare module '@pagemd/resolver' {
  /** The resolver's file system port: every method may answer directly or with a Promise (async functions). */
  export interface FileSystem {
    exists(path: string): boolean | Promise<boolean>;
    readText(path: string): string | Promise<string>;
    stat(path: string): { isFile: boolean; isDirectory: boolean; size: number } | null | Promise<{ isFile: boolean; isDirectory: boolean; size: number } | null>;
    list(path: string): string[] | Promise<string[]>;
  }

  /** Path functions (pagemd passes `node:path`); POSIX when absent. */
  export interface PathFunctions {
    sep: string;
    isAbsolute(path: string): boolean;
    normalize(path: string): string;
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    dirname(path: string): string;
    basename(path: string, suffix?: string): string;
    extname(path: string): string;
    parse(path: string): { root: string };
    relative(from: string, to: string): string;
  }

  export interface Environment {
    homePath?: string;
    /** Phase L2: the shared profiles folder (profile packs), a search tier for profiles only. */
    sharedProfilesPath?: string;
    defaultsPath?: string;
    cwd?: string;
    path?: PathFunctions;
  }

  export interface Logger {
    trace(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }

  export interface Ports {
    fs: FileSystem;
    env?: Environment;
    log?: (category: string) => Logger;
    cache?: Map<unknown, unknown>;
  }

  /** A file resolveDocument looked for: `path` when found, `error` when not. */
  export interface ResolvedFile {
    source: string;
    path?: string;
    error?: Error & { stage?: 'tokens' | 'search'; searchedPaths?: string[] };
    skipped?: boolean;
  }

  /** A loaded, merged profile (only the parts style-pagemd reads). */
  export interface Profile {
    id?: string;
    extends?: string;
    resources?: { layout?: string; css?: string[]; template?: string };
    metadata?: { defaults?: Record<string, unknown> };
    _manifestDir?: string;
    [key: string]: unknown;
  }

  export interface ResolvedDocument {
    markdownPath: string | null;
    markdownDir: string | null;
    projectRoot: string | null;
    cliPath: string | null;
    profileId: string;
    profile: Profile;
    profileChain: { id: string; path: string | null }[];
    metadata: Record<string, unknown>;
    template: ResolvedFile & { usedDefault: boolean };
    layout: ResolvedFile | null;
    styles: ResolvedFile[];
    legacyStyles: boolean;
    frontmatterStyles: ResolvedFile[];
    system: { base: string | null; primary: string | null; syntax: string | null };
    sources: string[];
    problems: { kind: string; source: string; message: string }[];
    /** The folders the path tokens and the search start from (P25 reads them to say why a file was chosen). */
    pathContext: PathContext;
  }

  /** createPathContext()'s answer: canonical names and their legacy aliases. */
  export interface PathContext {
    workingPath: string | null;
    workspacePath: string | null;
    manifestPath: string | null;
    homePath?: string | null;
    cliPath: string | null;
    markdownDir: string | null;
    projectRoot: string | null;
    manifestDir: string | null;
    workspaceFolder: string | null;
    configDir: string | null;
  }

  /** ${token}s expanded from a path context; throws when a token has no value. */
  export function expandTokens(pathString: string, context: Partial<PathContext>, ports?: Ports): string;

  /** Which keys a profile's template, layout and CSS come from (null: none named). P25 asks it of each profile in a chain. */
  export function profileResourceKeys(profile: object): { template: string | null; layout: string | null; styles: string | null };

  export interface ResolveDocumentOptions {
    frontmatter?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    profile?: string;
    projectRoot?: string | null;
    cliPath?: string | null;
  }

  export function resolveDocument(markdownPath: string | null, options: ResolveDocumentOptions, ports: Ports): Promise<ResolvedDocument>;

  export interface SearchContext {
    workingPath?: string | null;
    workspacePath?: string | null;
    manifestPath?: string | null;
    sharedProfilesPath?: string | null;
    homePath?: string | null;
    cliPath?: string | null;
    sourceType?: 'profile' | 'frontmatter' | 'cli';
  }

  /** Phase L2: the shared profiles folder and why it was chosen (pure: the caller passes the environment). */
  export interface SharedFolderInfo {
    path: string;
    reason: 'PAGEMD_CONFIG_DIR' | 'windows' | 'wsl-user' | 'wsl-only-user' | 'macos' | 'xdg';
  }
  export function sharedProfilesFolderInfo(options: {
    platform: string;
    env?: Record<string, string | undefined>;
    homePath: string;
    exists?: (path: string) => boolean;
    list?: (path: string) => string[];
    osRelease?: string;
    path?: PathFunctions;
  }): SharedFolderInfo;
  export const SHARED_FOLDER_REASONS: Readonly<Record<SharedFolderInfo['reason'], string>>;

  /** Phase L2-7: one profile a document can name (listProfiles). */
  export interface ProfileEntry {
    name: string;
    path: string;
    tier: 'document' | 'project' | 'workspace' | 'shared' | 'home' | 'pagemd';
    folder: string;
    description: string | null;
    version?: string;
    pack?: { version?: string; built?: string; pagemdMinVersion: string | null; requires?: string };
    /** The other files with the same name (a build naming it stops: "Duplicate resources found"). */
    duplicates: string[];
  }
  /** Every profile a document can name, from every folder the search uses; duplicates reported, not hidden. */
  export function listProfiles(where: { documentPath?: string | null; projectRoot?: string | null; cliPath?: string | null }, ports: Ports): Promise<ProfileEntry[]>;

  /** The folders the search looks in, in order (5 tiers; 6 for profiles with a shared folder; no file access). */
  export function buildSearchPaths(type: 'profiles' | 'templates' | 'layouts' | 'styles', context: SearchContext, ports?: Ports): string[];

  /** One name in a list of folders: `found` when exactly one, else every match in `duplicates`. */
  export function findResourceWithDuplicateCheck(name: string, searchPaths: string[], type: 'profiles' | 'templates' | 'layouts' | 'styles', ports: Ports): Promise<{ found: string | null; duplicates: string[] }>;

  /** The project root: the nearest folder upwards with package.json, .git or .pagemdrc (or null). */
  export function findProjectRoot(start: string, ports: Ports): Promise<string | null>;

  /** `pagemd list`'s listing (P10's profile picker): `{root}/{type}/`, then `.pagemd/{type}/` when asked; later wins. */
  export function discoverResources(
    type: 'profiles' | 'templates' | 'layouts' | 'styles',
    root: string,
    options?: { includeWorkspace?: boolean },
    ports?: Ports,
  ): Promise<Array<{ name: string; path: string; source: string; id?: string; description?: string | null }>>;

  /** true when a profile name looks like a file path (has a slash, or ends in .json/.yaml/.yml). */
  export function isProfilePath(input: string): boolean;

  /** js-yaml 4's rules (dates, merges); undefined for an empty text. Throws on a YAML error. */
  export function loadYaml(text: string): unknown;

  export const posix: PathFunctions;

  /** FIX-template-asset-paths (R-259): one relative path named in a template or stylesheet, and where it was found. */
  export interface TemplateAsset {
    /** As written in the file. */
    written: string;
    /** Next to the file (rewritten), in the document's folder (left as written, the old place), or nowhere. */
    outcome: 'file' | 'document' | 'missing';
    /** The file found; null when missing. */
    path: string | null;
    /** The places looked in, in order. */
    tried: string[];
    /** What was written in its place; null when left as written. */
    rewritten: string | null;
    where: 'src' | 'srcset' | 'poster' | 'href' | 'style' | 'css';
  }

  /** A template's (`kind: 'html'`) or stylesheet's (`'css'`) relative paths, started from its folder and written from the document's. */
  export function rebaseAssetPaths(
    text: string,
    options: { kind?: 'html' | 'css'; fileDir: string; documentDir: string | null; rewrite?: boolean },
    ports: Ports,
  ): Promise<{ text: string; assets: TemplateAsset[] }>;

  /** An in-memory FileSystem (tests): POSIX paths; `async()` answers with Promises; `reads` lists every read. */
  export function createMemoryFileSystem(files?: Record<string, string>, options?: { dirs?: string[] }): FileSystem & { async(): FileSystem; reads: string[] };
}

declare module '@pagemd/theme-kit' {
  export interface Sheet {
    content: string;
    path?: string;
    source?: string;
  }

  export interface Geometry {
    width: number;
    height: number;
    margins: { top: number; right: number; bottom: number; left: number };
  }

  /** Header/footer text per position (`span` → `center` + `spansWidth`); null when nothing is set. */
  export type Running = Record<string, string | boolean> | null;

  /** P21: a named page's box written with a value theme-kit can't read (`var()`): the document's property for it. */
  export interface FromProperties { readonly fromProperties: true }
  export const FROM_PROPERTIES: FromProperties;
  export function isFromProperties(value: unknown): value is FromProperties;
  /** P21: one side's boxes on a named page: text, null (cleared) or FROM_PROPERTIES; absent = inherited. */
  export type NamedSide = { left?: string | null | FromProperties; center?: string | null | FromProperties; right?: string | null | FromProperties };
  export interface NamedBoxes { header?: NamedSide; footer?: NamedSide; first?: { header?: NamedSide; footer?: NamedSide } }

  export interface BuildStylesInput {
    base?: Sheet | string | null;
    primary?: Sheet | string | null;
    syntax?: Sheet | string | null;
    layout?: Sheet | null;
    profile?: Sheet[];
    frontmatter?: Sheet[];
    metadata?: Record<string, unknown>;
    syntaxHighlight?: boolean;
    defaultLayout?: Sheet | string | null;
    defaultsPath?: string | null;
    profileId?: string;
  }

  export interface BuiltStyles {
    css: string;
    frontmatterCSS: string;
    layers: { layer: string; content: string; source?: string; path?: string }[];
    page: Geometry;
    pageUnreadable: string[];
    namedPages: Record<string, Geometry>;
    header: Running;
    footer: Running;
    firstPage: false | { header?: false | Running; footer?: false | Running } | null;
    marginFontSize: string | null;
    /** Headers/footers written in the CSS's own margin boxes (P6, R-141). */
    layoutRunning: {
      header: Running;
      footer: Running;
      firstPage: { header?: false | Running; footer?: false | Running } | null;
      strings: Record<string, string>;
      /** P21: per page type (lower case), its own boxes; only when a named page writes one. */
      named?: Record<string, NamedBoxes>;
    };
    usingDefault: boolean;
    layout: { path: string | null; source: string | null; bundled: boolean } | null;
    sources: string[];
  }

  export function buildStyles(input: BuildStylesInput): BuiltStyles;

  /** pagemd's default files, relative to its folder (`styles/base.css`, …, `layouts/letter.css`). */
  export const DEFAULTS: { readonly base: string; readonly primary: string; readonly syntax: string; readonly layout: string };

  /** Paged.js's own page (Letter, 1 in margins), used when no @page rule sets one. */
  export const FALLBACK_PAGE: Readonly<Geometry>;

  /** Page sizes in mm, portrait, by lower-case keyword. */
  export const PAGE_SIZES: Readonly<Record<string, readonly [number, number]>>;

  export function pageGeometry(css: string, options?: { name?: string; fallback?: Geometry }): Geometry & { found: boolean; unreadable: string[] };

  /** P18: the token data pagemd fills a template with. */
  export function templateData(context: { content?: string; styles?: string; metadata?: Record<string, unknown>; profile?: Record<string, unknown> }): Record<string, unknown>;
  /** P18: a template with its tokens filled as pagemd fills them; `missing`: tokens with no value and no default. */
  export function fillTemplate(template: string, data: Record<string, unknown>, options?: { expand?: (text: string) => string; log?: { debug?: (...args: unknown[]) => void } }): { html: string; missing: string[] };
}

declare module '@pagemd/meta' {
  export function normalizeMetadata(raw: Record<string, unknown>, options?: object): Record<string, unknown>;
  /** normalizeMetadata() plus, per canonical key, the key the author wrote. */
  export function normalize(raw: Record<string, unknown>, options?: object): { values: Record<string, unknown>; keys: Record<string, string> };
  /** The field catalogue (FieldSpec[]); `items` lists the syntax items a field configures or gates. */
  export function catalogue(profile?: object): { key: string; items?: string[]; sources: string[] }[];
  /** Required (the profile's validation.required_fields) and shown on the page (the template's metadata.x tokens). */
  export function requirements(profile?: object, template?: string): { required: string[]; shownOnPage: string[] };
  export function gateFor(itemId: string): { field: string; value: unknown } | null;
}
