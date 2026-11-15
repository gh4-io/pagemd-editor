import { describe, expect, it } from 'vitest';
import type { ISidecar } from '@pagemd-editor/core';
import { CommentsStore } from '../src/index.ts';

function fake(initial: unknown, options: { failWrite?: boolean; failRead?: boolean } = {}) {
  const writes: unknown[] = [];
  let stored = initial;
  const sidecar: ISidecar = {
    read: async () => {
      if (options.failRead) throw new Error('boom');
      return stored;
    },
    write: async (_kind, data) => {
      if (options.failWrite) throw new Error('disk full');
      writes.push(data);
      stored = data;
    },
  };
  return { sidecar, writes, set: (v: unknown) => (stored = v) };
}
const NOW = new Date('2026-10-05T12:00:00.000Z');
const make = (sidecar: ISidecar | undefined) => new CommentsStore({ sidecar, author: () => 'Ann', now: () => NOW });

describe('CommentsStore', () => {
  it('loads a missing file as an empty list and is ready', async () => {
    const store = make(fake(null).sidecar);
    expect(store.status).toBe('loading');
    await store.load();
    expect(store.status).toBe('ready');
    expect(store.file.threads).toEqual([]);
  });
  it('add, reply, resolve and remove are shown at once and written in order', async () => {
    const host = fake(null);
    const store = make(host.sidecar);
    await store.load();
    const seen: number[] = [];
    store.onChange(() => seen.push(store.file.threads.length));
    const add = store.add('c1', 'quoted', 'First');
    expect(store.file.threads).toHaveLength(1); // before the write finished
    await add;
    await store.reply('c1', 'Second');
    await store.resolve('c1', true);
    expect(host.writes).toHaveLength(3);
    expect((host.writes[2] as { threads: { resolved: boolean; comments: { text: string; author: string; created: string }[] }[] }).threads[0]).toMatchObject({
      resolved: true,
      comments: [{ text: 'First', author: 'Ann', created: NOW.toISOString() }, { text: 'Second', author: 'Ann' }],
    });
    await store.remove('c1');
    expect((host.writes[3] as { threads: unknown[] }).threads).toEqual([]);
    expect(seen.length).toBeGreaterThan(3);
  });
  it('a file that is not understood is never overwritten, and says why', async () => {
    const host = fake({ version: 9, threads: [] });
    const store = make(host.sidecar);
    await store.load();
    expect(store.status).toBe('unreadable');
    expect(store.message).toMatch(/version 9/);
    await expect(store.add('c1', 'q', 't')).rejects.toThrow(/not understood/);
    expect(host.writes).toEqual([]);
  });
  it('a file that cannot be read is left alone too', async () => {
    const host = fake(null, { failRead: true });
    const store = make(host.sidecar);
    await store.load();
    expect(store.status).toBe('unreadable');
    expect(store.message).toMatch(/boom/);
    await expect(store.reply('c1', 't')).rejects.toThrow();
    expect(host.writes).toEqual([]);
  });
  it('without a sidecar service nothing can be changed', async () => {
    const store = make(undefined);
    await store.load();
    expect(store.status).toBe('unavailable');
    expect(store.writable).toBe(false);
    await expect(store.add('c1', 'q', 't')).rejects.toThrow(/not available/);
  });
  it('a failed write keeps the change on screen and reports it', async () => {
    const host = fake(null, { failWrite: true });
    const store = make(host.sidecar);
    await store.load();
    await expect(store.add('c1', 'q', 't')).rejects.toThrow('disk full');
    expect(store.file.threads).toHaveLength(1);
    expect(store.message).toMatch(/not saved: disk full/);
  });
  it('a change on disk is picked up; a re-read of the same content changes nothing', async () => {
    const host = fake(null);
    const store = make(host.sidecar);
    await store.load();
    let notified = 0;
    store.onChange(() => notified++);
    await store.add('c1', 'q', 't');
    const afterAdd = notified;
    await store.load(); // our own write coming back
    expect(notified).toBe(afterAdd);
    host.set({ version: 1, threads: [] }); // git checkout of an older file
    await store.load();
    expect(store.file.threads).toEqual([]);
    expect(notified).toBeGreaterThan(afterAdd);
  });
  it('a read while a write is on its way does not undo the change', async () => {
    const host = fake(null);
    const store = make(host.sidecar);
    await store.load();
    const pending = store.add('c1', 'q', 't');
    await store.load(); // the file still has nothing
    await pending;
    expect(store.file.threads).toHaveLength(1);
  });
});
