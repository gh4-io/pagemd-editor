// Builds the two bundles (ADR-0012): the extension host (Node, CommonJS: the format every VS Code
// version loads) and the webview (browser). Workspace packages are bundled from their TypeScript source.
// P10: a third, pagemd's runtime (output-pagemd's runtime.ts with pagemd's renderer from the local pagemd checkout,
// AD-P10-01), loaded by the host on the first Print Preview or Export.
// Usage: node esbuild.mjs [--watch]
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
export const defaultOutdir = join(root, 'apps/vscode/dist');

/**
 * `@pagemd/theme-kit`'s `defaults/` (R-128: every bundled profile, layout, style and template, so the editor
 * finds pagemd's own files with no pagemd install) copied next to the host bundle, byte for byte.
 */
export function copyDefaults(outdir = defaultOutdir) {
  const require = createRequire(import.meta.url);
  const source = dirname(require.resolve('@pagemd/theme-kit/defaults/.gitattributes'));
  const target = join(outdir, 'defaults');
  cpSync(source, target, { recursive: true });
  return target;
}

/**
 * VS Code's own icons (P8, R-162): `@vscode/codicons`' stylesheet and font, with its licence, next to the webview bundle
 * (`dist/webview/codicons/`). The page links the stylesheet; the font loads from the extension (the CSP's font-src).
 */
