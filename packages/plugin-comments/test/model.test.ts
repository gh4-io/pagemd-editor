import { describe, expect, it } from 'vitest';
import { addReply, addThread, emptyFile, nextThreadId, parseCommentsFile, reconcile, removeThread, serializeCommentsFile, setResolved, shorten, type CommentThread } from '../src/index.ts';

const thread = (id: string, over: Partial<CommentThread> = {}): CommentThread => ({ id, quote: 'q', resolved: false, created: '2026-10-05T10:00:00.000Z', comments: [{ author: 'Ann', created: '2026-10-05T10:00:00.000Z', text: 'Hi' }], ...over });

describe('parseCommentsFile', () => {
  it('no file is an empty list', () => {
    expect(parseCommentsFile(null)).toEqual({ ok: true, file: emptyFile() });
    expect(parseCommentsFile(undefined)).toEqual({ ok: true, file: emptyFile() });
  });
  it('reads a good file and keeps fields it does not know', () => {
    const raw = { version: 1, extra: 1, threads: [{ ...thread('c1'), color: 'red' }] };
    const parsed = parseCommentsFile(raw);
    expect(parsed.ok && parsed.file).toEqual(raw);
  });
  it.each([
    ['not an object', 5],
    ['an array', []],
    ['another version', { version: 2, threads: [] }],
    ['no threads list', { version: 1 }],
    ['a thread that is not an object', { version: 1, threads: [3] }],
    ['a thread without an id', { version: 1, threads: [{ ...thread('x'), id: '' }] }],
    ['two threads with one id', { version: 1, threads: [thread('c1'), thread('c1')] }],
    ['a thread without a quote', { version: 1, threads: [{ ...thread('c1'), quote: undefined }] }],
    ['a thread without comments', { version: 1, threads: [{ ...thread('c1'), comments: 'x' }] }],
    ['a message without text', { version: 1, threads: [thread('c1', { comments: [{ author: 'a', created: 'b' } as never] })] }],
  ])('refuses %s, with a reason', (_what, raw) => {
    const parsed = parseCommentsFile(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason.length).toBeGreaterThan(5);
  });
});

describe('changes', () => {
  it('add, reply, resolve and remove give new values and leave the old one alone', () => {
    const a = addThread(emptyFile(), thread('c1'));
    const b = addReply(a, 'c1', { author: 'Bob', created: 'x', text: 'Reply' });
    const c = setResolved(b, 'c1', true);
    expect(a.threads[0]!.comments).toHaveLength(1);
    expect(b.threads[0]!.comments.map((m) => m.text)).toEqual(['Hi', 'Reply']);
    expect(c.threads[0]!.resolved).toBe(true);
    expect(b.threads[0]!.resolved).toBe(false);
    expect(removeThread(c, 'c1').threads).toEqual([]);
  });
  it('a change to a thread that is not there is an error, not silence', () => {
    const f = addThread(emptyFile(), thread('c1'));
    expect(() => setResolved(f, 'c9', true)).toThrow(/c9/);
    expect(() => addReply(f, 'c9', { author: 'a', created: 'b', text: 'c' })).toThrow(/c9/);
    expect(() => removeThread(f, 'c9')).toThrow(/c9/);
  });
  it('is written as two-space JSON with a final newline', () => {
    expect(serializeCommentsFile(emptyFile())).toBe('{\n  "version": 1,\n  "threads": []\n}\n');
  });
});

describe('nextThreadId', () => {
  it('is one more than the highest c<n> in the threads or the anchors', () => {
    const f = { ...emptyFile(), threads: [thread('c2'), thread('other')] };
    expect(nextThreadId(emptyFile(), [])).toBe('c1');
    expect(nextThreadId(f, [])).toBe('c3');
    expect(nextThreadId(f, ['c7', 'c1'])).toBe('c8');
  });
});

describe('reconcile', () => {
  const file = { ...emptyFile(), threads: [thread('c1'), thread('c2'), thread('c3')] };
  it('threads follow their anchors in document order; the rest are orphans', () => {
    const r = reconcile(file, ['c3', 'c1']);
    expect(r.attached.map((t) => t.id)).toEqual(['c3', 'c1']);
    expect(r.orphans.map((t) => t.id)).toEqual(['c2']);
    expect(r.bare).toEqual([]);
  });
  it('an anchor with no thread, or a second anchor for a thread, is bare (by its place in the list)', () => {
    const r = reconcile(file, ['c9', 'c1', 'c1']);
    expect(r.attached.map((t) => t.id)).toEqual(['c1']);
    expect(r.bare).toEqual([0, 2]);
  });
});

describe('shorten', () => {
  it('folds whitespace and cuts long text with an ellipsis', () => {
    expect(shorten('a \n  b')).toBe('a b');
    expect(shorten('x'.repeat(50), 10)).toBe('xxxxxxxxx…');
  });
});
