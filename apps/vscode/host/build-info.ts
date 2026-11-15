// Which build is this? (R-234) `npm run package` writes dist/build-info.json (version, git short commit, date) into the
// package; a run from the source tree (F5, the test host) has no such file and says "dev build". Shown by the command
// "pagemd: About this build" and a small status bar item. No `vscode` import here: the text is built from plain values.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
  readonly date: string;
}

/** The generated file next to the host bundle's parent (`dist/build-info.json`), or undefined when this is not a packaged build. */
export function readBuildInfo(extensionPath: string, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): BuildInfo | undefined {
  try {
    const value = JSON.parse(read(join(extensionPath, 'dist', 'build-info.json'))) as Partial<BuildInfo>;
    return typeof value.version === 'string' && typeof value.commit === 'string' && typeof value.date === 'string' ? { version: value.version, commit: value.commit, date: value.date } : undefined;
  } catch {
    return undefined;
  }
}

/** "pagemd Editor 0.2.0-rc.3 (a1b2c3d, 2026-10-22)", or "pagemd Editor 0.2.0-rc.0 (dev build)" when run from source. */
export function aboutText(info: BuildInfo | undefined, manifestVersion: string): string {
  return info ? `pagemd Editor ${info.version} (${info.commit}, ${info.date})` : `pagemd Editor ${manifestVersion} (dev build)`;
}

/** The status bar item's short text: "pagemd 0.2.0-rc.3", or "pagemd dev build". */
export function statusItemText(info: BuildInfo | undefined): string {
  return info ? `pagemd ${info.version}` : 'pagemd dev build';
}
