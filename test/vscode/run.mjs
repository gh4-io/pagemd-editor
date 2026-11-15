// The editor in a real VS Code: activation, then open → type → save → git diff, undo, outside changes (P2) (the "extension test host"). Run: npm run test:vscode.
// Downloads VS Code into .vscode-test/ on first run. On WSL it needs a display (WSLg or xvfb-run).
import { runTests } from '@vscode/test-electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Node 24 strips the types of this plain generator (P13: the large document of step 19 and of the e2e benchmark).
import { largeDocument } from '../e2e/fixtures/large.ts';

// Pinned to the newest stable VS Code (P6, 2026-10-03); the manifest accepts ^1.140.0 (the newest @types/vscode).
const VSCODE_VERSION = '1.140.0';

const root = fileURLToPath(new URL('../..', import.meta.url));
const userDataDir = mkdtempSync(join(tmpdir(), 'pmd-vscode-user-'));
const largeDocPath = join(userDataDir, 'large-benchmark.md');
writeFileSync(largeDocPath, largeDocument(110));

try {
  await runTests({
    version: VSCODE_VERSION,
    extensionDevelopmentPath: join(root, 'apps/vscode'),
    extensionTestsPath: join(root, 'test/vscode', process.env['PMD_SUITE'] ?? 'suite.cjs'),
    // Unlocks the test-only handles (R-89); never set outside the test runner.
    // Phase L2: PAGEMD_CONFIG_DIR moves the shared profiles folder into this run's temporary folder (never the user's real one).
    extensionTestsEnv: { PMD_TEST: '1', PMD_LARGE_DOC: largeDocPath, PMD_USER_DATA: userDataDir, PAGEMD_CONFIG_DIR: join(userDataDir, 'pagemd-config') },
    // `--remote-debugging-port=0`: the window's own DevTools port (loopback, only while the tests run) so step 20 can take a screenshot
    // of the real window in a high-contrast theme; Electron writes the port it chose to DevToolsActivePort in the user-data folder.
    launchArgs: ['--disable-extensions', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir', userDataDir],
  });
  console.log('VS Code tests: passed');
} catch (error) {
  console.error('VS Code tests: FAILED', error);
  process.exitCode = 1;
} finally {
  rmSync(userDataDir, { recursive: true, force: true });
}
