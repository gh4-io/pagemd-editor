// T2: the two ways a spec used to say "wait a bit", each with a name and a reason.
//  - quiet(): for "and nothing else was sent". Typing, drags and edits reach the host after the sync delay (webview/sync.ts), so
//    "nothing came" can only be judged once that delay has run twice over. This is the one place such a sleep lives.
//  - frames(): for "the browser has handled what I just did". Two animation frames; nothing to guess.
// Anything that can be observed (a message, a class, the text) is waited for with expect/expect.poll instead.
import type { Page } from '@playwright/test';

/** webview/sync.ts SYNC_DELAY_MS: kept in step by test/support/quiet.test.ts, which fails when they differ. */
export const SYNC_DELAY_MS = 300;

/** Long enough for any delayed send to have happened, so an absence afterwards is real. */
export async function quiet(page: Page): Promise<void> {
  await frames(page);
  await page.waitForTimeout(SYNC_DELAY_MS * 2);
}

/** The browser has run its pending events and painted: two animation frames. */
export function frames(page: Page): Promise<void> {
  return page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
