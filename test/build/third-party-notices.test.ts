// P13 (amendment 4, acceptance 2): ThirdPartyNotices.txt names every package that is bundled into the extension, with its
// version and licence. The expected list is esbuild's own list of inputs for the three bundles (scripts/third-party-notices.mjs),
// so a new or upgraded library that is not in the file makes this test fail; run `node scripts/third-party-notices.mjs`.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript without type declarations
import { collect, noticesFile, render } from '../../scripts/third-party-notices.mjs';

type Entry = { key: string; licence: string; text: string };
let found: { packages: Map<string, Entry>; own: Set<string> };
let notices: string;

beforeAll(async () => {
  found = await collect();
  notices = readFileSync(noticesFile, 'utf8');
}, 180_000);

describe('ThirdPartyNotices.txt', () => {
  it('lists every bundled package with its version and licence', () => {
    expect(found.packages.size).toBeGreaterThan(100);
    const missing = [...found.packages.values()].filter((p) => !notices.includes(`\n${p.key}, `)).map((p) => p.key);
    expect(missing).toEqual([]);
  });

  it('gives each entry a licence (an id or the text) and carries the licence texts of pagemd and the vendored files', () => {
    const noLicence = [...found.packages.values()].filter((p) => p.licence === 'not stated' && !p.text).map((p) => p.key);
    expect(noLicence).toEqual([]);
    expect(notices).toContain('Apache License');
    for (const vendored of ['@vscode/codicons@', 'mermaid@', 'pagedjs@']) expect(notices).toContain(`\n${vendored}`);
    expect(found.own.has('pagemd')).toBe(true);
    expect(notices).toContain('\npagemd (the markdown to HTML/PDF engine');
    expect(notices).toContain('pagemd-common (@pagemd/syntax, @pagemd/resolver, @pagemd/theme-kit, @pagemd/meta, @pagemd/validate), Apache-2.0');
    expect(notices).not.toMatch(/UNLICENSED|licence not stated/); // SAN-0b: Apache-2.0 everywhere (R-267)
  });

  it('names the Inter font that book-fonts.css embeds, with the full SIL OFL 1.1 text (SAN-0b)', () => {
    expect(notices).toContain('\nInter typeface (embedded as base64 in dist/defaults/styles/book-fonts.css');
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(notices).toContain('Copyright 2020 The Inter Project Authors');
  });

  it('lists the whole dependency tree of the prebuilt browser files, not only their direct dependencies (R-209)', () => {
    // dependencies of mermaid's dependencies (d3 -> d3-array -> internmap; delaunator -> robust-predicates)
    for (const deep of ['internmap@', 'robust-predicates@', 'd3-array@']) expect(notices).toContain(`\n${deep}`);
    const viaMermaid = [...found.packages.values()].filter((p) => (p as Entry & { via?: string }).via === 'built into mermaid.min.js');
    expect(viaMermaid.length).toBeGreaterThan(60);
  });

  it('is exactly what the generator writes (nothing stale)', () => {
    expect(notices).toBe(render(found));
  });
});
