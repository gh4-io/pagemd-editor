// The comment threads and their side file `.pagemd/comments/<doc>.json` (ADR-0015, R-180). Pure data and rules, no
// editor and no DOM: reading the file's JSON safely (a file that is not understood is never overwritten), the changes a
// user makes (new, reply, resolve, delete) as new values, and the match between threads and the anchors in the text.

export const COMMENTS_VERSION = 1;

/** One message in a thread. Unknown fields a newer version wrote are kept. */
export interface CommentMessage {
  author: string;
  /** ISO date and time. */
  created: string;
  text: string;
  [extra: string]: unknown;
}

export interface CommentThread {
  /** The id the anchor `<!-- ::COMMENT id="…" -->` names. */
  id: string;
  /** The text the comment was made on, for the panel (the anchor marks the block, the quote says what was meant). */
  quote: string;
  resolved: boolean;
  created: string;
  comments: CommentMessage[];
  [extra: string]: unknown;
}

export interface CommentsFile {
  version: typeof COMMENTS_VERSION;
  threads: CommentThread[];
  [extra: string]: unknown;
}

export const emptyFile = (): CommentsFile => ({ version: COMMENTS_VERSION, threads: [] });

export type ParseResult = { ok: true; file: CommentsFile } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads what `ISidecar.read('comments')` gave. null / undefined (no file) is an empty list. Anything else must have the
 * expected shape: a file that does not is reported, never repaired, so the next write cannot destroy what someone wrote.
 */
export function parseCommentsFile(raw: unknown): ParseResult {
  if (raw === null || raw === undefined) return { ok: true, file: emptyFile() };
  if (!isObject(raw)) return { ok: false, reason: 'the file is not a JSON object' };
  if (raw['version'] !== COMMENTS_VERSION) return { ok: false, reason: `the file has version ${JSON.stringify(raw['version'])}, this editor reads version ${COMMENTS_VERSION}` };
  const threads = raw['threads'];
  if (!Array.isArray(threads)) return { ok: false, reason: 'the file has no "threads" list' };
  const seen = new Set<string>();
  for (const [i, thread] of threads.entries()) {
    if (!isObject(thread)) return { ok: false, reason: `thread ${i + 1} is not an object` };
    const id = thread['id'];
    if (typeof id !== 'string' || id === '') return { ok: false, reason: `thread ${i + 1} has no id` };
    if (seen.has(id)) return { ok: false, reason: `the id "${id}" is used by two threads` };
    seen.add(id);
    if (typeof thread['quote'] !== 'string' || typeof thread['resolved'] !== 'boolean' || typeof thread['created'] !== 'string') {
      return { ok: false, reason: `thread "${id}" is missing its quote, resolved flag or date` };
    }
    const comments = thread['comments'];
    if (!Array.isArray(comments)) return { ok: false, reason: `thread "${id}" has no "comments" list` };
    for (const [j, message] of comments.entries()) {
      if (!isObject(message) || typeof message['author'] !== 'string' || typeof message['created'] !== 'string' || typeof message['text'] !== 'string') {
        return { ok: false, reason: `message ${j + 1} of thread "${id}" is missing its author, date or text` };
      }
    }
  }
  return { ok: true, file: raw as CommentsFile };
}

/** The file's text as written to disk: two-space JSON and a final newline, so git diffs it line by line. */
export const serializeCommentsFile = (file: CommentsFile): string => `${JSON.stringify(file, null, 2)}\n`;

/** `c<n>`, where n is one more than the highest number any thread or anchor already uses. */
export function nextThreadId(file: CommentsFile, anchorIds: Iterable<string>): string {
  let max = 0;
  for (const id of [...file.threads.map((t) => t.id), ...anchorIds]) {
    const match = /^c(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `c${max + 1}`;
}

export const addThread = (file: CommentsFile, thread: CommentThread): CommentsFile => ({ ...file, threads: [...file.threads, thread] });

const change = (file: CommentsFile, id: string, edit: (thread: CommentThread) => CommentThread): CommentsFile => {
  if (!file.threads.some((t) => t.id === id)) throw new Error(`There is no comment thread "${id}".`);
  return { ...file, threads: file.threads.map((t) => (t.id === id ? edit(t) : t)) };
};

export const addReply = (file: CommentsFile, id: string, message: CommentMessage): CommentsFile => change(file, id, (t) => ({ ...t, comments: [...t.comments, message] }));
export const setResolved = (file: CommentsFile, id: string, resolved: boolean): CommentsFile => change(file, id, (t) => ({ ...t, resolved }));
export function removeThread(file: CommentsFile, id: string): CommentsFile {
  if (!file.threads.some((t) => t.id === id)) throw new Error(`There is no comment thread "${id}".`);
  return { ...file, threads: file.threads.filter((t) => t.id !== id) };
}

/** What the threads and the anchors in the text say together. */
export interface Reconciled {
  /** Threads whose anchor is in the text, in the order of their anchors. */
  attached: CommentThread[];
  /** Threads whose anchor is gone (edited away by hand, undone, or never saved). */
  orphans: CommentThread[];
  /** Anchors in the text with no thread behind them, or a second anchor for a thread that already has one: indexes into `anchorIds`. */
  bare: number[];
}

/** `anchorIds`: the anchors' ids in document order. */
export function reconcile(file: CommentsFile, anchorIds: readonly string[]): Reconciled {
  const byId = new Map(file.threads.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const attached: CommentThread[] = [];
  const bare: number[] = [];
  anchorIds.forEach((id, index) => {
    const thread = byId.get(id);
    if (thread && !seen.has(id)) {
      seen.add(id);
      attached.push(thread);
    } else {
      bare.push(index);
    }
  });
  return { attached, orphans: file.threads.filter((t) => !seen.has(t.id)), bare };
}

/** A shortened quote for the panel and the file: whitespace folded, cut at `max` characters. */
export function shorten(text: string, max = 200): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length <= max ? folded : `${folded.slice(0, max - 1).trimEnd()}…`;
}
