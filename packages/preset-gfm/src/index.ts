// @pagemd-editor/preset-gfm: GFM extras on top of preset-commonmark (layered-architecture.md §3).
import type { Preset, SyntaxItem } from '@pagemd-editor/core';
import { alert, ALERT_KINDS, type AlertKind } from './items/alert.ts';
import { autolink } from './items/autolink.ts';
import { strikethrough } from './items/strikethrough.ts';
import { table, type Align } from './items/table.ts';

export { alert, ALERT_KINDS, type AlertKind, autolink, strikethrough, table, type Align };

/** GFM's alert kind as an Inspector field (P8). Table alignment is table editing (P16, R-151). */
const alertWithFields: SyntaxItem = {
  ...alert,
  fields: {
    alert: {
      fields: [{ key: 'kind', type: 'enum', label: 'Kind', values: ALERT_KINDS.map((k) => k.toUpperCase()), required: true }],
      values: (owner) => ({ kind: String(owner.attrs['kind']).toUpperCase() }),
      apply: (owner, values) => ({ kind: (ALERT_KINDS as readonly string[]).includes(String(values['kind']).toLowerCase()) ? String(values['kind']).toLowerCase() : owner.attrs['kind'] }),
    },
  },
};

export const gfmItems: readonly SyntaxItem[] = [table, strikethrough, autolink, alertWithFields];

export const gfmPreset: Preset = { id: 'gfm', items: [...gfmItems] };
