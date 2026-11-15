// The runtime file (P10, AD-P10-01): the only code in the editor that imports pagemd's renderer. esbuild bundles it, with
// pagemd's packages from the local pagemd checkout and their own installed libraries (the very ones `pagemd build` runs
// with), into `dist/host/pagemd/runtime.mjs`; the host loads it on the first Print Preview or Export.
import { detectChrome, setLogLevel } from '@pagemd/core';
import { exportText, renderForPreview } from '@pagemd/exporters';
import { initHighlighter, mermaidVersion } from '@pagemd/parser';
import type { PagemdRuntime } from './index.ts';

let ready: Promise<unknown> | undefined;

/** As the CLI starts: code coloring needs shiki initialised (else the output differs); pagemd's logs only on errors. */
function start(): Promise<unknown> {
  if (!ready) {
    setLogLevel('error');
    ready = initHighlighter();
  }
  return ready;
}

export const runtime: PagemdRuntime = {
  async renderForPreview(text, options) {
    await start();
    const result = await renderForPreview(text, { ...options, diagrams: 'placeholder' });
    return { html: result.html, colorScheme: result.colorScheme, profile: result.profile?.id ?? '' };
  },
  async exportText(text, options) {
    await start();
    const result = await exportText(text, options);
    return { path: result.path ?? options.target, ...(result.pages ? { pages: result.pages } : {}) };
  },
  detectBrowser: () => detectChrome(),
  mermaidVersion: () => mermaidVersion(),
};
