// Runs the suites on Windows from WSL (P13, amendment 5, AD-P13-05). The repo's node_modules are Linux builds and the folder is shared
// by WSL and Windows, so Windows gets its own working copy: a sibling git worktree (`pagemd-editor-win`, so the `../pagemd/...` links
// still resolve) with its own `npm ci` made by Windows Node. Nothing in the shared folder is touched.
// Usage (from WSL):  node scripts/windows.mjs setup            create / update the worktree at HEAD and run `npm ci` in it
//                    node scripts/windows.mjs run <script>...  e.g. check test test:e2e test:vscode test:vsix (npm run <script> each)
//                    node scripts/windows.mjs remove           remove the worktree
// Windows Node must be on the PATH of cmd.exe. Its version is printed, because the repos pin Node 24.21.0 (.nvmrc).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worktree = join(dirname(root), `${basename(root)}-win`);
/** /mnt/c/Users/x -> C:\Users\x */
const toWindows = (path) => path.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replaceAll('/', '\\');
if (!root.startsWith('/mnt/')) throw new Error('windows.mjs runs from WSL, in a repo on a Windows drive (/mnt/c/...).');

const cmd = (line, { quiet = false } = {}) => {
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `cd /d ${toWindows(worktree)} && ${line}`], { cwd: '/mnt/c', stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  return result.status ?? 1;
};
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

const [command, ...rest] = process.argv.slice(2);
if (command === 'setup') {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(); // the shared folder's HEAD, not the worktree's
  if (existsSync(worktree)) {
    const checkout = spawnSync('git', ['-C', worktree, 'checkout', '--detach', head], { stdio: 'inherit' });
    if (checkout.status !== 0) throw new Error(`git checkout --detach ${head} failed in ${worktree}: the Windows run would test an old commit`);
  } else git('worktree', 'add', '--detach', worktree, head);
  // The worktree is at the commit HEAD names; the shared folder's uncommitted work is NOT in it (commit first).
  process.exitCode = cmd('node -v && npm -v && npm ci');
} else if (command === 'run') {
  let failed = 0;
  cmd('node -v');
  for (const script of rest) {
    console.log(`\n=== windows: npm run ${script}`);
    const status = cmd(`npm run ${script}`);
    console.log(`=== windows: npm run ${script} -> exit ${status}`);
    if (status !== 0) failed++;
  }
  process.exitCode = failed ? 1 : 0;
} else if (command === 'remove') {
  git('worktree', 'remove', '--force', worktree);
  git('worktree', 'prune');
} else {
  console.log('usage: node scripts/windows.mjs setup | run <npm script>... | remove');
  process.exitCode = 2;
}
