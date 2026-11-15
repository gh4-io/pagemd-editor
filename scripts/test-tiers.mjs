// T1: the two ways to run the suite as a whole. Plain node so it works on Windows too (scripts/windows.mjs).
//   node scripts/test-tiers.mjs pr       check, unit tests, the e2e hygiene check, then the smoke e2e project (about a minute)
//   node scripts/test-tiers.mjs nightly  all of the above plus every e2e project, then the benchmarks alone, with retries and traces
// Every step runs even when an earlier one fails, so one night's run shows everything that is red; the exit code is non-zero if any was.
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (mode !== 'pr' && mode !== 'nightly') {
  console.error('usage: node scripts/test-tiers.mjs pr|nightly');
  process.exit(2);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = mode === 'nightly' ? { ...process.env, NIGHTLY: '1' } : process.env;
const steps =
  mode === 'pr'
    ? [['check'], ['lint:e2e'], ['test'], ['build'], ['exec', '--', 'playwright', 'test', '--project=smoke']]
    : [['check'], ['lint:e2e'], ['test'], ['test:e2e'], ['test:perf']];

const failed = [];
for (const step of steps) {
  const args = step[0] === 'exec' ? step : ['run', ...step];
  console.log(`\n=== npm ${args.join(' ')} ===`);
  const result = spawnSync(npm, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.status !== 0) failed.push(args.join(' '));
}
console.log(failed.length ? `\nFAILED: ${failed.join(' | ')}` : `\n${mode}: all passed`);
process.exit(failed.length ? 1 : 0);
