#!/usr/bin/env node
// P21 acceptance: what pagemd's real PDF prints in the top and bottom margins of every page of the page-type fixtures
// (test/e2e/fixtures/page-types/: cascade.md, clear.md, props.md, with their own layout multi.css). Stored in
// test/e2e/fixtures/page-types-reference.json for test/e2e/page-types.spec.ts:
// - per document and page: the sheet size (pt, `pdfinfo`), the left edge of the text (pt; it tells the page type's
//   margins, which pagemd's PDF honours), and the header and footer text in their left, center and right boxes, read
//   with poppler's `pdftotext -bbox` (needed only to run this script, not the tests). A word is in the header when its
//   middle is above the page type's top margin, in the footer when below its bottom margin; the box is the third of the
//   text width its middle is in;
// - `fingerprint`: the fixture and pagemd's own profiles, layouts, styles and templates, hashed: the test fails when the
//   reference is stale ("run npm run page-types:reference").
// Usage: node scripts/page-types-reference.mjs   (needs the pagemd checkout next to this repo, like the other references)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGEMD_ROOT = resolve(root, '../pagemd');
export const FIXTURE = join(root, 'test/e2e/fixtures/page-types');
export const DOCUMENTS = ['cascade.md', 'clear.md', 'props.md'];
export const REFERENCE_FILE = join(root, 'test/e2e/fixtures/page-types-reference.json');
const PT_PER_IN = 72;
/** The fixture layout's margins (in), by the text's left edge (pt): plain (and clear, props) 1 in, wide 0.5 / 0.75 in, legal 1.5 in. */
const MARGINS = [
  { left: 72, top: 72, bottom: 72, right: 72 },
  { left: 54, top: 36, bottom: 36, right: 54 },
  { left: 108, top: 108, bottom: 108, right: 108 },
];

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

/** The fixture and pagemd's own profiles/layouts/styles/templates, hashed. */
export function fingerprint() {
  const hash = createHash('sha256');
  for (const file of filesUnder(FIXTURE)) {
    hash.update(relative(FIXTURE, file));
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

/** One page of `pdftotext -bbox`: its size and its words with boxes (pt). */
function pagesOf(xml) {
  return xml.split('<page ').slice(1).map((chunk) => ({
    width: Number(/width="([\d.]+)"/.exec(chunk)[1]),
    height: Number(/height="([\d.]+)"/.exec(chunk)[1]),
    words: [...chunk.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
      x0: Number(m[1]), y0: Number(m[2]), x1: Number(m[3]), y1: Number(m[4]), text: m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
    })),
  }));
}

function read(page) {
  const mid = (w) => ({ x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2 });
  // The text's left edge: the body words (between the margins of any page type), the leftmost
  const body = page.words.filter((w) => mid(w).y > 72 && mid(w).y < page.height - 72);
  const left = Math.round(Math.min(...body.map((w) => w.x0)));
  const margins = MARGINS.reduce((best, m) => (Math.abs(m.left - left) < Math.abs(best.left - left) ? m : best));
  const width = page.width - margins.left - margins.right;
  const boxOf = (w) => {
    const x = mid(w).x - margins.left;
    return x < width / 3 ? 'left' : x > (2 * width) / 3 ? 'right' : 'center';
  };
  const band = (inBand) => {
    const out = { left: '', center: '', right: '' };
    for (const w of page.words.filter(inBand).sort((a, b) => a.x0 - b.x0)) {
      const box = boxOf(w);
      out[box] = out[box] ? `${out[box]} ${w.text}` : w.text;
    }
    return out;
  };
  return {
    size: { width: Math.round(page.width), height: Math.round(page.height) },
    textLeft: left,
    header: band((w) => mid(w).y < margins.top),
    footer: band((w) => mid(w).y > page.height - margins.bottom),
  };
}

function main() {
  const work = mkdtempSync(join(tmpdir(), 'pmd-page-types-'));
  try {
    const documents = {};
    for (const doc of DOCUMENTS) {
      execFileSync('node', ['apps/cli/src/index.js', 'build', join(FIXTURE, doc), '-o', 'pdf', '-d', work], { cwd: PAGEMD_ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PAGEMD_MERMAID: '0' } });
      const pdf = join(work, doc.replace(/\.md$/, '.pdf'));
      const pages = pagesOf(execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8' })).map(read);
      const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
      const count = Number(/^Pages:\s+(\d+)/m.exec(info)[1]);
      if (count !== pages.length) throw new Error(`${doc}: pdfinfo says ${count} pages, pdftotext ${pages.length}`);
      documents[doc] = pages;
      console.log(`${doc}: ${pages.length} page(s); ${pages.map((p, i) => `${i + 1} [${p.header.left} | ${p.header.right} | ${p.footer.center}]`).join(', ')}`);
    }
    writeFileSync(REFERENCE_FILE, `${JSON.stringify({ generatedBy: 'scripts/page-types-reference.mjs', ptPerIn: PT_PER_IN, documents, fingerprint: fingerprint() }, null, 2)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
