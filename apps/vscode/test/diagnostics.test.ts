// P14 (R-189): IDiagnostics on the host. The checks themselves are @pagemd/validate's (plugin-diagnostics/check, tested
// with the shared fixture there); here: when they run, what the Problems panel gets, what the webview gets, the setting
// that can only hide, one collection shared by two editors of a document, and "pagemd: Check Document".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import type * as vscode from 'vscode';
import type { PagemdDiagnostic, ValidationResult } from '@pagemd-editor/plugin-diagnostics/check';
import { EditorProvider } from '../host/EditorProvider.ts';
import { CHECK_DEBOUNCE_MS, PagemdHostDiagnostics, ProblemsCollection, summaryMessage, toVscodeDiagnostic } from '../host/services/diagnostics.ts';
import { PROTOCOL_VERSION, type DiagnosticsPayload } from '../shared/protocol.ts';

beforeEach(mock.resetMock);
afterEach(() => vi.useRealTimers());

const TEXT = '---\ntitle: ""\n---\n# H\n\n<!-- ::BREAK -->\n';
const BREAK: PagemdDiagnostic = { severity: 'warning', level: 'syntax', code: 'unknown-directive', message: 'Unknown directive ::BREAK', where: { line: 5 } };
const MISSING: PagemdDiagnostic = { severity: 'error', level: 'meta', code: 'missing-required-field', message: 'Missing required field: owner (required by profile p)', where: { line: 0 } };
const IN_PROFILE: PagemdDiagnostic = { severity: 'info', level: 'profile', code: 'deprecated-setting', message: 'Profile p: old', where: { file: '/work/profiles/p.json' } };

function setup(results: (ValidationResult | null)[] = [{ diagnostics: [BREAK, MISSING, IN_PROFILE], enabled: true, strict: false, profileId: 'p' }]) {
  const doc = new mock.MockTextDocument(mock.Uri.file('/work/docs/a.md'), TEXT);
  mock.openDocuments.push(doc);
  const problems = new ProblemsCollection();
  const calls: { path: string | null; text: string }[] = [];
  const check = vi.fn(async (input: { path: string | null; text: string }) => {
    calls.push(input);
    return results.length > 1 ? results.shift()! : results[0]!;
  });
  const diagnostics = new PagemdHostDiagnostics(doc as unknown as vscode.TextDocument, { problems, extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri, log: () => undefined, check });
  const payloads: DiagnosticsPayload[] = [];
  diagnostics.onResults((p) => payloads.push(p));
  const collection = mock.diagnosticCollections.at(-1)!;
  return { doc, problems, diagnostics, check, calls, payloads, collection };
}

describe('PagemdHostDiagnostics', () => {
  it('a run: the Problems panel gets each result on its line (else the first line, the file linked); the webview gets them as text ranges', async () => {
    const { doc, diagnostics, calls, payloads, collection } = setup();
    const summary = await diagnostics.run();
    expect(calls).toEqual([{ path: '/work/docs/a.md', text: TEXT }]);
    expect(summary).toEqual({ enabled: true, shown: true, errors: 1, warnings: 1, infos: 1 });
    const shown = collection.get(doc.uri)!;
    expect(shown.map((d) => [d.severity, d.range.start.line, d.range.end.character, d.code, d.source, d.message])).toEqual([
      [mock.DiagnosticSeverity.Warning, 5, 16, 'syntax/unknown-directive', 'pagemd', 'Unknown directive ::BREAK'],
      [mock.DiagnosticSeverity.Error, 0, 0, 'meta/missing-required-field', 'pagemd', 'Missing required field: owner (required by profile p)'],
      [mock.DiagnosticSeverity.Information, 0, 0, 'profile/deprecated-setting', 'pagemd', 'Profile p: old'],
    ]);
    expect(shown[2]!.relatedInformation!.map((r) => [r.location.uri.path, r.message])).toEqual([['/work/profiles/p.json', 'In p.json']]);
    expect(payloads).toEqual([
      {
        version: 1,
        text: TEXT,
        enabled: true,
        shown: true,
        items: [
          { from: 23, to: 39, severity: 'warning', message: 'Unknown directive ::BREAK', code: 'syntax/unknown-directive', source: 'pagemd' },
          { from: 0, to: 0, severity: 'error', message: 'Missing required field: owner (required by profile p)', code: 'meta/missing-required-field', source: 'pagemd' },
          { from: 0, to: 0, severity: 'info', message: 'Profile p: old', code: 'profile/deprecated-setting', source: 'pagemd' },
        ],
      },
    ]);
    expect(diagnostics.last).toBe(payloads[0]);
  });

  it('no validation setting (or nothing found): the Problems panel entry goes away', async () => {
    const { doc, diagnostics, payloads, collection } = setup([
      { diagnostics: [BREAK], enabled: true, strict: false, profileId: 'p' },
      { diagnostics: [], enabled: false, strict: false, profileId: 'quiet' },
    ]);
    await diagnostics.run();
    expect(collection.get(doc.uri)).toHaveLength(1);
    expect(await diagnostics.run()).toEqual({ enabled: false, shown: true, errors: 0, warnings: 0, infos: 0 });
    expect(collection.get(doc.uri)).toBeUndefined();
    expect(payloads.at(-1)).toMatchObject({ enabled: false, items: [] });
  });

  it('pagemdEditor.showProblems off: nothing runs and nothing shows (it can only hide)', async () => {
    const { doc, diagnostics, check, payloads, collection } = setup();
    await diagnostics.run();
    mock.configuration.set('pagemdEditor.showProblems', false);
    expect(await diagnostics.run()).toEqual({ enabled: false, shown: false, errors: 0, warnings: 0, infos: 0 });
    expect(check).toHaveBeenCalledTimes(1);
    expect(collection.get(doc.uri)).toBeUndefined();
    expect(payloads.at(-1)).toMatchObject({ shown: false, items: [] });
  });

  it('typing: one run once typing stops; saving: at once; a newer run wins over an older one still checking', async () => {
    vi.useFakeTimers();
    const { doc, diagnostics, check } = setup();
    doc.setText(`${TEXT}a`);
    doc.setText(`${TEXT}ab`);
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    mock.workspaceEvents.didSave.fire(doc as unknown as vscode.TextDocument);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    diagnostics.dispose();
  });

  it('a run that ends after a newer one started is dropped', async () => {
    const { diagnostics, check, payloads } = setup();
    let release!: () => void;
    check.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ diagnostics: [MISSING], enabled: true, strict: false, profileId: 'p' }))));
    const first = diagnostics.run();
    const second = diagnostics.run();
    await second;
    release();
    await first;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.items.map((d) => d.code)).toEqual(['syntax/unknown-directive', 'meta/missing-required-field', 'profile/deprecated-setting']);
  });
});

