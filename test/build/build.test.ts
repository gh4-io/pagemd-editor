// `npm run build` produces both bundles, in the right formats (P0 acceptance criterion), plus pagemd's bundled
// defaults/ (P5, R-128) next to the host bundle.
// Builds into a temporary folder so the test never depends on (or overwrites) apps/vscode/dist.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error esbuild.mjs is plain JavaScript without type declarations
import { build } from '../../esbuild.mjs';
import * as vscodeMock from '../../__mocks__/vscode.ts';
import { PROTOCOL_VERSION } from '../../apps/vscode/shared/protocol.ts';

const nodeRequire = createRequire(import.meta.url);
let outdir: string;
let out: { host: string; webview: string; defaults: string; runtime: string | null };

// P10: the build includes pagemd's runtime file (a few seconds more, longer while other test files run)
beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), 'pmd-build-'));
  out = await build(outdir);
}, 120_000);
afterAll(() => rmSync(outdir, { recursive: true, force: true }));

describe('esbuild bundles', () => {
  it('host bundle is CommonJS, leaves vscode to VS Code, and activates', () => {
    const code = readFileSync(out.host, 'utf8');
    const module = { exports: {} as Record<string, unknown> };
    // Only vscode and Node's built-ins may stay outside the bundle.
    const requireStub = (id: string) => {
      if (id === 'vscode') return vscodeMock;
      if (isBuiltin(id)) return nodeRequire(id);
      throw new Error(`host bundle requires an unbundled module: ${id}`);
    };
    runInNewContext(code, { module, exports: module.exports, require: requireStub, process: { env: {} } });

    const activate = module.exports['activate'] as (ctx: unknown) => unknown;
    expect(typeof activate).toBe('function');
    vscodeMock.resetMock();
    expect(activate(vscodeMock.createExtensionContext())).toEqual({ viewType: 'pagemd-editor.editor' });
    expect(vscodeMock.registeredEditors.map((e) => e.viewType)).toEqual(['pagemd-editor.editor']);
  });

  it('webview bundle is self-contained browser code with no require and no vscode', () => {
    const code = readFileSync(out.webview, 'utf8');
    // Comments don't count: linkify-it (inside markdown-it, P1) documents `.tlds(require('tlds'))`.
    const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/["']vscode["']/);

    // It connects through acquireVsCodeApi (the global VS Code gives a webview) and asks for the document.
    const posted: unknown[] = [];
    const listeners: string[] = [];
    runInNewContext(code, {
      acquireVsCodeApi: () => ({ postMessage: (m: unknown) => posted.push(m) }),
      window: { addEventListener: (type: string) => listeners.push(type) },
      // prosemirror-view looks at the browser when it loads (e.g. documentElement.style for WebKit).
      document: { currentScript: null, documentElement: { style: {} } },
    });
    expect(posted).toEqual([{ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } }]);
    expect(listeners).toEqual(['message']);
  });

  it('copies theme-kit\'s defaults/ next to the host bundle, byte for byte (R-128)', () => {
    for (const rel of ['profiles/standard_letter.json', 'layouts/letter.css', 'styles/base.css', 'templates/standard_letter.html']) {
      const built = join(out.defaults, rel);
      expect(existsSync(built), `missing ${rel}`).toBe(true);
      const master = nodeRequire.resolve(`@pagemd/theme-kit/defaults/${rel}`);
      expect(readFileSync(built).equals(readFileSync(master))).toBe(true);
    }
  });

  it("ships VS Code's icons (codicons, R-162) next to the webview bundle, unchanged, with their CC-BY-4.0 licence", () => {
    const appRequire = createRequire(join(process.cwd(), 'apps/vscode/package.json'));
    for (const file of ['codicon.css', 'codicon.ttf']) {
      const built = join(outdir, 'webview', 'codicons', file);
      expect(existsSync(built), `missing ${file}`).toBe(true);
      expect(readFileSync(built).equals(readFileSync(appRequire.resolve(`@vscode/codicons/dist/${file}`)))).toBe(true);
    }
    expect(readFileSync(join(outdir, 'webview', 'codicons', 'LICENSE'), 'utf8')).toContain('Attribution 4.0 International');
    expect(readFileSync(join(process.cwd(), 'apps/vscode/ThirdPartyNotices.txt'), 'utf8')).toMatch(/\n@vscode\/codicons@[^\n]*\n[\s\S]*Attribution 4\.0 International/); // P13: the generated list
  });
  it('P10: builds pagemd\'s runtime file (an ES module) with Paged.js and mermaid next to it, and the webview\'s mermaid (R-167)', () => {
    // With no pagemd checkout the editor still builds (plain-HTML Print Preview); on this machine there is one.
    expect(out.runtime).toBe(join(outdir, 'host', 'pagemd', 'runtime.mjs'));
    const code = readFileSync(out.runtime!, 'utf8');
    expect(code).toMatch(/^import \{ createRequire as __pmdCreateRequire \}/);
    expect(code).toMatch(/export\s*\{[^}]*runtime/);
    for (const file of ['paged.polyfill.js', 'mermaid.min.js']) expect(existsSync(join(outdir, 'host', 'pagemd', 'vendor', file)), file).toBe(true);
    const appRequire = createRequire(join(process.cwd(), 'apps/vscode/package.json'));
    const mermaid = join(outdir, 'webview', 'mermaid', 'mermaid.min.js');
    expect(readFileSync(mermaid).equals(readFileSync(join(appRequire.resolve('mermaid/package.json'), '..', 'dist', 'mermaid.min.js')))).toBe(true);
    expect(readFileSync(join(outdir, 'webview', 'mermaid', 'LICENSE'), 'utf8')).toMatch(/MIT/);
    // the host bundle never contains pagemd itself (it loads the runtime file on first use)
    expect(readFileSync(out.host, 'utf8')).not.toMatch(/puppeteer|__pagedjs_complete|getPagedPolyfillContent/);
  });
});
