// The golden corpus (R-75): the plain files in test/corpus/files/, this repo's docs/**/*.md read in
// place, and the CommonMark spec examples (npm commonmark-spec 0.31.2).
// docs/ is the private design trail and is never in a public copy (sanitize plan AD-SAN-12, SAN-0b): when the
// folder is missing, docsFiles is empty and the other parts of the corpus (and pagemd's corpus) still run.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import spec from 'commonmark-spec';

export interface CorpusEntry {
  name: string;
  text: string;
}

const filesDir = fileURLToPath(new URL('./files/', import.meta.url));
const docsDir = fileURLToPath(new URL('../../docs/', import.meta.url));

export const plainFiles: CorpusEntry[] = readdirSync(filesDir)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({ name: `files/${name}`, text: readFileSync(`${filesDir}${name}`, 'utf8') }));

/** True when this checkout has the private docs/ folder (the source repo; never the public copy). */
export const hasDocs = existsSync(docsDir);

export const docsFiles: CorpusEntry[] = (hasDocs ? (readdirSync(docsDir, { recursive: true }) as string[]) : [])
  .map((name) => name.replace(/\\/g, '/'))
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({ name: `docs/${name}`, text: readFileSync(`${docsDir}${name}`, 'utf8') }));

interface SpecExample {
  markdown: string;
  number: number;
  section: string;
}

/** The spec shows tabs as `→`; its own test runner turns them back into tabs, and so do we. */
export const specExamples: CorpusEntry[] = (spec as { tests: SpecExample[] }).tests.map((ex) => ({
  name: `spec #${ex.number} (${ex.section})`,
  text: ex.markdown.replace(/→/g, '\t'),
}));
