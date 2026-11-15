// One end of the host ⇄ webview conversation: numbers requests, matches responses to them, and routes
// events. The host and the webview each wrap one Channel around their own `postMessage` (only
// webview/messaging.ts does so on the webview side).
import type { EventMap, RequestMap } from './protocol.ts';

type Handler<R extends RequestMap, M extends keyof R> = (params: R[M]['params']) => R[M]['result'] | Promise<R[M]['result']>;

export interface Subscription {
  dispose(): void;
}

/**
 * `Out*` are what this end sends (requests it makes, events it emits); `In*` are what it receives.
 */
export class Channel<OutReq extends RequestMap, InReq extends RequestMap, OutEv extends EventMap, InEv extends EventMap> {
  #nextId = 1;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #handlers = new Map<string, (params: unknown) => unknown>();
  readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
  readonly #post: (message: unknown) => void;
  #closed = false;

  constructor(post: (message: unknown) => void) {
    this.#post = post;
  }

  request<M extends keyof OutReq & string>(method: M, params: OutReq[M]['params']): Promise<OutReq[M]['result']> {
    if (this.#closed) return Promise.reject(new Error(`Channel closed; cannot send '${method}'.`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#post({ kind: 'request', id, method, params });
    });
  }

  emit<N extends keyof OutEv & string>(name: N, data: OutEv[N]): void {
    if (!this.#closed) this.#post({ kind: 'event', name, data });
  }

  /** Answers one kind of incoming request. A request nobody handles is answered with an error. */
  handle<M extends keyof InReq & string>(method: M, handler: Handler<InReq, M>): Subscription {
    this.#handlers.set(method, handler as (params: unknown) => unknown);
    return { dispose: () => this.#handlers.delete(method) };
  }

  on<N extends keyof InEv & string>(name: N, listener: (data: InEv[N]) => void): Subscription {
    let set = this.#listeners.get(name);
    if (!set) this.#listeners.set(name, (set = new Set()));
    set.add(listener as (data: unknown) => void);
    return { dispose: () => set.delete(listener as (data: unknown) => void) };
  }

  /** Feeds one incoming message in. Anything that isn't a well-formed message is ignored. */
  receive(message: unknown): void {
    if (this.#closed || typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    if (m['kind'] === 'response' && typeof m['id'] === 'number') {
      const pending = this.#pending.get(m['id']);
      if (!pending) return;
      this.#pending.delete(m['id']);
      if (m['ok'] === true) pending.resolve(m['result']);
      else pending.reject(new Error(typeof m['error'] === 'string' ? m['error'] : 'Request failed.'));
    } else if (m['kind'] === 'request' && typeof m['id'] === 'number' && typeof m['method'] === 'string') {
      void this.#answer(m['id'], m['method'], m['params']);
    } else if (m['kind'] === 'event' && typeof m['name'] === 'string') {
      for (const listener of this.#listeners.get(m['name']) ?? []) listener(m['data']);
    }
  }

  /** Rejects every unanswered request and stops sending. */
  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error('Channel closed.'));
    this.#pending.clear();
  }

  async #answer(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    try {
      if (!handler) throw new Error(`No handler for '${method}'.`);
      const result = await handler(params);
      if (!this.#closed) this.#post({ kind: 'response', id, ok: true, result });
    } catch (error) {
      if (!this.#closed) this.#post({ kind: 'response', id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
