#!/usr/bin/env node
// P19 acceptance: where pagemd's real PDF puts the columns of the tables in its example `examples/md/16-table-column-widths.md`
// (column widths on the table's `{…}` line). Stored in test/e2e/fixtures/table-widths-reference.json for
// test/e2e/table-widths.spec.ts:
// - `probes`: for a few words that start a left-aligned cell, the x (pt from the paper's left edge) of their first box on each
//   page of the PDF that has them, read with poppler's `pdftotext -bbox` (needed only to run this script, not the tests). The long
//   table runs over several pages: every page must show its columns at the same x (Paged.js rebuilds a split table without its
//   `<colgroup>`, so the cells carry the widths, P19 AD-P19-03);
// - `fingerprint`: the example and pagemd's own profiles, layouts, styles and templates, hashed: the test fails when the reference
//   is stale ("run npm run table-widths:reference").
// Usage: node scripts/table-widths-reference.mjs   (needs the pagemd checkout next to this repo, like the other references)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGEMD_ROOT = resolve(root, '../pagemd');
export const EXAMPLE = 'examples/md/16-table-column-widths.md';
export const REFERENCE_FILE = join(root, 'test/e2e/fixtures/table-widths-reference.json');
/**
 * Words that start a left-aligned body cell: the first table's first and third columns, the long table's task and instructions.
 * (Not header cells: the canvas draws header rows inside <tbody>, so pagemd's `thead` rules don't reach them; OQ-49.)
 */
export const PROBES = ['Bolts', 'Replace', 'Inspect', 'Check'];

function filesUnder(dir) {
  let out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** The example and pagemd's own profiles/layouts/styles/templates, hashed. */
export function fingerprint() {
  const hash = createHash('sha256');
  hash.update(readFileSync(join(PAGEMD_ROOT, EXAMPLE)));
  for (const folder of ['profiles', 'layouts', 'styles', 'templates']) {
    for (const file of filesUnder(join(PAGEMD_ROOT, folder)).filter((f) => /\.(css|json|html)$/i.test(f))) {
      hash.update(relative(PAGEMD_ROOT, file));
      hash.update(readFileSync(file));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function main() {
  const work = mkdtempSync(join(tmpdir(), 'pmd-table-widths-'));
  try {
    execFileSync('node', ['apps/cli/src/index.js', 'build', EXAMPLE, '-o', 'pdf', '-d', work], { cwd: PAGEMD_ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PAGEMD_MERMAID: '0' } });
    const pdf = join(work, '16-table-column-widths.pdf');
    const xml = execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8' });
    const pages = xml.split('<page ').slice(1);
    const width = Number(/width="([\d.]+)"/.exec(pages[0])[1]);
    const probes = {};
    pages.forEach((page, k) => {
      for (const word of [...page.matchAll(/<word xMin="([\d.]+)"[^>]*>([^<]*)<\/word>/g)]) {
        if (!PROBES.includes(word[2])) continue;
        const list = (probes[word[2]] ??= []);
        if (!list.some((p) => p.page === k + 1)) list.push({ page: k + 1, x: Math.round(Number(word[1]) * 10) / 10 });
      }
    });
    for (const probe of PROBES) if (!probes[probe]) throw new Error(`"${probe}" is not in the PDF`);
    writeFileSync(REFERENCE_FILE, `${JSON.stringify({ generatedBy: 'scripts/table-widths-reference.mjs', example: EXAMPLE, pdfPages: pages.length, pageWidth: width, probes, fingerprint: fingerprint() }, null, 2)}\n`);
    console.log(`${EXAMPLE}: ${pages.length} page(s); ${Object.entries(probes).map(([w, l]) => `${w} on ${l.length} page(s)`).join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
