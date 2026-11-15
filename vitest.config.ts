import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * pagemd-common's packages, imported from inside the pagemd or pagemd-common checkout (siblings of this repo), resolve through this
 * repo's own links to the same pagemd-common checkout (P13a, AD-P13-21). The checkouts' own `node_modules/@pagemd/*` are Linux
 * symlinks that Windows cannot follow; both ways lead to the same files, so on Linux nothing changes. Same rule as esbuild.mjs.
 */
const commonLinks = {
  name: 'pagemd-common-links',
  enforce: 'pre' as const,
  async resolveId(this: { resolve(source: string, importer: string, options: object): Promise<unknown> }, source: string, importer: string | undefined, options: object) {
    if (!importer || !/^@pagemd\/(resolver|syntax|meta|theme-kit|validate)(\/.*)?$/.test(source)) return null;
    const siblings = ['pagemd', 'pagemd-common'].map((n) => join(root, '..', n).replaceAll('\\', '/') + '/');
    if (!siblings.some((s) => importer.replaceAll('\\', '/').startsWith(s))) return null;
    return this.resolve(source, join(root, 'package.json'), { ...options, skipSelf: true });
  },
};

/** Phase L2: the shared profiles folder is never the user's real one in a test (PAGEMD_CONFIG_DIR moves it; an empty temporary folder). */
const PAGEMD_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'pagemd-test-config-'));

export default defineConfig({
  plugins: [commonLinks],
  resolve: {
    // Host code imports 'vscode', which only exists inside VS Code. Tests get the stand-in.
    alias: { vscode: fileURLToPath(new URL('./__mocks__/vscode.ts', import.meta.url)) },
  },
  test: {
    // The sibling checkouts are loaded through Vite too (not by Node itself), so the plugin above resolves their imports.
    server: { deps: { inline: [/[\\/]pagemd[\\/]project[\\/]/] } },
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/components/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    // Playwright (test/e2e) and the VS Code test host (test/vscode) have their own runners.
    exclude: ['test/e2e/**', 'test/vscode/**', '**/node_modules/**'],
    env: { PAGEMD_CONFIG_DIR },
  },
});
