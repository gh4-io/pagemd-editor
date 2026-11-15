// Layer-rule self-test (P0). Proves every rule in .dependency-cruiser.cjs can fail:
// it plants wrong-direction imports into the real tree (files named *zz-selftest*, git-ignored,
// deleted afterwards), runs the same command as `npm run lint:layers`, and expects exactly the
// planted violations. Several plants sit in packages that don't exist yet, so only a folder PATTERN
// covers them (the P0 acceptance criterion).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

interface Violation {
  from: string;
  to: string;
  rule: string;
}

/**
 * Runs the checker twice: the exact `npm run lint:layers` command (its exit code is what fails
 * `npm run check`), and the JSON report to see which rules broke. The JSON report always exits 0.
 */
function cruise(): { status: number | null; violations: Violation[]; cruised: string[] } {
  // Windows: npm's `.cmd` shim, run through a shell (Node refuses to run .cmd files without one)
  const win = process.platform === 'win32';
  const bin = join(root, 'node_modules/.bin', win ? 'depcruise.cmd' : 'depcruise');
  const args = ['packages', 'apps', '--config', '.dependency-cruiser.cjs'];
  const lint = spawnSync(bin, args, { cwd: root, encoding: 'utf8', shell: win });
  const json = spawnSync(bin, [...args, '--output-type', 'json'], { cwd: root, encoding: 'utf8', shell: win });
  if (!json.stdout) throw new Error(`depcruise produced no output: ${json.stderr}`);
  const report = JSON.parse(json.stdout) as {
    modules: { source: string }[];
    summary: { violations: { from: string; to: string; rule: { name: string } }[] };
  };
  return {
    status: lint.status,
    violations: report.summary.violations.map((v) => ({ from: v.from, to: v.to, rule: v.rule.name })),
    cruised: report.modules.map((m) => m.source),
  };
}

/** Every source file the rules cover: .ts under packages/ and apps/, minus tests, dist and node_modules. */
function sourceFiles(dir = join(root, 'packages'), found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'test'].includes(entry.name)) sourceFiles(full, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(relative(root, full).split('\\').join('/'));
    }
  }
  return found;
}

