// style-pagemd runs on the host but is written browser-safe (P5, amendment 4): its source uses no Node API (the
// file system and path functions are injected), and it bundles for the browser with everything it imports.
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
// @ts-expect-error esbuild.mjs is plain JavaScript without type declarations
import { commonLinks } from '../../../esbuild.mjs'; // pagemd-common's links that Windows can follow (P13a, AD-P13-21)

const src = fileURLToPath(new URL('../src/', import.meta.url));
const NODE = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Why a source text isn't browser-safe: Node modules imported, Node globals used. */
function nodeUses(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]/g)) {
    const name = m[1] ?? m[2] ?? m[3] ?? '';
    if (NODE.has(name) || NODE.has(name.split('/')[0]!)) found.push(`imports ${name}`);
  }
  for (const global of ['process', 'Buffer', '__dirname', '__filename', 'require']) {
    if (new RegExp(`(^|[^.\\w'"])${global}\\s*[.([]`, 'm').test(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) found.push(`uses ${global}`);
  }
  return found;
}

describe('style-pagemd is browser-safe', () => {
  it('its source imports no Node module and uses no Node global', () => {
    const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(4);
    expect(files.flatMap((f) => nodeUses(readFileSync(`${src}${f}`, 'utf8')).map((u) => `${f}: ${u}`))).toEqual([]);
  });

  it('the check catches Node uses (control)', () => {
    expect(nodeUses("import fs from 'node:fs';\nimport { join } from 'path';\nconst x = process.env.X;\nrequire('os');")).toEqual([
      'imports node:fs',
      'imports path',
      'imports os',
      'uses process',
      'uses require',
    ]);
    expect(nodeUses("import postcss from 'postcss';\n// process.env in a comment\nconst processed = 1;")).toEqual([]);
  });

  it('bundles for the browser, with @pagemd/resolver, theme-kit, meta and postcss', async () => {
    const result = await esbuild.build({
      entryPoints: [`${src}index.ts`],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      plugins: [commonLinks()],
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    const code = result.outputFiles[0]!.text;
    expect(code).toContain('resolveDocument');
    expect(code).not.toMatch(/require\(["'](node:)?(fs|path|os|url)["']\)/);
  });
});
