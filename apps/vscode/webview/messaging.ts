// The only file in the webview that posts or receives messages (invariant I5). Everything else talks to the
// host through the channel this returns. The webview never touches the 'vscode' API; `acquireVsCodeApi` is
// the global VS Code gives every webview page.
import { Channel } from '../shared/channel.ts';
import type { HostEvents, HostRequests, WebviewEvents, WebviewRequests } from '../shared/protocol.ts';

export type WebviewChannel = Channel<HostRequests, WebviewRequests, HostEvents, WebviewEvents>;

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/** Connects to the host. Call once: VS Code allows `acquireVsCodeApi()` only once per page. */
export function connect(): WebviewChannel {
  api = acquireVsCodeApi();
  const vscodeApi = api;
  const channel: WebviewChannel = new Channel((message) => vscodeApi.postMessage(message));
  window.addEventListener('message', (event: MessageEvent) => channel.receive(event.data));
  return channel;
}

/** What this editor tab remembers while VS Code keeps it (P8: whether the Inspector is open; P9: the Outline); VS Code's own webview state. */
export interface PageState {
  inspector?: boolean;
  outline?: boolean;
  /** P12: whether the Comments panel is open. */
  comments?: boolean;
  /** P25: whether the Files in Use panel is open. */
  files?: boolean;
}

export function pageState(): PageState {
  const state = typeof api?.getState === 'function' ? api.getState() : undefined;
  return state && typeof state === 'object' ? (state as PageState) : {};
}

export function savePageState(change: PageState): void {
  if (typeof api?.setState === 'function') api.setState({ ...pageState(), ...change });
}