describe('ProblemsCollection', () => {
  it('one entry per document; it goes when the last editor of the document closes', () => {
    const problems = new ProblemsCollection();
    const uri = mock.Uri.file('/work/a.md') as unknown as vscode.Uri;
    problems.acquire(uri);
    problems.acquire(uri);
    problems.collection.set(uri, [new mock.Diagnostic(new mock.Range(0, 0, 0, 0), 'x') as unknown as vscode.Diagnostic]);
    problems.release(uri);
    expect(problems.collection.get(uri)).toHaveLength(1);
    problems.release(uri);
    expect(problems.collection.get(uri)).toBeUndefined();
  });
});

describe('summaryMessage and toVscodeDiagnostic', () => {
  it('says what a check found', () => {
    expect(summaryMessage({ enabled: true, shown: true, errors: 0, warnings: 0, infos: 0 })).toBe('pagemd Editor: no problems found.');
    expect(summaryMessage({ enabled: true, shown: true, errors: 1, warnings: 2, infos: 1 })).toBe('pagemd Editor: 1 error, 2 warnings, 1 note (see the Problems panel).');
    expect(summaryMessage({ enabled: false, shown: true, errors: 0, warnings: 0, infos: 0 })).toMatch(/asks for no checks/);
    expect(summaryMessage({ enabled: false, shown: false, errors: 0, warnings: 0, infos: 0 })).toMatch(/hidden \(setting pagemdEditor.showProblems\)/);
  });

  it('a line past the end of the document falls back to the first line', () => {
    const doc = new mock.MockTextDocument(mock.Uri.file('/a.md'), 'one line');
    const d = toVscodeDiagnostic(doc as unknown as vscode.TextDocument, { ...BREAK, where: { line: 40 } });
    expect([d.range.start.line, d.range.end.line]).toEqual([0, 0]);
  });
});

describe('the editor session', () => {
  it('sends each run to the webview once it is ready (protocol v9), and Check Document flushes the typing first', async () => {
    const doc = new mock.MockTextDocument(mock.Uri.file('/work/docs/guide.md'), TEXT);
    mock.openDocuments.push(doc);
    const problems = new ProblemsCollection();
    const check = vi.fn(async () => ({ diagnostics: [BREAK], enabled: true, strict: false, profileId: 'p' }) as ValidationResult);
    const provider = new EditorProvider(mock.Uri.file('/ext') as unknown as vscode.Uri, {
      log: () => undefined,
      testing: false,
      diagnostics: (document) => new PagemdHostDiagnostics(document, { problems, extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri, log: () => undefined, check }),
    });
    const view = mock.createWebviewPanel();
    provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, view.panel);
    const session = provider.sessions.get(doc.uri.toString())!;
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    await new Promise((r) => setTimeout(r, 10));
    const sent = view.posted.filter((m) => (m as { name?: string }).name === 'diagnostics') as { data: DiagnosticsPayload }[];
    expect(sent.map((m) => m.data.items.map((d) => d.code))).toEqual([['syntax/unknown-directive']]);

    // Check Document: the webview is asked for its pending typing (flush), then the checks run
    const done = session.checkNow();
    const flush = view.posted.find((m) => (m as { method?: string }).method === 'flush') as { id: number };
    view.receive({ kind: 'response', id: flush.id, ok: true, result: undefined });
    expect(await done).toEqual({ enabled: true, shown: true, errors: 0, warnings: 1, infos: 0 });
    expect(check).toHaveBeenCalledTimes(2);

    view.panel.dispose();
    expect(mock.diagnosticCollections.at(-1)!.get(doc.uri)).toBeUndefined();
  });
});
