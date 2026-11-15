// Phase L2-8 (R-263): a real profile pack, installed by @pagemd/packs into a temporary shared profiles folder, named by the
// document by its name only (`profile: uofo-sop`). On the Print Layout canvas the pack's template is drawn around the text and its
// logo (a url() in the pack's theme.css, written from the theme's own folder, R-259) loads; Files in Use says the profile was found
// in the shared profiles folder, "search step 4 of 6". The pack is pagemd-common's fixture, made by pagemd-library.
// Control: without the shared folder in the environment the profile is not found (the canvas falls back to plain styles).
// Run: npm run test:e2e (builds first).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { filesReportFor, openInPrintLayout, stylesFor } from './pagination-harness.ts';
// @ts-expect-error plain JavaScript without type files (Node only: the pack installer)
import { installPack, sha256, verifyPack } from '../../../pagemd-common/packages/packs/src/index.js';

const ZIP = fileURLToPath(new URL('../../../pagemd-common/packages/packs/test/fixtures/library/uofo-sop-0.1.0.zip', import.meta.url));

function fixture(): { doc: string; text: string; shared: string } {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'pmd-l2-'));
  const shared = nodePath.join(root, 'config', 'profiles');
  const zip = readFileSync(ZIP);
  installPack(verifyPack(zip, sha256(zip)), shared);
  const doc = nodePath.join(root, 'docs', 'sop.md');
  const text = '---\nprofile: uofo-sop\ntitle: Pack by name\ndocument_id: SOP-1\n---\n# Pack by name\n\nText.\n';
  writeFileSync(nodePath.join(root, 'package.json'), '{}');
  mkdirSync(nodePath.dirname(doc), { recursive: true });
  writeFileSync(doc, text);
  return { doc, text, shared };
}

test('a profile pack named by name: its template and logo on Print Layout; Files in Use: search step 4 of 6', async ({ page }) => {
  const { doc, text, shared } = fixture();
  // control first: without the shared folder there is no such profile
  const plain = (await stylesFor(doc, text)) as { notes: { kind: string }[] };
  expect(plain.notes.map((n) => n.kind)).toContain('profile-not-found');

  await openInPrintLayout(page, doc, text, pathToFileURL(`${nodePath.dirname(doc)}/`).href, { sharedProfilesPath: shared });
  await expect(page.locator('.pmd-canvas .masthead-logo .brand-logo').first()).toBeAttached();
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.pmd-canvas .brand-logo')!).backgroundImage);
  expect(bg).toContain('uofo-sop/companies/uofo/assets/uofo-logo.png');
  const url = /url\("?([^")]+)"?\)/.exec(bg)![1]!;
  const width = await page.evaluate(
    (u) =>
      new Promise<number>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth);
        img.onerror = () => resolve(0);
        img.src = u;
      }),
    url,
  );
  expect(width).toBe(480);

  const report = await filesReportFor(doc, text, { sharedProfilesPath: shared });
  const profile = report.files.find((f) => f.role === 'profile' && f.path === nodePath.join(shared, 'uofo-sop.json'))!;
  expect(profile.why).toContain('Found by its name "uofo-sop" in the shared profiles folder (profile packs) (search step 4 of 6).');
});
