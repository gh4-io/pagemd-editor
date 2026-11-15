// R-234: the build-numbering scheme. The bump functions are pure; nothing here touches the real package.json.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript without type declarations
import { bumpVersion, rewriteVersion } from '../../scripts/build-version.mjs';
// @ts-expect-error plain JavaScript without type declarations
import { buildInfo } from '../../scripts/package.mjs';

describe('bumpVersion', () => {
  it('rc: counts up, never resets', () => {
    expect(bumpVersion('0.2.0-rc.0', 'rc')).toBe('0.2.0-rc.1');
    expect(bumpVersion('0.2.0-rc.1', 'rc')).toBe('0.2.0-rc.2');
    expect(bumpVersion('0.2.0-rc.9', 'rc')).toBe('0.2.0-rc.10');
  });
  it('rc: after a final release starts the next minor', () => {
    expect(bumpVersion('0.2.0', 'rc')).toBe('0.3.0-rc.1');
  });
  it('release: drops the rc suffix, and refuses a final version', () => {
    expect(bumpVersion('0.2.0-rc.4', 'release')).toBe('0.2.0');
    expect(() => bumpVersion('0.2.0', 'release')).toThrow(/already a final/);
  });
  it('a published release candidate (rcN, no dot) is kept by release and counted on by rc', () => {
    expect(bumpVersion('0.0.1-rc1', 'release')).toBe('0.0.1-rc1');
    expect(bumpVersion('0.0.1-rc1', 'rc')).toBe('0.0.1-rc2');
    expect(bumpVersion('0.0.1-rc9', 'rc')).toBe('0.0.1-rc10');
    expect(() => bumpVersion('0.0.1-rc1', 'major')).toThrow(/unknown mode/);
  });
  it('refuses anything else', () => {
    expect(() => bumpVersion('0.2.0-beta.1', 'rc')).toThrow(/neither/);
    expect(() => bumpVersion('0.2.0-rc.1', 'major')).toThrow(/unknown mode/);
  });
});

describe('rewriteVersion', () => {
  const pkg = '{\n  "name": "pagemd-editor",\n  "version": "0.2.0-rc.1",\n  "other": "0.2.0-rc.1"\n}\n';
  const lock = '{\n  "packages": {\n    "apps/vscode": {\n      "name": "pagemd-editor",\n      "version": "0.2.0-rc.1",\n      "license": "X"\n    },\n    "x": {\n      "version": "0.2.0-rc.1"\n    }\n  }\n}\n';
  it('changes only the version lines, byte for byte otherwise', () => {
    const out = rewriteVersion(pkg, lock, '0.2.0-rc.1', '0.2.0-rc.2');
    expect(out.packageText).toBe(pkg.replace('"version": "0.2.0-rc.1"', '"version": "0.2.0-rc.2"'));
    expect(out.lockText).toBe(lock.replace('"name": "pagemd-editor",\n      "version": "0.2.0-rc.1"', '"name": "pagemd-editor",\n      "version": "0.2.0-rc.2"'));
  });
  it('throws when the files do not hold the expected version', () => {
    expect(() => rewriteVersion(pkg, lock, '0.2.0-rc.5', '0.2.0-rc.6')).toThrow(/package.json/);
    expect(() => rewriteVersion(pkg, lock.replace('rc.1', 'rc.7'), '0.2.0-rc.1', '0.2.0-rc.2')).toThrow(/package-lock/);
  });
});

describe('the committed numbers', () => {
  it('apps/vscode/package.json and package-lock.json agree and are X.Y.Z, X.Y.Z-rc.N or X.Y.Z-rcN', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../apps/vscode/package.json', import.meta.url), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string }> };
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-rc\.?\d+)?$/);
    expect(lock.packages['apps/vscode']!.version).toBe(manifest.version);
  });
});

describe('buildInfo', () => {
  it('is version, commit and a plain date', () => {
    expect(buildInfo('0.2.0-rc.3', 'a1b2c3d', new Date('2026-10-22T23:59:00Z'))).toEqual({ version: '0.2.0-rc.3', commit: 'a1b2c3d', date: '2026-10-22' });
  });
});
