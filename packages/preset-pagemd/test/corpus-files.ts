// pagemd's golden corpus (91 files in pagemd/tests/corpus, C0), read in place like P1's docs corpus (R-75), plus
// the private corpus when PAGEMD_PRIVATE_CORPUS has files (R-36, R-51). One transformer per set of gate values.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer, type Transformer } from '@pagemd-editor/transformer';
import { gateFields, gateKey, pagemdItems } from '../src/index.ts';

export const PAGEMD_ROOT = fileURLToPath(new URL('../../../../pagemd/', import.meta.url));
const CORPUS = join(PAGEMD_ROOT, 'tests', 'corpus');
const PRIVATE = process.env['PAGEMD_PRIVATE_CORPUS'];

function markdownFiles(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (['.snapshots', 'node_modules', '.git'].includes(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

export interface CorpusFile {
  name: string;
  text: string;
}

export const corpus: CorpusFile[] = [
  ...markdownFiles(CORPUS).map((file) => ({ name: relative(CORPUS, file).split('\\').join('/'), text: readFileSync(file, 'utf8') })),
  ...markdownFiles(PRIVATE).map((file) => ({ name: `private/${relative(PRIVATE!, file).split('\\').join('/')}`, text: readFileSync(file, 'utf8') })),
];

const transformers = new Map<string, Transformer>();

/** The editor's reader and writer with every preset, for this text's gate values (its frontmatter). */
export function transformerFor(text: string): Transformer {
  const fields = gateFields(text);
  const key = gateKey(fields);
  let t = transformers.get(key);
  if (!t) {
    t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({ fields })]);
    transformers.set(key, t);
  }
  return t;
}
