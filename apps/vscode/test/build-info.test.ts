// R-234: the build text shown by "pagemd: About this build" and the status bar item.
import { describe, expect, it } from 'vitest';
import { aboutText, readBuildInfo, statusItemText } from '../host/build-info.ts';

const file = JSON.stringify({ version: '0.2.0-rc.3', commit: 'a1b2c3d', date: '2026-10-22' });

describe('build info', () => {
  it('reads dist/build-info.json from the extension folder', () => {
    let asked = '';
    const info = readBuildInfo('/ext', (f) => ((asked = f), file));
    expect(info).toEqual({ version: '0.2.0-rc.3', commit: 'a1b2c3d', date: '2026-10-22' });
    expect(asked.replaceAll('\\', '/')).toBe('/ext/dist/build-info.json');
  });
  it('is undefined (a dev build) when the file is missing or malformed', () => {
    expect(readBuildInfo('/ext', () => { throw new Error('ENOENT'); })).toBeUndefined();
    expect(readBuildInfo('/ext', () => '{"version":1}')).toBeUndefined();
    expect(readBuildInfo('/ext', () => 'not json')).toBeUndefined();
  });
  it('words the About text and the status item', () => {
    const info = readBuildInfo('/ext', () => file);
    expect(aboutText(info, '0.2.0-rc.0')).toBe('pagemd Editor 0.2.0-rc.3 (a1b2c3d, 2026-10-22)');
    expect(statusItemText(info)).toBe('pagemd 0.2.0-rc.3');
    expect(aboutText(undefined, '0.2.0-rc.0')).toBe('pagemd Editor 0.2.0-rc.0 (dev build)');
    expect(statusItemText(undefined)).toBe('pagemd dev build');
  });
});
