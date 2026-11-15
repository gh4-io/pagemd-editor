// Files in Use (P25, R-242; ADR-0013 note): the shape of the trace of every file that builds a document, in priority order,
// with why each was chosen, and the index of every style rule for "where did this come from". style-pagemd builds it on the
// host from the resolver's and theme-kit's answers; the protocol carries it; components/files-panel draws it. Types only.

/** The CSS layers in cascade order, lowest priority first (theme-kit's `CSS_LAYER_ORDER`), then the template's own CSS, outside any layer. */
export const CSS_LAYERS = ['base', 'primary', 'layout', 'syntax', 'profile', 'frontmatter', 'template'] as const;
export type CssLayer = (typeof CSS_LAYERS)[number];

/** What a row of the report is. */
export type FileRole =
  /** The `.md` itself: its frontmatter names the profile and the `styles:` files. */
  | 'document'
  /** A profile file: the named profile, then each one it `extends`. */
  | 'profile'
  /** The HTML template drawn around the text. */
  | 'template'
  /** A stylesheet (or the CSS made from the document's properties, `path` null). */
  | 'stylesheet'
  /** FIX-template-asset-paths (R-259): a picture or other file the template, the layout or a profile stylesheet names (`source` as written). */
  | 'asset';

/**
 * The search step that found a file by name (the resolver's five steps, R-24; six for a profile, phase L2: the shared profiles
 * folder is step 4), or how its path was written. `of`: how many steps that search has (5 when absent).
 */
export type FoundBy =
  | { kind: 'search'; step: 1 | 2 | 3 | 4 | 5 | 6; folder: string; of?: 5 | 6 }
  | { kind: 'path'; base: string | null }
  | { kind: 'absolute' }
  | { kind: 'named' }
  | { kind: 'system' }
  | { kind: 'default' }
  | { kind: 'generated' }
  | { kind: 'unknown' };

export interface FileUse {
  /** Unique within one report ("f3"); the rule index refers to it. */
  id: string;
  role: FileRole;
  /** Where the file is (absolute). Null: generated CSS, or a file that was not found. */
  path: string | null;
  /** The short name shown first (the file's name, or "CSS made from the properties"). */
  name: string;
  /** What it is, in a few words ("Profile you named", "Profile it extends (2)", "Profile stylesheet 2 of 3"). */
  label: string;
  /** The name or path as written (a profile name, `./styles/x.css`, `${cliPath}/layouts/letter.css`). */
  source?: string;
  /** Why this file, in plain words (which step found it, who named it). */
  why: string;
  foundBy: FoundBy;
  /** Stylesheets: the layer, and the place in the cascade (1 = the highest priority of all stylesheets). */
  layer?: CssLayer;
  rank?: number;
  /** Inside pagemd's own folder (bundled with the editor, or the pagemd install): change a copy, not this file. */
  bundled: boolean;
  /** How many style rules the file has (stylesheets). */
  rules?: number;
  /** Why it could not be used (not found, found twice); `candidates` are the paths found, or the folders searched. */
  problem?: string;
  candidates?: string[];
}

export interface FilesInUseProblem {
  kind: string;
  message: string;
  source?: string;
  /** Paths the problem is about (both files of a duplicate name). */
  paths?: string[];
}

export interface CssDeclarationSource {
  /** Lower case, as written (`margin`, `font-size`, `--accent`). */
  property: string;
  value: string;
  important: boolean;
}

/** One style rule of one file, as the canvas has it (P25's rule index). */
export interface CssRuleSource {
  /** The `FileUse.id` of the file it is in. */
  file: string;
  /** 1-based line and column of the rule in that file (the file's own text; generated CSS: in that text). */
  line: number;
  column: number;
  /** The selector as written in the file. */
  selector: string;
  /** The selectors as the canvas has them (scoped to `.pmd-canvas`, print/screen turned into classes): what `Element.matches` takes. */
  selectors: string[];
  layer: CssLayer;
  /** Inside an `@layer` block of the file's own (it loses to the file's rules outside such a block). */
  nestedLayer?: string;
  /** `@media` conditions still to test on the canvas, and `@supports` conditions (all must hold). */
  media?: string[];
  supports?: string[];
  /** The rule's place in the whole cascade (file order, then the rule's place in its file). */
  order: number;
  declarations: CssDeclarationSource[];
}

export interface FilesInUse {
  /** The document's path (null: not a file, plain styles). */
  document: string | null;
  /** The profile as asked for (frontmatter `profile`, else the default). */
  profile: string | null;
  /** Every row, in the order shown: document, profiles, template, the files they use, stylesheets (highest priority first). */
  files: FileUse[];
  problems: FilesInUseProblem[];
  /** The cascade in plain words, shown once at the top. */
  cascade: string;
  rules: CssRuleSource[];
  /** The canvas shows plain styles (the problems say why): the rows are what was found, the rule index is empty. */
  plain: boolean;
}
