// The packaged extension, installed (P13, amendment 9, AD-P13-06): `npm run test:vsix`.
// 1. packages the .vsix (scripts/package.mjs), 2. installs it into a clean VS Code (an empty --extensions-dir and
// --user-data-dir; the editor is NOT given as a development path), 3. starts that VS Code with a tiny probe extension
// (test/vsix/probe) whose suite checks what VS Code itself reports. The test-only handles (R-89) are not unlocked: PMD_TEST is
// not set, so a handle that answered anyway would fail the suite. Downloads VS Code into .vscode-test/ like test:vscode.
// Usage: node test/vsix/run.mjs [--no-package]   (--no-package re-uses the .vsix already built)
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The newest stable VS Code, the same as test:vscode (a clean download, never the machine's own install).
const VSCODE_VERSION = process.env.PMD_VSCODE_VERSION || '1.140.0';

const root = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'apps/vscode/package.json'), 'utf8'));
const vsix = join(root, `${manifest.name}-${manifest.version}.vsix`);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pmd-vsix-')));
const userDataDir = join(scratch, 'user-data');
const extensionsDir = join(scratch, 'extensions');
mkdirSync(join(userDataDir, 'User'), { recursive: true });
mkdirSync(extensionsDir, { recursive: true });
// VS Code's own file dialog (not the system's) so the probe can answer "Export" without a person.
writeFileSync(join(userDataDir, 'User', 'settings.json'), JSON.stringify({ 'files.simpleDialog.enable': true, 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false }));

try {
  if (!process.argv.includes('--no-package')) execFileSync(process.execPath, [join(root, 'scripts/package.mjs')], { stdio: 'inherit', cwd: root });
  if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package`);

  const vscodeExecutablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  // Linux/WSL: the editor's own command-line script, run by VS Code's Electron as plain Node (the `code` shell wrapper asks
  // questions under WSL). Windows: the archive's own `code.cmd`.
  const installArgs = ['--install-extension', vsix, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir];
  const install =
    process.platform === 'win32'
      ? spawnSync(`"${resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath)}"`, installArgs.map((a) => `"${a}"`), { encoding: 'utf8', shell: true })
      : spawnSync(vscodeExecutablePath, [join(dirname(vscodeExecutablePath), 'resources', 'app', 'out', 'cli.js'), ...installArgs], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.stdout.write(install.stdout ?? '');
  if (install.status !== 0 || !/successfully installed/i.test(`${install.stdout}${install.stderr}`)) throw new Error(`installing the .vsix failed:\n${install.stdout}\n${install.stderr}`);

  // R-234: the version VS Code lists for the installed extension is the one in the manifest (an -rc.N build shows as such).
  const listArgs = ['--list-extensions', '--show-versions', '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir];
  const listed =
    process.platform === 'win32'
      ? spawnSync(`"${resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath)}"`, listArgs.map((a) => `"${a}"`), { encoding: 'utf8', shell: true })
      : spawnSync(vscodeExecutablePath, [join(dirname(vscodeExecutablePath), 'resources', 'app', 'out', 'cli.js'), ...listArgs], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  if (!`${listed.stdout}`.split(/\r?\n/).includes(`${manifest.publisher}.${manifest.name}@${manifest.version}`)) throw new Error(`VS Code lists the installed extensions as:\n${listed.stdout}\nexpected ${manifest.publisher}.${manifest.name}@${manifest.version}`);
  console.log(`VS Code lists ${manifest.publisher}.${manifest.name}@${manifest.version}`);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: join(root, 'test/vsix/probe'),
    extensionTestsPath: join(root, 'test/vsix/suite.cjs'),
    extensionTestsEnv: { PMD_VSIX_EXTENSIONS_DIR: extensionsDir, PMD_VSIX_USER_DATA: userDataDir, PMD_VSIX_VERSION: manifest.version, PMD_TEST: '' },
    launchArgs: ['--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--disable-gpu', '--no-sandbox'],
  });
  console.log('VSIX tests: passed');
} catch (error) {
  console.error('VSIX tests: FAILED', error);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
