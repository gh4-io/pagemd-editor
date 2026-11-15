// End-to-end tests of the webview bundle in a real browser. Run: npm run test:e2e (everything but the benchmarks, builds first), npm run test:pr (smoke only),
// npm run test:perf (the benchmarks alone), npm run test:nightly (all of it, with retries and traces). T1 split the suite into tiers; see docs/phases/T1.md.
import { defineConfig, devices } from '@playwright/test';

const chrome = { ...devices['Desktop Chrome'] };
const nightly = !!process.env['NIGHTLY'];

/** Specs that compare against pagemd's own PDF output through a fingerprint of the sibling pagemd checkout (they need that checkout). */
const PARITY = /(pagination|page-types|print-fidelity|table-widths|style-parity)\.spec\.ts$/;
/** The 120- and 400-page benchmarks: their numbers are about speed. */
const PERF = /(large-document|large-image|pagination-benchmark)\.spec\.ts$/;
/** The pull-request set: the host protocol, one journey through every view, keys, undo and Print Layout, about ten seconds of wall time. */
const SMOKE = /(webview|journey|keyboard|undo-table-split|print-layout)\.spec\.ts$/;

export default defineConfig({
  testDir: 'test/e2e',
  forbidOnly: !!process.env['CI'],
  retries: nightly ? 2 : 0,
  // A retry that passes is reported as flaky, never hidden: the trace is what finds the cause.
  use: { trace: nightly ? 'on-first-retry' : 'off' },
  reporter: nightly ? [['list'], ['json', { outputFile: 'test-results/report.json' }]] : 'list',
  projects: [
    { name: 'smoke', testMatch: SMOKE, use: chrome },
    // Everything else. The smoke files are not run twice: they are their own project.
    { name: 'regression', testIgnore: [SMOKE, PARITY, PERF, /parity-preflight\.spec\.ts$/], use: chrome },
    { name: 'preflight', testMatch: /parity-preflight\.spec\.ts$/, use: chrome },
    // One red test when pagemd moved, instead of one per parity spec: the others are skipped until the references are regenerated.
    { name: 'parity', testMatch: PARITY, testIgnore: PERF, dependencies: ['preflight'], use: chrome },
    // P13b: the benchmarks run alone, after everything else, and no longer depend on the other projects: a failure elsewhere
    // used to skip them silently. Run on their own (npm run test:perf, one worker) for numbers that mean something.
    { name: 'perf', testMatch: PERF, use: chrome },
  ],
});
