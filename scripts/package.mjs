// `npm run package` (P13, AD-P13-01..03): builds the extension from a clean dist/ and packs apps/vscode into
// pagemd-editor-<version>.vsix at the repo root, then checks what went in (size, no source maps / sources / node_modules).
// vsce runs with --no-dependencies: everything is bundled, so it must never read the workspace's node_modules.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, rewriteVersion } from './build-version.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = join(root, 'apps', 'vscode');
const MAX_BYTES = 10 * 1024 * 1024;
const node = process.execPath;
// PMD_PACKAGING lets apps/vscode's `vscode:prepublish` guard through: a bare `vsce package` or `vsce publish` stops there (R-209).
const run = (args, cwd = root) => execFileSync(node, args, { cwd, stdio: 'inherit', env: { ...process.env, PMD_PACKAGING: '1' } });
const vsce = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');

/** The licence files every .vsix carries (SAN-0b): copied from the repo root into apps/vscode before vsce runs. */
export const LICENCE_FILES = ['LICENSE', 'NOTICE'];

/** Files that must never be in the package (acceptance 1). */
export const FORBIDDEN = [/\.map$/, /\.tsx?$/, /(^|\/)node_modules\//, /(^|\/)\.env/, /(^|\/)test\//];

export function packageName() {
  const manifest = JSON.parse(readFileSync(join(ext, 'package.json'), 'utf8'));
  return `${manifest.name}-${manifest.version}.vsix`;
}

/** The generated build-info file the extension shows in "pagemd: About this build" and the status bar (git-ignored: it lives in dist/). */
export function buildInfo(version, commit, date = new Date()) {
  return { version, commit, date: date.toISOString().slice(0, 10) };
}

/** `--rc` or `--release`: bump the number in apps/vscode/package.json (and the lock file) first. Plain `package` never changes it. */
function bump(mode) {
  const manifestFile = join(ext, 'package.json');
  const lockFile = join(root, 'package-lock.json');
  const manifestText = readFileSync(manifestFile, 'utf8');
  const from = JSON.parse(manifestText).version;
  const to = bumpVersion(from, mode);
  const next = rewriteVersion(manifestText, readFileSync(lockFile, 'utf8'), from, to);
  writeFileSync(manifestFile, next.packageText);
  writeFileSync(lockFile, next.lockText);
  console.log(`package: version ${from} -> ${to}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.includes('--rc') && flags.includes('--release')) throw new Error('package: use --rc or --release, not both');
  if (flags.includes('--rc')) bump('rc');
  if (flags.includes('--release')) bump('release');
  run([join(root, 'esbuild.mjs')]);
  // build-info.json (version, git short commit, date) goes into dist/, which is git-ignored and packed with the extension.
  const version = JSON.parse(readFileSync(join(ext, 'package.json'), 'utf8')).version;
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  mkdirSync(join(ext, 'dist'), { recursive: true });
  writeFileSync(join(ext, 'dist', 'build-info.json'), JSON.stringify(buildInfo(version, commit), null, 2) + '\n');
  run([join(root, 'scripts', 'third-party-notices.mjs'), '--check']); // the notices must be current before anything ships
  // The .vsix carries the changelog (a git-ignored copy). Links to the repo's own docs would be dead inside VS Code and vsce
  // refuses relative links without a repository URL (AD-P13-03), so they are reduced to their text.
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(/\[([^\]]+)\]\((?!https?:|#|mailto:)[^)]*\)/g, '$1');
  writeFileSync(join(ext, 'CHANGELOG.md'), changelog);
  // The licence (Apache-2.0, R-267) and its NOTICE travel in the .vsix: git-ignored copies of the repo's own files (SAN-0b)
  for (const name of LICENCE_FILES) copyFileSync(join(root, name), join(ext, name));
  const out = join(root, packageName());
  // no `repository` while the project is local (AD-P13-03)
  run([vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--out', out], ext);
  const listing = execFileSync(node, [vsce, 'ls', '--no-dependencies'], { cwd: ext, encoding: 'utf8', env: { ...process.env, PMD_PACKAGING: '1' } }).split('\n').map((l) => l.trim()).filter(Boolean);
  const bad = listing.filter((f) => FORBIDDEN.some((re) => re.test(f)));
  const size = statSync(out).size;
  if (bad.length) throw new Error(`package: forbidden files in the .vsix: ${bad.slice(0, 10).join(', ')}`);
  const missing = LICENCE_FILES.filter((name) => !listing.includes(name));
  if (missing.length) throw new Error(`package: the .vsix lacks ${missing.join(' and ')} (apps/vscode/.vscodeignore must let them in)`);
  if (size > MAX_BYTES) throw new Error(`package: ${out} is ${(size / 1048576).toFixed(2)} MB, over the 10 MB budget`);
  console.log(`package: ${out} (${(size / 1048576).toFixed(2)} MB, ${listing.length} files)`);
}