// [file, source, rules it must break]. An empty list = a positive control that must stay clean.
const PLANTS: [string, string, string[]][] = [
  // existing packages, one per layer rule
  ['packages/core/src/zz-selftest-up.ts', `import '@pagemd-editor/transformer';`, ['core-is-the-bottom']],
  ['packages/transformer/src/zz-selftest.ts', `import '@pagemd-editor/preset-commonmark';`, ['transformer-uses-core-only']],
  ['packages/lossless/src/zz-selftest.ts', `import '@pagemd-editor/plugin-history';`, ['lossless-uses-transformer-core']],
  ['packages/preset-commonmark/src/zz-selftest.ts', `import '@pagemd-editor/lossless';`, ['presets-use-transformer-core']],
  ['packages/plugin-history/src/zz-selftest.ts', `import '@pagemd-editor/canvas';`, ['plugins-use-transformer-core']],
  ['packages/components/canvas/src/zz-selftest.ts', `import '@pagemd-editor/transformer';`, ['components-use-core']],
  // packages covered ONLY by a pattern (no such package exists in P0)
  ['packages/style-zz-selftest/src/index.ts', `import '@pagemd-editor/transformer';`, ['styles-use-core']],
  ['packages/output-zz-selftest/src/index.ts', `import '@pagemd-editor/preset-commonmark';`, ['outputs-use-core']],
  ['packages/preset-zz-selftest/src/index.ts', `import '@pagemd-editor/plugin-history';`, ['presets-use-transformer-core']],
  ['packages/plugin-zz-selftest/src/index.ts', `import '@pagemd/syntax';\nimport '../../plugin-history/src/index.ts';`, ['pagemd-only-in-allowed-packages', 'plugins-use-transformer-core']],
  ['packages/components/zz-selftest/src/index.ts', `import type { commonmarkPreset } from '@pagemd-editor/preset-commonmark';\nexport type T = typeof commonmarkPreset;`, ['components-use-core']],
  // outside dependencies and the app
  ['packages/core/src/zz-selftest-vscode.ts', `import 'vscode';`, ['vscode-only-in-host']],
  ['packages/core/src/zz-selftest-app.ts', `import '../../../apps/vscode/webview/main.ts';`, ['packages-not-to-apps', 'core-is-the-bottom']],
  ['apps/vscode/webview/zz-selftest-vscode.ts', `import 'vscode';`, ['vscode-only-in-host']],
  ['apps/vscode/webview/zz-selftest-host.ts', `import '../host/extension.ts';`, ['host-and-webview-apart']],
  // the message contract (P2): shared by both sides, so it leans on neither, and on core types only
  ['apps/vscode/shared/zz-selftest-host.ts', `import '../host/extension.ts';`, ['shared-stays-neutral', 'shared-uses-core-only']],
  ['apps/vscode/shared/zz-selftest-webview.ts', `import '../webview/views.ts';`, ['shared-stays-neutral', 'shared-uses-core-only']],
  ['apps/vscode/shared/zz-selftest-vscode.ts', `import 'vscode';`, ['vscode-only-in-host']],
  ['apps/vscode/shared/zz-selftest-pkg.ts', `import '@pagemd-editor/transformer';`, ['shared-uses-core-only']],
  // style-pagemd (P5, amendment 12): only the host may import it
  ['apps/vscode/webview/zz-selftest-style.ts', `import '@pagemd-editor/style-pagemd';`, ['style-pagemd-only-in-host']],
  ['apps/vscode/shared/zz-selftest-style.ts', `import type { StyleNote } from '@pagemd-editor/style-pagemd';\nexport type T = StyleNote;`, ['style-pagemd-only-in-host', 'shared-uses-core-only']],
  ['packages/preset-zz-selftest/src/style.ts', `import '../../style-pagemd/src/index.ts';`, ['style-pagemd-only-in-host', 'presets-use-transformer-core']],
  // output providers (P10): only the host may import them; output-pagemd alone may import pagemd
  ['apps/vscode/webview/zz-selftest-output.ts', `import '@pagemd-editor/output-pagemd';`, ['outputs-only-in-host']],
  ['packages/components/zz-selftest-output/src/index.ts', `import '../../../output-html/src/index.ts';`, ['outputs-only-in-host', 'components-use-core']],
  ['packages/output-html/src/zz-selftest-pagemd.ts', `import '@pagemd/exporters';`, ['pagemd-only-in-allowed-packages']],
  // plugin-diagnostics (P14): only the host may import its checks; its hints stay free of @pagemd/*
  ['apps/vscode/webview/zz-selftest-diag.ts', `import '@pagemd-editor/plugin-diagnostics/check';`, ['diagnostics-checks-only-in-host']],
  ['packages/components/zz-selftest-diag/src/index.ts', `import '../../../plugin-diagnostics/src/check.ts';`, ['diagnostics-checks-only-in-host', 'components-use-core']],
  ['packages/plugin-diagnostics/src/zz-selftest-hints.ts', `import '@pagemd/validate';\nimport './check.ts';`, ['diagnostics-hints-stay-pagemd-free']],
  // image-editor (P15, D30; narrowed in P27): the dialog only, not even core (allowed for other components) or ProseMirror
  ['packages/components/image-editor/src/zz-selftest.ts', `import 'prosemirror-state';\nimport '@pagemd-editor/core';`, ['image-editor-dialogs-only']],
  // hygiene
  ['packages/core/src/zz-selftest-a.ts', `import './zz-selftest-b.ts';`, ['no-circular']],
  ['packages/core/src/zz-selftest-b.ts', `import './zz-selftest-a.ts';`, []], // a circle is reported once, from its first file
  ['packages/core/src/zz-selftest-typo.ts', `import './does-not-exist.ts';`, ['not-to-unresolvable']],
  // positive controls: allowed directions must stay clean
  ['packages/preset-pagemd/src/zz-selftest-ok.ts', `import '@pagemd/syntax';\nimport '@pagemd-editor/transformer';`, []],
  ['packages/style-zz-selftest/src/ok.ts', `import '@pagemd-editor/core';\nimport './index.ts';`, []],
  ['apps/vscode/host/zz-selftest-ok.ts', `import 'vscode';\nimport '@pagemd-editor/lossless';\nimport '@pagemd-editor/style-pagemd';\nimport '@pagemd-editor/output-pagemd';\nimport '../shared/protocol.ts';`, []],
  ['packages/output-pagemd/src/zz-selftest-ok.ts', `import '@pagemd/exporters';\nimport '@pagemd-editor/core';`, []],
  ['apps/vscode/webview/zz-selftest-ok.ts', `import '../shared/channel.ts';\nimport '@pagemd-editor/plugin-diagnostics';`, []],
  ['apps/vscode/shared/zz-selftest-ok.ts', `import type { TextEdit } from '@pagemd-editor/core';\nexport type T = TextEdit;`, []],
];

/** Deletes the planted files, then any folders the plants left empty. Never touches real files. */
function removePlants(): void {
  for (const [file] of PLANTS) {
    rmSync(join(root, file), { force: true });
    for (let dir = dirname(join(root, file)); !['packages', 'apps', 'vscode'].includes(basename(dir)); dir = dirname(dir)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    }
  }
}

// Each cruise runs the checker twice (~3 s each on a /mnt/c checkout).
describe('layer rules (dependency-cruiser)', { timeout: 60_000 }, () => {
  beforeAll(removePlants);
  afterAll(removePlants);

  it('pass on the real tree', () => {
    const { status, violations } = cruise();
    expect(violations).toEqual([]);
    expect(status).toBe(0);
  });

  // Guard (U1): with a TypeScript it can't use (7.x today), dependency-cruiser reads 0 files and
  // reports "no violations" with exit 0. Every source file must have been read.
  it('read every source file (a checker that reads nothing must not pass)', () => {
    const { cruised } = cruise();
    const files = [...sourceFiles(), ...sourceFiles(join(root, 'apps'))];
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !cruised.includes(f))).toEqual([]);
  });

  it('fail on every planted wrong-direction import, and only on those', () => {
    for (const [file, source] of PLANTS) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `// layer-rule self-test plant; deleted by the test\n${source}\n`);
    }
    try {
      const { status, violations } = cruise();
      expect(status).not.toBe(0);

      const found = new Set(violations.map((v) => `${v.from} :: ${v.rule}`));
      const expected = new Set(PLANTS.flatMap(([file, , rules]) => rules.map((rule) => `${file} :: ${rule}`)));
      expect([...found].sort()).toEqual([...expected].sort());
    } finally {
      removePlants();
    }
  });

  it('every package folder matches a layer pattern, so no package escapes the rules', () => {
    const known = /^(core|transformer|lossless|components|(preset|plugin|style|output)-[a-z0-9-]+)$/;
    const folders = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(folders.map((d) => d.name).filter((name) => !known.test(name))).toEqual([]);
  });
});