export function copyCodicons(outdir = defaultOutdir) {
  const require = createRequire(import.meta.url);
  const source = dirname(require.resolve('@vscode/codicons/dist/codicon.css', { paths: [join(root, 'apps/vscode')] }));
  const target = join(outdir, 'webview', 'codicons');
  mkdirSync(target, { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) cpSync(join(source, file), join(target, file));
  cpSync(join(source, '..', 'LICENSE'), join(target, 'LICENSE'));
  return target;
}

/**
 * The local pagemd checkout the runtime file is built from (P10, AD-P10-01; R-40's local links): `PAGEMD_CHECKOUT`, else
 * the sibling checkout `../pagemd`. Its packages and their installed libraries are used as they are, so
 * the editor exports with exactly what `pagemd build` runs.
 */
export const pagemdCheckout = (env = process.env) => env['PAGEMD_CHECKOUT'] || join(root, '..', 'pagemd');

/** pagemd's own packages (not pagemd-common's, which resolve through the checkout's node_modules like the CLI's). */
const PAGEMD_PACKAGES = /^@pagemd\/(core|parser|renderer-web|renderer-pdf|exporters)$/;
/** pagemd-common's packages, which pagemd's and pagemd-common's own sources import by name. */
const COMMON_PACKAGES = /^@pagemd\/(resolver|syntax|meta|theme-kit|validate)(\/.*)?$/;
/**
 * Resolves `@pagemd/<package>` to the checkout's source, as pagemd's own workspace links do.
 */
export const fromCheckout = (checkout) => ({
  name: 'pagemd-checkout',
  setup(build) {
    build.onResolve({ filter: PAGEMD_PACKAGES }, (args) => ({ path: join(checkout, 'packages', args.path.slice('@pagemd/'.length), 'src', 'index.js') }));
  },
});

/**
 * pagemd-common's packages, imported from inside the pagemd or pagemd-common checkout, resolve through the editor's own links to the
 * same pagemd-common checkout (P13a, AD-P13-21). The checkouts' own `node_modules/@pagemd/*` are Linux symlinks that Windows cannot
 * follow (the folders are shared by WSL and Windows); both ways lead to the same files, so Linux builds are unchanged.
 */
export const commonLinks = (checkout = pagemdCheckout()) => {
  const projects = resolve(checkout, '..') + sep;
  return {
    name: 'pagemd-common-links',
    setup(build) {
      build.onResolve({ filter: COMMON_PACKAGES }, (args) => {
        if (args.pluginData === 'from-editor' || !resolve(args.importer).startsWith(projects)) return undefined;
        return build.resolve(args.path, { kind: args.kind, resolveDir: root, pluginData: 'from-editor' });
      });
    },
  };
};

/**
 * The files pagemd reads next to itself when bundled (P10): Paged.js's polyfill (renderer-pdf's `vendor/` lookup) and the
 * mermaid browser build (the parser's), copied from the checkout's own installed libraries.
 */
export function copyPagemdVendor(outdir = defaultOutdir, checkout = pagemdCheckout()) {
  const from = createRequire(join(checkout, 'packages', 'parser', 'package.json'));
  // renderer-pdf's own source-mode path (pagedjs exports no package.json to resolve)
  const polyfill = [join(checkout, 'packages', 'renderer-pdf', 'node_modules'), join(checkout, 'node_modules')]
    .map((folder) => join(folder, 'pagedjs', 'dist', 'paged.polyfill.js'))
    .find((file) => existsSync(file));
  if (!polyfill) throw new Error(`esbuild: Paged.js is not installed in the pagemd checkout (${checkout}); run npm install there.`);
  const target = join(outdir, 'host', 'pagemd', 'vendor');
  mkdirSync(target, { recursive: true });
  cpSync(polyfill, join(target, 'paged.polyfill.js'));
  cpSync(join(dirname(from.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js'), join(target, 'mermaid.min.js'));
  return target;
}

/**
 * The mermaid browser build for the webview (P10: diagrams on the canvas and in the Print Preview), from the editor's own
 * pinned copy (R-167: the same version as pagemd's; a test compares them), with its licence. Loaded only when a document
 * has a diagram.
 */
export function copyMermaid(outdir = defaultOutdir) {
  const require = createRequire(join(root, 'apps', 'vscode', 'package.json'));
  const source = dirname(require.resolve('mermaid/package.json'));
  const target = join(outdir, 'webview', 'mermaid');
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'dist', 'mermaid.min.js'), join(target, 'mermaid.min.js'));
  cpSync(join(source, 'LICENSE'), join(target, 'LICENSE'));
  return target;
}

/**
 * One markdown-it (P4). @pagemd/syntax is linked from the pagemd-common checkout (R-40), so its markdown-it
 * plugins would get markdown-it (and the libraries it is made of) from that repo's node_modules: a second copy,
 * in its CommonJS build. They get this repo's copy instead (the same version, pinned by `overrides`), as ES
 * modules. A plugin that `require()`s markdown-it itself (markdown-it-attrs) gets the ES module's default export,
 * which is what CommonJS `require` returns.
 */
const ONE_COPY = /^(markdown-it|linkify-it|mdurl|uc\.micro|entities|punycode\.js)(\/.*)?$/;
const DEFAULT_EXPORT = 'esm-default-export';
/**
 * Where those imports come from: the pagemd-common checkout (linked), or - when pagemd-common's packages are installed from the registry
 * (the public copies, runbook C3) - the installed packages themselves and the markdown-it plugins that sit beside them in node_modules.
 */
const FROM_COMMON = /(^|[\\/])pagemd-common[\\/]|[\\/]node_modules[\\/](markdown-it-[^\\/]+|@pagemd)[\\/]/;
const oneMarkdownIt = {
  name: 'one-markdown-it',
  setup(build) {
    const asModule = (path) => build.resolve(path, { kind: 'import-statement', resolveDir: root, pluginData: true });
    build.onResolve({ filter: ONE_COPY }, (args) => {
      if (args.pluginData) return undefined;
      if (args.namespace === DEFAULT_EXPORT) return asModule(args.path);
      if (!FROM_COMMON.test(args.importer)) return undefined;
      if (args.kind === 'require-call' && args.path === 'markdown-it') return { path: args.path, namespace: DEFAULT_EXPORT };
      return asModule(args.path);
    });
    build.onLoad({ filter: /.*/, namespace: DEFAULT_EXPORT }, (args) => ({
      contents: `module.exports = require(${JSON.stringify(args.path)}).default;`,
      loader: 'js',
      resolveDir: root,
    }));
  },
};

/** @param {string} outdir */
export function bundleOptions(outdir = defaultOutdir) {
  // P13 (AD-P13-02): always minified, so the tests run what ships; source maps stay in dist/ for debugging and never go into the .vsix.
  const common = { absWorkingDir: root, bundle: true, sourcemap: true, minify: true, logLevel: 'warning' };
  return {
    host: {
      ...common,
      entryPoints: ['apps/vscode/host/extension.ts'],
      outfile: join(outdir, 'host/extension.js'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode'],
      // P9: the symbol provider reads documents with the presets, so pagemd-common's markdown-it plugins are bundled here too.
      plugins: [commonLinks(), oneMarkdownIt],
    },
    webview: {
      ...common,
      entryPoints: ['apps/vscode/webview/main.ts'],
      outfile: join(outdir, 'webview/main.js'),
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      plugins: [commonLinks(), oneMarkdownIt],
    },
    // The Code view's Monaco with VS Code's own services: one self-contained script, loaded when the Code view first opens; its files are read from next to it.
    monacoVscode: {
      ...common,
      sourcemap: false,
      entryPoints: { 'monaco-vscode': 'packages/components/code-view-monaco/src/monaco-vscode-entry.ts' },
      outdir: join(outdir, 'webview', 'monaco'),
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      external: ['node:*'],
      define: { 'import.meta.url': 'globalThis.__pmdMonacoBase' },
      loader: { '.wasm': 'file', '.ttf': 'file', '.woff2': 'file', '.svg': 'file', '.png': 'file' },
      assetNames: '[name]',
    },
    // P10 (AD-P10-01): pagemd's runtime, an ES module (pagemd finds its vendor files from `import.meta.url`), split so shiki's
    // grammars load only when used. `require` is given for the CommonJS libraries inside.
    runtime: {
      ...common,
      entryPoints: { runtime: 'packages/output-pagemd/src/runtime.ts' },
      outdir: join(outdir, 'host', 'pagemd'),
      outExtension: { '.js': '.mjs' },
      platform: 'node',
      format: 'esm',
      target: 'node24',
      splitting: true,
      sourcemap: false,
      external: ['bufferutil', 'utf-8-validate'],
      banner: { js: "import { createRequire as __pmdCreateRequire } from 'node:module'; const require = __pmdCreateRequire(import.meta.url);" },
      plugins: [commonLinks(), fromCheckout(pagemdCheckout())],
    },
  };
}

/**
 * Builds pagemd's runtime (P10) when the checkout is there; without it the editor still builds and runs, and Print Preview
 * and Export fall back to plain HTML (output-html). Returns the runtime file, or null.
 */
export async function buildRuntime(outdir = defaultOutdir, checkout = pagemdCheckout()) {
  if (!existsSync(join(checkout, 'packages', 'exporters', 'src', 'index.js'))) {
    console.warn(`esbuild: no pagemd checkout at ${checkout} (set PAGEMD_CHECKOUT): Print Preview and Export use plain HTML.`);
    return null;
  }
  const { runtime } = bundleOptions(outdir);
  await esbuild.build({ ...runtime, plugins: [commonLinks(checkout), fromCheckout(checkout)] });
  copyPagemdVendor(outdir, checkout);
  return join(outdir, 'host', 'pagemd', 'runtime.mjs');
}

/**
 * The files `monaco-vscode.js` reads at run time (experiment): the grammar engine's wasm, the markdown grammar and the default themes,
 * from the `@codingame` packages, to where the script looks for them (relative to itself).
 */
export function copyMonacoVscodeFiles(outdir = defaultOutdir) {
  const nm = join(root, 'node_modules', '@codingame');
  const target = join(outdir, 'webview', 'monaco');
  mkdirSync(join(target, 'external', 'vscode-oniguruma', 'release'), { recursive: true });
  cpSync(join(nm, 'monaco-vscode-textmate-service-override', 'external', 'vscode-oniguruma', 'release', 'onig.wasm'), join(target, 'external', 'vscode-oniguruma', 'release', 'onig.wasm'));
  for (const extension of ['monaco-vscode-markdown-basics-default-extension', 'monaco-vscode-theme-defaults-default-extension']) {
    cpSync(join(nm, extension, 'resources'), join(target, 'resources'), { recursive: true });
  }
  return target;
}

/** Builds both bundles once, plus pagemd's bundled defaults/ (R-128). Returns the output file paths. */
export async function build(outdir = defaultOutdir) {
  const { host, webview, monacoVscode } = bundleOptions(outdir);
  const [, , , runtime] = await Promise.all([esbuild.build(host), esbuild.build(webview), esbuild.build(monacoVscode), buildRuntime(outdir)]);
  copyMonacoVscodeFiles(outdir);
  const defaults = copyDefaults(outdir);
  copyCodicons(outdir);
  copyMermaid(outdir);
  return { host: host.outfile, webview: webview.outfile, defaults, runtime };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--watch')) {
    const { host, webview, monacoVscode } = bundleOptions();
    copyMonacoVscodeFiles();
    for (const opts of [host, webview, monacoVscode]) await (await esbuild.context(opts)).watch();
    copyDefaults();
    copyCodicons();
    copyMermaid();
    await buildRuntime();
    console.log('esbuild: watching host + webview (pagemd runtime built once)');
  } else {
    // P13: a clean dist/ every time (pagemd's runtime is split into hashed chunks, so old ones would pile up and ship in the .vsix)
    rmSync(defaultOutdir, { recursive: true, force: true });
    const out = await build();
    console.log(`esbuild: built\n  host    ${out.host}\n  webview ${out.webview}\n  defaults ${out.defaults}\n  runtime ${out.runtime ?? '(none: plain HTML)'}`);
  }
}
