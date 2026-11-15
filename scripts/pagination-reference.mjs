#!/usr/bin/env node
// P6 acceptance (amendments 12 and 13): the page counts pagemd's real PDF has, stored in
// test/e2e/fixtures/pagination-reference.json for test/e2e/pagination.spec.ts to compare Print Layout against (±1
// page). Two counts per document:
// - `pdfPages`: the whole PDF (`pagemd build -o pdf`), for the record;
// - `bodyPages` (R-146, what the test compares): only the pages holding the document body, from its first element to
//   its last, leaving out pages that hold nothing but the generated index. Print Layout shows the body only, not the
//   template's title/cover/contents pages. Counted by running Paged.js through the pagemd checkout's own renderer
//   code (renderDocument → injectPagedJs → Puppeteer, as renderPdf does), on a copy of the document with two empty
//   marker <div>s at the body's start and end. The total pages of that run must equal `pdfPages` (a check that the
//   copy renders like the original). Building PDFs takes minutes, so it isn't part of the test run; each entry carries a fingerprint of the
// document and of every stylesheet, profile and template pagemd could use for it, and the test fails when one is
// stale ("run npm run pagination:reference").
// Usage: node scripts/pagination-reference.mjs   (needs the pagemd checkout next to this repo, like style-parity)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGEMD_ROOT = resolve(root, '../pagemd');
export const REFERENCE_FILE = join(root, 'test/e2e/fixtures/pagination-reference.json');
/** pagemd's own example documents: multi-page, page breaks, covers, sections, landscape pages, tables. */
export const REFERENCE_DIR = join(PAGEMD_ROOT, 'tests/corpus/pagemd/examples/md');

/** The documents compared: every example document. */
export function referenceDocuments() {
  return readdirSync(REFERENCE_DIR)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => join(REFERENCE_DIR, n));
}

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
    const s = statSync(p);
    if (s.isDirectory()) out = out.concat(filesUnder(p));
    else if (/\.(css|json|html|ya?ml)$/i.test(name)) out.push(p);
  }
  return out;
}

/**
 * The document's text plus every profile, layout, stylesheet and template in pagemd's own folders and in the
 * example project's, hashed: any change there can change the PDF's page count.
 */
export function fingerprint(documentPath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(documentPath));
  const projects = [PAGEMD_ROOT, dirname(dirname(documentPath))];
  for (const base of projects) {
    for (const folder of ['profiles', 'layouts', 'styles', 'templates']) {
      for (const file of filesUnder(join(base, folder))) {
        hash.update(relative(base, file));
        hash.update(readFileSync(file));
      }
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/** Pages in a PDF: pagemd's own counting rule (renderer-pdf's countPdfPages). */
export function countPdfPages(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/**
 * Body markers. The end one stays an empty <div> (zero height, at the very end). The start one is taken out of the
 * rendered HTML again and becomes an attribute on the body's first element: an empty <div> before a first element
 * that starts with a forced page break would add a blank page (pagemd strips HTML comments, so they can't be used).
 */
const START = '<div class="pmd-ref-body-start"></div>';
const END = '<div class="pmd-ref-body-end"></div>';

function markFirstElement(html) {
  const at = html.indexOf(START);
  if (at < 0) return html;
  const rest = html.slice(at + START.length).replace(/^((?:\s|<!--[\s\S]*?-->)*<[a-zA-Z][\w-]*)/, '$1 data-pmd-ref-body-start');
  return html.slice(0, at) + rest;
}
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** The document with the body markers: after the frontmatter, and at the very end. */
function withMarkers(text) {
  const fm = FRONTMATTER.exec(text)?.[0] ?? '';
  return `${fm}\n${START}\n\n${text.slice(fm.length)}\n\n${END}\n`;
}

/** pagemd's renderer pieces, from its checkout (renderPdf's own steps). */
async function pagemdRenderer() {
  const at = (rel) => import(pathToFileURL(join(PAGEMD_ROOT, rel)).href);
  const pdf = await at('packages/renderer-pdf/src/index.js');
  const web = await at('packages/renderer-web/src/index.js');
  const requests = await at('packages/renderer-pdf/src/request-interceptor.js');
  const core = await at('packages/core/src/index.js');
  // The CLI turns code highlighting on at start-up (apps/cli/src/index.js); highlighted code blocks are taller.
  const parser = await at('packages/parser/src/index.js');
  await parser.initHighlighter();
  return { ...pdf, renderDocument: web.renderDocument, setupRequestInterception: requests.setupRequestInterception, resolveColorScheme: core.resolveColorScheme };
}

/** Total and body pages of one document, rendered with Paged.js the way renderPdf does. */
async function countBodyPages(r, browser, documentPath) {
  // The copy lives outside pagemd's checkout: its project root is still pagemd's (as for the original).
  const htmlResult = await r.renderDocument(documentPath, { profile: 'standard_letter', cliPath: PAGEMD_ROOT, projectRoot: PAGEMD_ROOT });
  const injected = r.injectPagedJs(markFirstElement(htmlResult.html), { pagedConfig: r.getPagedJsConfig(htmlResult.profile, htmlResult.metadata), autoInit: true, mode: 'browser' });
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 1 });
    const scheme = r.resolveColorScheme({ frontmatter: htmlResult.metadata, profile: htmlResult.profile, envDefault: process.env.PAGEMD_COLOR_SCHEME, outputFormat: 'pdf' });
    if (scheme !== 'auto') await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    const prepared = r.prepareHtmlForRendering(injected, documentPath, { useBaseHref: true, rewritePaths: true });
    await r.setupRequestInterception(page, { baseDir: dirname(resolve(documentPath)) });
    const timeout = r.resolvePagedTimeout(htmlResult.profile, htmlResult.metadata) || 0;
    await page.setContent(prepared, { waitUntil: 'networkidle0', timeout });
    await page.waitForFunction(() => window.__pagedjs_complete === true, { timeout });
    return await page.evaluate(() => {
      const pages = [...document.querySelectorAll('.pagedjs_page')];
      const first = pages.findIndex((p) => p.querySelector('[data-pmd-ref-body-start]'));
      const last = pages.findLastIndex((p) => p.querySelector('.pmd-ref-body-end'));
      if (first < 0 || last < 0) return { total: pages.length, body: -1 };
      let body = 0;
      for (let i = first; i <= last; i++) {
        const content = pages[i].querySelector('.pagedjs_page_content') ?? pages[i];
        const clone = content.cloneNode(true);
        for (const el of clone.querySelectorAll('.book-index, .pmd-ref-body-end')) el.remove();
        const hasContent = (clone.textContent ?? '').trim() !== '' || clone.querySelector('img, svg, table, hr, figure') !== null;
        if (hasContent) body++;
      }
      return { total: pages.length, body };
    });
  } finally {
    await page.close();
  }
}

