// T1: are the stored references for the parity specs still the ones pagemd would give today? The parity specs each compare a
// fingerprint of the sibling pagemd checkout with the one stored beside their reference; when that checkout moves, all of them
// used to fail at once (32 red tests, none a bug here). This one test says so once, with the commands that fix it; the parity
// project depends on it, so the rest are skipped instead of red. A real mismatch in a picture or a page count still fails its own test.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
// @ts-expect-error: plain .mjs scripts without types
import * as pagination from '../../scripts/pagination-reference.mjs';
// @ts-expect-error: plain .mjs script without types
import * as printFidelity from '../../scripts/print-fidelity-reference.mjs';
// @ts-expect-error: plain .mjs script without types
import * as tableWidths from '../../scripts/table-widths-reference.mjs';
// @ts-expect-error: plain .mjs script without types
import * as pageTypes from '../../scripts/page-types-reference.mjs';

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { fingerprint?: string; documents?: Record<string, { fingerprint?: string }> };

test('the stored pagemd references match the pagemd checkout', () => {
  const stale: string[] = [];
  const paginationRef = read(pagination.REFERENCE_FILE as string);
  for (const [name, entry] of Object.entries(paginationRef.documents ?? {})) {
    if (pagination.fingerprint(`${pagination.PAGEMD_ROOT as string}/${name}`) !== entry.fingerprint) stale.push('npm run pagination:reference');
  }
  const fidelityRef = read(printFidelity.REFERENCE_FILE as string);
  for (const [name, entry] of Object.entries(fidelityRef.documents ?? {})) {
    if (printFidelity.fingerprint(name) !== entry.fingerprint) stale.push('npm run print-fidelity:reference');
  }
  if (tableWidths.fingerprint() !== read(tableWidths.REFERENCE_FILE as string).fingerprint) stale.push('npm run table-widths:reference');
  if (pageTypes.fingerprint() !== read(pageTypes.REFERENCE_FILE as string).fingerprint) stale.push('npm run page-types:reference');
  expect([...new Set(stale)], 'the pagemd checkout changed since these references were made; regenerate them (each takes minutes) and look at what moved before committing').toEqual([]);
});
