// Types for the parts of pagemd the runtime file uses (plain JavaScript, no type files of their own). Source: pagemd
// packages/exporters/src/in-process.js, packages/core/src/{chrome,logger}.js, packages/parser/src/{index,mermaid}.js
// (phase C6). Resolved at build time from the local pagemd checkout (AD-P10-01), not through node_modules.

declare module '@pagemd/exporters' {
  export function renderForPreview(
    text: string | null,
    options: { markdownPath: string; profile?: string; projectRoot?: string; cliPath?: string; diagrams?: 'placeholder' | 'svg'; nonce?: string; beforePolyfill?: string },
  ): Promise<{ html: string; profile: { id?: string } | null; metadata: Record<string, unknown>; colorScheme: string }>;
  export function exportText(
    text: string | null,
    options: { markdownPath: string; format: 'html' | 'pdf' | 'png' | 'jpeg'; target: string | null; profile?: string; cliPath?: string; browserPath?: string; timeout?: number },
  ): Promise<{ format: string; path: string | null; size?: number; pages?: number; html?: string }>;
}

declare module '@pagemd/core' {
  export function detectChrome(): string | null;
  export function setLogLevel(level: string): void;
}

declare module '@pagemd/parser' {
  export function initHighlighter(options?: Record<string, unknown>): Promise<unknown>;
  export function mermaidVersion(): string;
}
