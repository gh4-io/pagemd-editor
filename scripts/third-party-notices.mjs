// Generates apps/vscode/ThirdPartyNotices.txt (P13, amendment 4): every third-party package that ends up inside the extension,
// with its version, licence and licence text. The list is esbuild's own list of inputs for the three bundles (host, webview,
// pagemd's runtime), so it cannot drift from what is bundled, plus the prebuilt files that are copied in (codicons, mermaid,
// Paged.js) with the packages they were built from. The editor's own packages, pagemd and pagemd-common (both Apache-2.0)
// get their own entries, and so does the Inter font that pagemd-common's book-fonts.css embeds (SIL OFL 1.1, SAN-0b).
// Usage: node scripts/third-party-notices.mjs [--check]   (--check exits 1 when the committed file is out of date)
import * as esbuild from 'esbuild';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleOptions, pagemdCheckout } from '../esbuild.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const noticesFile = join(root, 'apps', 'vscode', 'ThirdPartyNotices.txt');
const NM = `${sep}node_modules${sep}`;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The licence of a package.json as one string ("not stated" when it names none). */
export function licenceOf(pkg) {
  const one = (l) => (typeof l === 'string' ? l : l && typeof l === 'object' ? l.type : undefined);
  const found = one(pkg.license) ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map(one).filter(Boolean).join(' OR ') : one(pkg.licenses));
  return found || 'not stated';
}

