import { describe, expect, it } from 'vitest';
import { SYNC_DELAY_MS as real } from '../../apps/vscode/webview/sync.ts';
import { SYNC_DELAY_MS } from './quiet.ts';

describe('the e2e quiet period', () => {
  it('follows the webview\'s sync delay, so "nothing was sent" waits long enough', () => {
    expect(SYNC_DELAY_MS).toBe(real);
  });
});
