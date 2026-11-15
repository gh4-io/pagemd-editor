// Invariant I5 / cohesion checkpoint 5: the webview talks to the host only through webview/messaging.ts.
// (The layer rules already keep 'vscode' out of the webview; this covers the message globals.)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webview = fileURLToPath(new URL('../../apps/vscode/webview', import.meta.url));
const MESSAGE_API = /\bacquireVsCodeApi\b|\.postMessage\(|addEventListener\(\s*['"]message['"]/;

/** Webview files, other than messaging.ts, that use the message API. */
export function offenders(dir = webview): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'messaging.ts')
    .filter((f) => MESSAGE_API.test(readFileSync(join(dir, f), 'utf8')));
}

describe('webview boundary (I5)', () => {
  it('only messaging.ts posts or receives messages', () => {
    expect(readFileSync(join(webview, 'messaging.ts'), 'utf8')).toMatch(MESSAGE_API);
    expect(offenders()).toEqual([]);
  });
});
