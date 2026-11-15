#!/usr/bin/env node
// P18 acceptance: what pagemd's real PDF looks like for the two template-driven examples copied into
// test/e2e/fixtures/print-fidelity/ (from the user's pagemd-examples repo: brochure-uofo and invitation-uofo, the logo made
// smaller). Stored in test/e2e/fixtures/print-fidelity-reference.json for test/e2e/print-fidelity.spec.ts:
// - `pdfPages` and `page` (width and height in pt): from the PDF the pagemd checkout's own CLI builds (`pagemd build -o pdf`);
// - `probes`: for a few words, where pagemd's PDF puts them on page 1 (the top left of the word's box, in pt from the page's top
//   left), read with poppler's `pdftotext -bbox` (needed only to run this script, not the tests);
// - `fingerprint`: the fixture's files and pagemd's own profiles, layouts, styles and templates, hashed: the test fails when the
//   reference is stale ("run npm run print-fidelity:reference").
// Usage: node scripts/print-fidelity-reference.mjs   (needs the pagemd checkout next to this repo, like the other references)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGEMD_ROOT = resolve(root, '../pagemd');
export const FIXTURE_DIR = join(root, 'test/e2e/fixtures/print-fidelity');
export const REFERENCE_FILE = join(root, 'test/e2e/fixtures/print-fidelity-reference.json');

/** The examples, their document, and the words looked for on page 1 (case as pagemd's PDF shows them). */
export const EXAMPLES = {
  'invitation-uofo': { document: 'uofo-annual-harvest-celebration.md', probes: ['INVITED', 'Harvest', 'Location', 'Pavilion,', 'join', 'RSVP', 'respond'] },
  'brochure-uofo': { document: 'uofo-company-overview-brochure.md', probes: ['Sustainably', 'What', 'Seasonal', 'Involved', 'Address:', 'Saturdays,'] },
};

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

/** The fixture's files and pagemd's own profiles/layouts/styles/templates, hashed. */
export function fingerprint(example) {
  const hash = createHash('sha256');
  const dir = join(FIXTURE_DIR, example);
  for (const file of filesUnder(dir)) {
    hash.update(relative(dir, file));
    hash.update(readFileSync(file));
  }
  for (const folder of ['profiles', 'layouts', 'styles', 'templates']) {
    for (const file of filesUnder(join(PAGEMD_ROOT, folder)).filter((f) => /\.(css|json|html)$/i.test(f))) {
      hash.update(relative(PAGEMD_ROOT, file));
      hash.update(readFileSync(file));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/** Pages in a PDF: pagemd's own counting rule (renderer-pdf's countPdfPages). */
function countPdfPages(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** Page 1's size and the first box of each probe word on it, from `pdftotext -bbox` (pt, top left origin). */
function pageOne(pdf, probes) {
  const xml = execFileSync('pdftotext', ['-bbox', '-f', '1', '-l', '1', pdf, '-'], { encoding: 'utf8' });
  const page = /<page width="([\d.]+)" height="([\d.]+)">/.exec(xml);
  const words = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    text: m[5].replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"'),
  }));
  const found = {};
  for (const probe of probes) {
    const word = words.find((w) => w.text === probe);
    if (!word) throw new Error(`"${probe}" is not on page 1 of ${pdf}`);
    found[probe] = { x: Math.round(word.x * 10) / 10, y: Math.round(word.y * 10) / 10 };
  }
  return { width: Number(page[1]), height: Number(page[2]), probes: found };
}

function main() {
  const documents = {};
  for (const [example, { document, probes }] of Object.entries(EXAMPLES)) {
    const work = mkdtempSync(join(tmpdir(), 'pmd-print-fidelity-'));
    try {
      // A copy outside this repo (pagemd finds the project the way it does for the user's own folder).
      const dir = join(work, example);
      cpSync(join(FIXTURE_DIR, example), dir, { recursive: true });
      const out = join(work, 'out');
      mkdirSync(out); // (pagemd stops without a terminal when the output folder doesn't exist yet: OQ-41 item 3)
      execFileSync('node', ['apps/cli/src/index.js', 'build', join(dir, document), '-o', 'pdf', '-d', out], { cwd: PAGEMD_ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
      const pdf = join(out, document.replace(/\.md$/, '.pdf'));
      const one = pageOne(pdf, probes);
      documents[example] = { document, pdfPages: countPdfPages(readFileSync(pdf)), page: { width: one.width, height: one.height }, probes: one.probes, fingerprint: fingerprint(example) };
      console.log(`${example}: ${documents[example].pdfPages} page(s), ${one.width} × ${one.height} pt`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  writeFileSync(REFERENCE_FILE, `${JSON.stringify({ generatedBy: 'scripts/print-fidelity-reference.mjs', documents }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