async function main() {
  process.env.PAGEMD_MERMAID = '0';
  process.env.TZ = 'UTC';
  const docs = referenceDocuments().filter((d) => !process.env.PMD_REF_ONLY || basename(d).startsWith(process.env.PMD_REF_ONLY));
  const out = mkdtempSync(join(tmpdir(), 'pmd-pagination-reference-'));
  // A copy of pagemd's corpus project, where the marked copies of the documents can sit beside the originals' files.
  const corpus = join(PAGEMD_ROOT, 'tests/corpus/pagemd');
  const copy = join(out, 'corpus');
  cpSync(corpus, copy, { recursive: true });
  const r = await pagemdRenderer();
  const browser = await r.launchBrowser({ headless: true });
  const entries = {};
  try {
    for (const doc of docs) {
      process.stdout.write(`${basename(doc)} … `);
      execFileSync('node', ['apps/cli/src/index.js', 'build', doc, '-o', 'pdf', '-d', out], {
        cwd: PAGEMD_ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, PAGEMD_MERMAID: '0', TZ: 'UTC' },
      });
      const pdfPages = countPdfPages(readFileSync(join(out, basename(doc).replace(/\.md$/, '.pdf'))));
      const marked = join(copy, relative(corpus, doc));
      writeFileSync(marked, withMarkers(readFileSync(doc, 'utf8')));
      const counted = await countBodyPages(r, browser, marked);
      if (counted.body < 0) throw new Error(`${basename(doc)}: the body markers weren't found in the rendered pages`);
      if (counted.total !== pdfPages) throw new Error(`${basename(doc)}: the marked copy has ${counted.total} pages, the PDF ${pdfPages}`);
      entries[relative(PAGEMD_ROOT, doc).replaceAll('\\', '/')] = { bodyPages: counted.body, pdfPages, fingerprint: fingerprint(doc) };
      process.stdout.write(`${counted.body} body pages (${pdfPages} in the PDF)\n`);
    }
  } finally {
    await r.closeBrowser(browser);
    rmSync(out, { recursive: true, force: true });
  }
  writeFileSync(REFERENCE_FILE, `${JSON.stringify({ generatedBy: 'scripts/pagination-reference.mjs', documents: entries }, null, 2)}\n`);
  console.log(`Wrote ${relative(root, REFERENCE_FILE)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
