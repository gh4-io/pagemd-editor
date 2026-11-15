// Sanitize plan SAN-0b: what a public copy of this repo will hold must not need, or name, anything private.
// - No tracked file outside the private trail (docs/, .agents/, the agent entry points) names a real user's home folder
//   (C:\Users\<name>, /mnt/c/Users/<name>, /home/<name>); placeholders such as <you>, user or Alice-style test names are fine.
// - No code or test reads the old .staging/ folder (real company documents, moved out of the repo) or a file in docs/
//   (the docs corpus in test/corpus/sources.ts is the one optional reader: it is skipped when docs/ is missing).
// The detector is checked against planted lines first, so a broken pattern cannot pass by finding nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const PRIVATE = [/^docs\//, /^\.agents\//, /^(CLAUDE|AGENTS)\.md$/];
const TEXT = /\.(m?[jt]s|cjs|json|css|html|md|txt|ya?ml)$/i;
// Names that stand for nobody: placeholders and the made-up users of the tests
const PLACEHOLDERS = new Set(['user', 'users', 'you', 'name', 'username', 'public', 'default', 'runner', 'someone', 'me', 'other', 'example', 'test', 'alice', 'bob']);
const HOME = [
  /[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([A-Za-z][\w.-]{2,})/g,
  /\/mnt\/[a-z]\/Users\/([A-Za-z][\w.-]{2,})/g,
  /\/home\/([a-z][\w.-]{2,})/g,
];

/** Real-looking home folders in a text, as "line N: match". */
function homeFolders(text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const re of HOME) for (const m of line.matchAll(re)) if (!PLACEHOLDERS.has(m[1]!.toLowerCase())) hits.push(`line ${i + 1}: ${m[0]}`);
  });
  return hits;
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const shippable = tracked.filter((f) => TEXT.test(f) && !PRIVATE.some((re) => re.test(f)));
const read = (f: string): string => readFileSync(join(root, f), 'utf8');

describe('source hygiene (SAN-0b)', () => {
  it('the detector finds real home folders in every spelling and ignores placeholders', () => {
    expect(homeFolders('cd "C:\\\\Users\\\\Carol\\\\x"  C:\\Users\\Carol\\x  C:/Users/Carol/x  /mnt/c/Users/Carol/x  /home/carol/x')).toHaveLength(5);
    expect(homeFolders('C:\\Users\\<you>\\x  /home/user/x  C:\\Users\\Alice\\x  /home/bob/x  /mnt/c/Users/Public/x  /Users/j')).toEqual([]);
  });

  it('no shippable tracked file names a real user\'s home folder', () => {
    expect(shippable.length).toBeGreaterThan(300);
    // This file plants made-up home folders for the detector check above, so it is the one file left out (SAN-0d)
    const found = shippable.filter((f) => f !== 'test/build/source-hygiene.test.ts').flatMap((f) => homeFolders(read(f)).map((hit) => `${f} ${hit}`));
    expect(found).toEqual([]);
  });

  it('nothing tracked lives in .staging/ and no code or test reads it, or a file in docs/', () => {
    expect(tracked.filter((f) => f.startsWith('.staging/'))).toEqual([]);
    const code = shippable.filter((f) => /\.(m?[jt]s|cjs)$/.test(f) && f !== 'test/build/source-hygiene.test.ts');
    const readers = code.filter((f) => /['"`/]\.staging[/'"`]|\.\.\/docs\/[\w./-]+\.md/.test(read(f)));
    expect(readers).toEqual([]);
  });
});
