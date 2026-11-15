// Document properties (P8, R-161, ADR-0013 amendment): the one way components and the action runner read and change
// the document's properties (the frontmatter). A preset that models the frontmatter provides it (preset-pagemd does,
// with @pagemd/meta's names and @pagemd/syntax's comment-keeping YAML edit); components never touch YAML.
import type { Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';

/** One property as written. */
export interface PropertyEntry {
  /** The catalogue's name (`document_id`), or the written key when the catalogue doesn't know it. */
  key: string;
  /** The key the author wrote (`doc_id`): kept when the value changes (ADR-0016 M4). */
  written: string;
  /** The value as written (YAML read with pagemd's rules). */
  value: unknown;
}

/** The document's properties as they are now. */
export interface PropertiesState {
  /** The frontmatter node's position. */
  pos: number;
  /** The YAML between the `---` lines, as written ('\n' line endings). */
  yaml: string;
  /** In written order. Empty when `error` is set. */
  entries: PropertyEntry[];
  /** Why the YAML can't be read as properties (pagemd would stop there too); only the raw text can be edited then. */
  error?: string;
}

export interface PropertiesProvider {
  /** The document's properties; null when it has no frontmatter. */
  read(doc: Node): PropertiesState | null;
  /**
   * Sets property `key` (a catalogue name) to `value` in `tr`, keeping the author's own key and everything else as
   * written; adds a frontmatter at the start when there is none. False when the frontmatter can't be read.
   */
  set(tr: Transaction, key: string, value: unknown): boolean;
  /** Removes property `key` (whatever key the author wrote it under). False when it isn't there or can't be read. */
  remove(tr: Transaction, key: string): boolean;
  /** Replaces the frontmatter's YAML text (the raw-YAML view). An empty text keeps an empty frontmatter. */
  setText(tr: Transaction, yaml: string): boolean;
}
