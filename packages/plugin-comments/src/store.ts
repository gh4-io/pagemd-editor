// The comments of one document: the threads, loaded from and saved to the side file through `ISidecar` (R-180). No editor
// and no DOM. Every change is a new value, shown at once and then written (one write at a time, in order). A file that
// cannot be read, or is not understood, switches changes off: it is never overwritten.
import type { Disposable, ISidecar } from '@pagemd-editor/core';
import { addReply, addThread, parseCommentsFile, removeThread, serializeCommentsFile, setResolved, emptyFile, type CommentMessage, type CommentsFile, type CommentThread } from './model.ts';

export type StoreStatus =
  /** Reading the file. */
  | 'loading'
  | 'ready'
  /** There is a file but it could not be read or is not understood; nothing is written. */
  | 'unreadable'
  /** The host has no side-file service (ISidecar absent). */
  | 'unavailable';

export interface StoreOptions {
  sidecar: ISidecar | undefined;
  /** The name new messages carry. */
  author(): string;
  now?(): Date;
}

export class CommentsStore {
  readonly #o: StoreOptions;
  readonly #listeners = new Set<() => void>();
  #file: CommentsFile = emptyFile();
  #status: StoreStatus;
  #message = '';
  #writes: Promise<void> = Promise.resolve();
  /** Writes started and not yet finished: a read now could still see the file before them. */
  #inFlight = 0;

  constructor(options: StoreOptions) {
    this.#o = options;
    this.#status = options.sidecar ? 'loading' : 'unavailable';
    if (!options.sidecar) this.#message = 'Comments are not available here.';
  }

  get file(): CommentsFile {
    return this.#file;
  }

  get status(): StoreStatus {
    return this.#status;
  }

  /** Why the status is not 'ready', or the last save problem; '' for none. */
  get message(): string {
    return this.#message;
  }

  /** Whether threads can be changed. */
  get writable(): boolean {
    return this.#status === 'ready';
  }

  onChange(cb: () => void): Disposable {
    this.#listeners.add(cb);
    return { dispose: () => this.#listeners.delete(cb) };
  }

  /** Reads the file now (at the start, and again when the host says it changed on disk). Never throws. */
  async load(): Promise<void> {
    const sidecar = this.#o.sidecar;
    if (!sidecar) return;
    if (this.#inFlight > 0) return; // our own write is on its way; the change it causes finds nothing new
    let raw: unknown;
    try {
      raw = await sidecar.read('comments');
    } catch (error) {
      this.#set('unreadable', `The comments file could not be read: ${error instanceof Error ? error.message : String(error)}. It is left as it is.`);
      return;
    }
    const parsed = parseCommentsFile(raw);
    if (!parsed.ok) {
      this.#set('unreadable', `The comments file is not understood (${parsed.reason}). It is left as it is.`);
      return;
    }
    // Our own write comes back as a change on disk: the same threads are no change.
    const same = this.#status === 'ready' && serializeCommentsFile(this.#file) === serializeCommentsFile(parsed.file);
    if (same) return;
    this.#file = parsed.file;
    this.#set('ready', '');
  }

  /** A new thread with its first message. `id` comes from `nextThreadId`. */
  async add(id: string, quote: string, text: string): Promise<void> {
    this.#mustBeWritable();
    const now = this.#stamp();
    const thread: CommentThread = { id, quote, resolved: false, created: now, comments: [this.#message_(text, now)] };
    await this.#commit(addThread(this.#file, thread));
  }

  async reply(id: string, text: string): Promise<void> {
    this.#mustBeWritable();
    await this.#commit(addReply(this.#file, id, this.#message_(text, this.#stamp())));
  }

  async resolve(id: string, resolved: boolean): Promise<void> {
    this.#mustBeWritable();
    await this.#commit(setResolved(this.#file, id, resolved));
  }

  async remove(id: string): Promise<void> {
    this.#mustBeWritable();
    await this.#commit(removeThread(this.#file, id));
  }

  #mustBeWritable(): void {
    if (!this.writable) throw new Error(this.#message || 'Comments cannot be changed now.');
  }

  #stamp(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }

  #message_(text: string, created: string): CommentMessage {
    return { author: this.#o.author(), created, text };
  }

  async #commit(next: CommentsFile): Promise<void> {
    const sidecar = this.#o.sidecar!;
    this.#file = next;
    this.#notify();
    this.#inFlight++;
    const job = this.#writes.then(() => sidecar.write('comments', next));
    this.#writes = job.catch(() => undefined);
    try {
      await job;
    } catch (error) {
      this.#message = `The comment was not saved: ${error instanceof Error ? error.message : String(error)}`;
      this.#notify();
      throw error;
    } finally {
      this.#inFlight--;
    }
  }

  #set(status: StoreStatus, message: string): void {
    this.#status = status;
    this.#message = message;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