/** The text of the package's licence file(s), joined; '' when it ships none. */
export function licenceText(dir) {
  const names = readdirSync(dir).filter((n) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(n)).sort();
  return names
    .map((n) => readFileSync(join(dir, n), 'utf8').replace(/\r\n/g, '\n').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** The package folder of a file inside node_modules (the last node_modules segment wins), or null. */
export function packageDirOf(file) {
  const at = file.lastIndexOf(NM);
  if (at < 0) return null;
  const rest = file.slice(at + NM.length).split(sep);
  const parts = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  return file.slice(0, at + NM.length) + parts.join(sep);
}

const entryOf = (dir, extra = {}) => {
  const pkg = readJson(join(dir, 'package.json'));
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? pkg.homepage ?? '';
  return { key: `${pkg.name}@${pkg.version}`, name: pkg.name, version: pkg.version, licence: licenceOf(pkg), repo, text: licenceText(dir), ...extra };
};

/** A package folder by name, looked up from `from` the way Node would (walking up node_modules). */
function findPackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** The published names of pagemd-common's packages (GitHub Packages takes only the owner's scope; the copies install them under @pagemd/<name>). */
const PUBLISHED_COMMON = /^@gh4-io\/pagemd-(meta|packs|resolver|syntax|theme-kit|validate)$/;

/** Where the checkout's own files sit, to tell "pagemd" and "pagemd-common" code from libraries. */
const sourceOwner = (file, checkout) => {
  const common = resolve(checkout, '..', 'pagemd-common') + sep;
  if (file.startsWith(common)) return 'pagemd-common';
  if (file.startsWith(resolve(checkout) + sep)) return 'pagemd';
  return 'editor';
};

/**
 * Collects what is bundled. Returns { packages: Map<key, entry>, own: Set<string> (which of editor / pagemd / pagemd-common ship) }.
 * Runs the three bundles in memory (no files written).
 */
export async function collect(checkout = pagemdCheckout()) {
  const options = bundleOptions(join(root, 'apps', 'vscode', 'dist'));
  const packages = new Map();
  const own = new Set();
  const add = (dir, extra) => {
    const entry = entryOf(dir, extra);
    if (!packages.has(entry.key)) packages.set(entry.key, entry);
  };
  const bundles = ['host', 'webview', ...(existsSync(join(checkout, 'packages', 'exporters', 'src', 'index.js')) ? ['runtime'] : [])];
  for (const name of bundles) {
    const { metafile } = await esbuild.build({ ...options[name], write: false, metafile: true, logLevel: 'error' });
    for (const input of Object.keys(metafile.inputs)) {
      if (input.includes(':')) continue; // plugin namespaces (esm-default-export:…)
      const file = resolve(root, input);
      const dir = packageDirOf(file);
      if (dir) {
        // pagemd-common's packages, when they are installed from the registry (the public copy, runbook C3) instead of linked: still
        // pagemd-common's own code, listed once as "pagemd-common" below, never as a third-party package
        const real = realpathSync(dir);
        if (PUBLISHED_COMMON.test(readJson(join(real, 'package.json')).name)) own.add('pagemd-common');
        else add(real, { via: name });
      }
      else own.add(sourceOwner(file, checkout));
    }
  }
  // Prebuilt files that are copied into dist/ (esbuild.mjs copyCodicons / copyMermaid / copyPagemdVendor): the package they come
  // from, and for the bundled builds (mermaid.min.js, paged.polyfill.js) the libraries they were built from.
  const require = createRequire(join(root, 'apps', 'vscode', 'package.json'));
  const codicons = dirname(require.resolve('@vscode/codicons/package.json'));
  add(codicons, { via: 'copied: dist/webview/codicons' });
  // monaco-vscode.js bundles the @codingame packages (VS Code's own services, grammars and themes).
  for (const name of Object.keys(readJson(join(root, 'packages', 'components', 'code-view-monaco', 'package.json')).dependencies).filter((n) => n.startsWith('@codingame/'))) {
    add(join(root, 'node_modules', name), { via: 'bundled: dist/webview/monaco/monaco-vscode.js (experiment)' });
  }
  const mermaid = dirname(require.resolve('mermaid/package.json'));
  add(mermaid, { via: 'copied: dist/webview/mermaid/mermaid.min.js' });
  const pagedjs = findPackage('pagedjs', join(checkout, 'packages', 'renderer-pdf')) ?? findPackage('pagedjs', checkout);
  const prebuilt = [[mermaid, 'built into mermaid.min.js'], ...(pagedjs ? [[pagedjs, 'built into paged.polyfill.js']] : [])];
  if (pagedjs) add(pagedjs, { via: 'copied: dist/host/pagemd/vendor/paged.polyfill.js' });
  // The whole dependency tree (R-209): mermaid.min.js and paged.polyfill.js hold their dependencies' dependencies too.
  for (const [dir, how] of prebuilt) {
    const seen = new Set([dir]);
    const queue = [dir];
    while (queue.length) {
      const from = queue.shift();
      const deps = readJson(join(from, 'package.json')).dependencies ?? {};
      for (const dep of Object.keys(deps)) {
        const found = findPackage(dep, from);
        if (!found) {
          console.warn(`third-party-notices: ${dep} (a dependency of ${readJson(join(from, 'package.json')).name}) was not found: it is not listed`);
          continue;
        }
        const real = realpathSync(found);
        if (seen.has(real)) continue;
        seen.add(real);
        add(real, { via: how });
        queue.push(real);
      }
    }
  }
  return { packages, own, checkout };
}

const RULE = '-'.repeat(75);

/** The repo's own copyright line ("Copyright <year> <holder>"), read from NOTICE so the name is written in one place (SAN-0d). */
function ownCopyright() {
  const line = readFileSync(join(root, 'NOTICE'), 'utf8').match(/^Copyright [^\r\n]+/m)?.[0];
  if (!line) throw new Error('NOTICE has no "Copyright …" line');
  return line.trim();
}

/** The text of ThirdPartyNotices.txt. */
export function render({ packages, own, checkout }) {
  const out = [];
  out.push(
    'pagemd Editor ships the third-party material listed below. Each entry gives the package, its version, its licence and the',
    "licence text as the package published it. This file is generated by scripts/third-party-notices.mjs from the lists of inputs of",
    "the extension's bundles, and a test (test/build/third-party-notices.test.ts) fails when a bundled package is missing here.",
    '',
    `The extension's own code is ${ownCopyright()}, licensed under the Apache License, Version 2.0 (see LICENSE and`,
    'NOTICE). It bundles the code of the sibling projects named first below.',
    '',
  );
  const lic = (file) => (existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() : '');
  if (own.has('pagemd')) {
    out.push(
      RULE,
      'pagemd (the markdown to HTML/PDF engine; Print Preview and Export, dist/host/pagemd/), Apache-2.0',
      'https://github.com/gh4-io/pagemd',
      '',
      lic(join(checkout, 'LICENSE')) || '(licence text not found)',
      '',
    );
  }
  if (own.has('pagemd-common')) {
    const common = resolve(checkout, '..', 'pagemd-common');
    out.push(
      RULE,
      'pagemd-common (@pagemd/syntax, @pagemd/resolver, @pagemd/theme-kit, @pagemd/meta, @pagemd/validate), Apache-2.0',
      'The same authors\' sibling project, bundled from its checkout beside pagemd.',
      '',
      lic(join(common, 'LICENSE')) || '(licence text not found)',
      '',
      RULE,
      'Inter typeface (embedded as base64 in dist/defaults/styles/book-fonts.css, from @pagemd/theme-kit), OFL-1.1',
      'https://github.com/rsms/inter',
      '(copied: dist/defaults/styles/book-fonts.css; its licence text also sits beside it as book-fonts.LICENSE.txt)',
      '',
      lic(join(common, 'packages', 'theme-kit', 'defaults', 'styles', 'book-fonts.LICENSE.txt')) || '(licence text not found)',
      '',
    );
  }
  const list = [...packages.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const p of list) {
    out.push(RULE, `${p.key}, ${p.licence === 'not stated' && p.text ? 'licence: see the text below' : p.licence}`);
    if (p.repo) out.push(p.repo.replace(/^git\+/, ''));
    if (p.via?.startsWith('copied') || p.via?.startsWith('built')) out.push(`(${p.via})`);
    out.push('', p.text || `(this package ships no licence file; its package.json says: ${p.licence})`, '');
  }
  out.push(RULE, `${list.length} packages.`, '');
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = render(await collect());
  if (process.argv.includes('--check')) {
    const current = existsSync(noticesFile) ? readFileSync(noticesFile, 'utf8') : '';
    if (current !== text) {
      console.error('ThirdPartyNotices.txt is out of date: run `node scripts/third-party-notices.mjs`');
      process.exit(1);
    }
    console.log('ThirdPartyNotices.txt is up to date');
  } else {
    writeFileSync(noticesFile, text);
    console.log(`wrote ${noticesFile} (${text.length} bytes)`);
  }
}
