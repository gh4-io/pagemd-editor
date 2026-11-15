// @pagemd-editor/plugin-input-rules: typing shortcuts (layered-architecture.md §3, P3, OQ-24).
// Collects every item's SyntaxItem.inputRules(schema) into one ProseMirror plugin, contributed to the canvas
// via the shared pmPlugins mechanism (ADR-0013 amendment) — no component needs to know input rules exist.
import { inputRules } from 'prosemirror-inputrules';
import type { EditorPlugin } from '@pagemd-editor/core';

/** Builds the plugin fresh from `app`'s current items and schema at start-up. */
export const inputRulesPlugin: EditorPlugin<void> = {
  id: '@pagemd-editor/plugin-input-rules:main',
  autoStart: true,
  activate: (app) => {
    const rules = app.registry.items().flatMap((item) => item.inputRules?.(app.schema) ?? []);
    app.pmPlugins.push(inputRules({ rules }));
  },
};
