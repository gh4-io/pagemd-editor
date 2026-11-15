// T1: two cheap rules for test/e2e, so the flake count only goes down.
//  1. A sleep (`waitForTimeout`) is a guess about how long the editor takes. Specs use quiet() ("nothing else was sent") or frames()
//     from test/support/quiet.ts, or wait for a message or the text. The few sleeps left are in SLEEP_BASELINE; never more.
//  2. A spec never carries its own protocol number: import PROTOCOL from test/support/protocol.ts.
//  3. `sent`, `fromHost` and the pretend host live in test/support/host.ts. A spec does not define its own `sent` / `fromHost`, and the number of
//     specs with their own `open()` (OPEN_BASELINE) only goes down: use openEditor() from there.
// Lower a baseline number when you remove a sleep (the check tells you to). Run: npm run lint:e2e
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../test/e2e/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// T1 counted 54; T2 (2026-11-01) moved 51 to quiet() / frames() in test/support/quiet.ts and left these.
const SLEEP_BASELINE = {
  'large-image.spec.ts': 2, // the benchmark waits for the browser to let go of decoded pictures: nothing to observe
};

const OPEN_BASELINE = 26; // specs that still define their own `async function open(` (2026-11-01, T2)

/** Specs whose messages carry typed params, so they keep a narrower `Message` and their own `sent`. */
const OWN_SENT = new Set(['footnotes-tasks.spec.ts', 'keyboard.spec.ts', 'print-layout.spec.ts']);

const problems = [];
let opens = 0;
const notes = [];
let total = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
  const text = readFileSync(join(dir, file), 'utf8');
  const sleeps = (text.match(/waitForTimeout\(/g) ?? []).length;
  total += sleeps;
  const allowed = SLEEP_BASELINE[file] ?? 0;
  if (sleeps > allowed) problems.push(`${file}: ${sleeps} sleeps, ${allowed} allowed. Wait for a message or the text instead of a fixed time.`);
  if (sleeps < allowed) notes.push(`${file}: ${sleeps} sleeps now, ${allowed} in SLEEP_BASELINE: lower it.`);
  if (!OWN_SENT.has(file) && /^const (sent|fromHost) = /m.test(text)) problems.push(`${file}: its own sent/fromHost. Import them from ../support/host.ts.`);
  if (/async function open\(/.test(text)) opens++;
  if (/^const PROTOCOL = \d+;/m.test(text)) problems.push(`${file}: its own PROTOCOL number. Import it from ../support/protocol.ts.`);
}
if (opens > OPEN_BASELINE) problems.push(`${opens} specs define their own open(), ${OPEN_BASELINE} allowed. Use openEditor() from ../support/host.ts.`);
if (opens < OPEN_BASELINE) notes.push(`${opens} own open() now, ${OPEN_BASELINE} in OPEN_BASELINE: lower it.`);
for (const note of notes) console.log(`note: ${note}`);
if (problems.length) {
  for (const problem of problems) console.error(`e2e hygiene: ${problem}`);
  process.exit(1);
}
console.log(`e2e hygiene OK (${total} sleeps left, none new)`);
