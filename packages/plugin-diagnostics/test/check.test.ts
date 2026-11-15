/// <reference path="../../style-pagemd/src/pagemd-modules.d.ts" />
// plugin-diagnostics' host entry (P14): the checks are @pagemd/validate's, and the editor answers what the CLI answers.
// The shared fixture lives in pagemd-common (packages/validate/test/fixtures/shared/); its expected.json is checked by
// pagemd-common itself, by pagemd's CLI (tests/integration/validate-command.test.js) and here (C8/P14 acceptance: "the
// same Diagnostic[] in the CLI and the editor").
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryFileSystem, type FileSystem } from '@pagemd/resolver';
import { checkDocument, codeOf, lineRange, lineStarts, toCoreDiagnostics, type PagemdDiagnostic } from '../src/check.ts';

const FIXTURE = fileURLToPath(new URL('../../../../pagemd-common/packages/validate/test/fixtures/shared/', import.meta.url)).replace(/[\\/]$/, '');

/** The host's file system port, as VS Code's API answers it: every method a Promise. */
const asyncNodeFs: FileSystem = {
  exists: (p) => Promise.resolve(fs.existsSync(p)),
  readText: (p) => fs.promises.readFile(p, 'utf8'),
  stat: async (p) => {
    try {
      const s = await fs.promises.stat(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  list: (p) => fs.promises.readdir(p),
};

const placeholders = <T>(value: T): T => JSON.parse(JSON.stringify(value).split(JSON.stringify(FIXTURE).slice(1, -1)).join('<fixture>').replace(/\\\\/g, '/')) as T;

describe('the shared fixture: the editor answers what the CLI answers', () => {
  const expected = JSON.parse(fs.readFileSync(nodePath.join(FIXTURE, 'expected.json'), 'utf8')) as Record<string, unknown>;

  it.each(Object.keys(expected))('%s', async (rel) => {
    const file = nodePath.join(FIXTURE, rel);
    const result = await checkDocument(
      { path: file, text: fs.readFileSync(file, 'utf8') },
      { fs: asyncNodeFs, pagemdPath: nodePath.join(FIXTURE, 'defaults'), homePath: nodePath.join(FIXTURE, 'home'), sharedProfilesPath: nodePath.join(FIXTURE, 'config', 'profiles'), cwd: FIXTURE, path: nodePath, cache: new Map() },
    );
    expect(placeholders(result)).toEqual(expected[rel]);
  });
});

describe('checkDocument', () => {
  const files = {
    '/p/package.json': '{}',
    '/d/profiles/standard_letter.json': JSON.stringify({ id: 'standard_letter', validation: { required_fields: ['title'] } }),
    '/d/profiles/quiet.json': JSON.stringify({ id: 'quiet' }),
  };
  const env = { fs: createMemoryFileSystem(files).async(), pagemdPath: '/d', homePath: '/h' };

  it('a document that is not a file: nothing to check', async () => {
    expect(await checkDocument({ path: null, text: '# x' }, env)).toBe(null);
  });

  it('a profile without a validation setting: no checks (R-30)', async () => {
    const result = await checkDocument({ path: '/p/a.md', text: '---\nprofile: quiet\n---\n<!-- ::BREAK -->\n' }, env);
    expect(result).toMatchObject({ enabled: false, diagnostics: [] });
  });

  it('a profile that asks: its checks, unsaved text included', async () => {
    const result = await checkDocument({ path: '/p/a.md', text: '# no title yet\n' }, env);
    expect(result!.enabled).toBe(true);
    expect(result!.diagnostics.map(codeOf)).toEqual(['meta/missing-required-field', 'template/template-not-found']);
  });
});

describe('toCoreDiagnostics', () => {
  const d = (line: number | undefined, severity: PagemdDiagnostic['severity'] = 'warning'): PagemdDiagnostic => ({ severity, level: 'syntax', code: 'x', message: `m${line}`, ...(line === undefined ? {} : { where: { line } }) });

  it('lines and their ranges (LF and CRLF)', () => {
    const text = 'a\r\nbb\nccc';
    const starts = lineStarts(text);
    expect(starts).toEqual([0, 3, 6]);
    expect(lineRange(text, starts, 0)).toEqual({ from: 0, to: 1 });
    expect(lineRange(text, starts, 1)).toEqual({ from: 3, to: 5 });
    expect(lineRange(text, starts, 2)).toEqual({ from: 6, to: 9 });
    expect(lineRange(text, starts, 9)).toEqual({ from: 9, to: 9 });
  });

  it('a problem on a line covers it; one elsewhere (or on line 0) sits at the start', () => {
    const text = '---\ntitle: x\n---\n# H\n';
    expect(toCoreDiagnostics(text, [d(3, 'error'), d(undefined), d(0)])).toEqual([
      { from: 17, to: 20, severity: 'error', message: 'm3', code: 'syntax/x', source: 'pagemd' },
      { from: 0, to: 0, severity: 'warning', message: 'mundefined', code: 'syntax/x', source: 'pagemd' },
      { from: 0, to: 0, severity: 'warning', message: 'm0', code: 'syntax/x', source: 'pagemd' },
    ]);
  });
});
