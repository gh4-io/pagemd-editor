// The document-properties form (P8, R-4: the same form in the Inspector's Document tab and on the canvas's card).
// Rows come from `documentModel` (@pagemd/meta's catalogue through the registry, plus the host's hints); every change
// goes through `registry.properties` in one transaction (comment-keeping, the author's own key, ADR-0016 M4).
import { keepFocus } from './focus.ts';
import type { ItemField, Registry } from '@pagemd-editor/core';
import type { Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { icon, iconButton, REMOVE_KEY_HINT, removeOnDelete, renderFields } from './form.ts';
import { documentModel, parseInput, textOf, type PropertyHints, type PropertyRow } from './model.ts';

export interface PropertiesFormOptions {
  registry: Registry;
  /** Runs `change` on a new transaction and dispatches it when it returns true. */
  edit(change: (tr: Transaction) => boolean): void;
  hints(): PropertyHints;
  readOnly(): boolean;
  /** Why nothing can be changed right now (Read, Print Preview), shown at the top of the form; undefined when there is nothing to say. */
  readOnlyNote?(): string | undefined;
  pickFile?(extensions?: readonly string[]): Promise<string | undefined>;
  idPrefix: string;
}

export class PropertiesForm {
  readonly element: HTMLElement;
  readonly #doc: Document;
  readonly #o: PropertiesFormOptions;
  #raw = false;
  #lastKey = '';

  constructor(doc: Document, options: PropertiesFormOptions) {
    this.#doc = doc;
    this.#o = options;
    this.element = doc.createElement('div');
    this.element.className = 'pmd-props';
  }

  /** Draws the form for `doc` (skipped when nothing it shows has changed, so a focused box isn't redrawn). */
  render(doc: Node, force = false): void {
    const properties = this.#o.registry.properties;
    const state = properties?.read(doc) ?? null;
    const hints = this.#o.hints();
    const key = JSON.stringify([state, hints, this.#raw, this.#o.readOnly(), this.#o.readOnlyNote?.()], (_k, v: unknown) => (v instanceof Date ? `D${v.toISOString()}` : v));
    if (!force && key === this.#lastKey) return;
    this.#lastKey = key;
    const d = this.#doc;
    const model = documentModel(state, this.#o.registry.meta, hints);
    const readOnly = this.#o.readOnly() || !properties;
    const parts: HTMLElement[] = [];

    const bar = d.createElement('div');
    bar.className = 'pmd-props-bar';
    const toggle = d.createElement('button');
    toggle.type = 'button';
    toggle.className = 'pmd-props-raw-toggle';
    toggle.setAttribute('aria-pressed', String(this.#raw || !!model.error));
    toggle.append(icon(d, 'code'), d.createTextNode(' Raw YAML'));
    toggle.disabled = !!model.error;
    toggle.addEventListener('click', () => {
      this.#raw = !this.#raw;
      this.render(doc, true);
    });
    bar.append(toggle);
    parts.push(bar);
    const why = this.#o.readOnlyNote?.();
    if (why && this.#o.readOnly()) parts.push(readOnlyNote(d, why));

    if (model.error) {
      const note = d.createElement('div');
      note.className = 'pmd-props-error';
      note.setAttribute('role', 'alert');
      note.textContent = `The properties can't be read: ${model.error}. Fix the YAML below (pagemd stops here too).`;
      parts.push(note);
    }

    if (this.#raw || model.error) {
      parts.push(this.#rawView(model.yaml, readOnly));
    } else {
      if (model.rows.length === 0) {
        const empty = d.createElement('div');
        empty.className = 'pmd-props-empty';
        empty.textContent = model.exists ? 'No properties yet.' : 'This document has no properties yet.';
        parts.push(empty);
      }
      for (const row of model.rows) parts.push(this.#row(row, readOnly));
      if (!readOnly && model.addable.length > 0) parts.push(this.#adder(model.addable));
    }
    keepFocus(this.element, () => this.element.replaceChildren(...parts));
  }

  #row(row: PropertyRow, readOnly: boolean): HTMLElement {
    const d = this.#doc;
    const set = (value: unknown): void => this.#o.edit((tr) => this.#o.registry.properties!.set(tr, row.key, value));
    const wrap = d.createElement('div');
    wrap.className = 'pmd-props-row';
    wrap.dataset['property'] = row.key;
    if (row.written === undefined) wrap.dataset['missing'] = 'true';
    const badges = d.createElement('span');
    badges.className = 'pmd-props-badges';
    if (row.required) badges.append(badge(d, 'Required', 'The profile requires this property'));
    if (row.shownOnPage) badges.append(badge(d, 'On page', "The template shows this property on the page"));
    if (row.written !== undefined && row.written !== row.key) badges.append(badge(d, row.written, `Written as "${row.written}" (kept when the value changes)`));

    let body: HTMLElement;
    if (row.type === 'raw') {
      body = d.createElement('div');
      body.className = 'pmd-props-complex';
      body.textContent = 'Edit this one in the raw YAML.';
      const label = d.createElement('div');
      label.className = 'pmd-insp-label';
      label.textContent = row.label;
      body.prepend(label);
    } else {
      const field: ItemField = {
        key: 'value',
        type: row.type === 'date' ? 'string' : row.type,
        label: row.label,
        ...(row.help ? { help: row.help } : {}),
        ...(row.values ? { values: row.values } : {}),
        ...(row.fallback !== undefined ? { default: row.fallback } : {}),
        ...(row.required ? { required: true } : {}),
      };
      body = renderFields(
        d,
        [field],
        { value: row.value },
        (values) => {
          const next = values['value'];
          if (row.type === 'date' || row.type === 'number') {
            const parsed = parseInput(row.type, textOf(next));
            if ('problem' in parsed || parsed.value === undefined) return; // a date or number box needs one (× removes it)
            set(parsed.value);
            return;
          }
          if (next === undefined && row.written === undefined) return; // nothing typed into a missing property
          set(next ?? '');
        },
        { readOnly, ...(this.#o.pickFile ? { pickFile: this.#o.pickFile } : {}), idPrefix: this.#o.idPrefix },
      );
    }
    wrap.append(body, badges);
    if (!readOnly && row.written !== undefined) {
      const remove = (): void => this.#o.edit((tr) => this.#o.registry.properties!.remove(tr, row.key));
      wrap.append(iconButton(d, 'close', `Remove ${row.label}`, remove, false, REMOVE_KEY_HINT));
      removeOnDelete(wrap, remove);
    }
    return wrap;
  }

  #adder(addable: { key: string; label: string }[]): HTMLElement {
    const d = this.#doc;
    const wrap = d.createElement('div');
    wrap.className = 'pmd-props-add';
    const select = d.createElement('select');
    select.setAttribute('aria-label', 'Add property');
    select.append(new Option('Add property…', ''));
    for (const { key, label } of addable) select.append(new Option(`${label} (${key})`, key));
    select.addEventListener('change', () => {
      const key = select.value;
      if (!key) return;
      const field = this.#o.registry.meta.fields.find((f) => f.key === key) ?? this.#o.hints().profileFields.find((f) => f.key === key);
      // A new property starts empty, or as on/off off; the author fills it in on its row.
      const value = field?.type === 'boolean' ? false : field?.type === 'list' ? [] : '';
      this.#o.edit((tr) => this.#o.registry.properties!.set(tr, key, value));
    });
    wrap.append(icon(d, 'add'), select);
    return wrap;
  }

  #rawView(yaml: string, readOnly: boolean): HTMLElement {
    const d = this.#doc;
    const area = d.createElement('textarea');
    area.className = 'pmd-props-raw';
    area.value = yaml;
    area.readOnly = readOnly;
    area.spellcheck = false;
    area.rows = Math.min(20, Math.max(4, yaml.split('\n').length + 1));
    area.setAttribute('aria-label', 'Properties as YAML');
    const apply = (): void => {
      if (area.value.replace(/\r\n?/g, '\n').replace(/\n+$/, '') === yaml) return;
      this.#o.edit((tr) => this.#o.registry.properties!.setText(tr, area.value));
    };
    area.addEventListener('change', apply);
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) (event.preventDefault(), apply());
    });
    return area;
  }
}

/** The sentence that says why the form can't be changed (not an alert: nothing went wrong). */
export function readOnlyNote(doc: Document, text: string): HTMLElement {
  const note = doc.createElement('div');
  note.className = 'pmd-insp-readonly-note';
  note.setAttribute('role', 'note');
  note.textContent = text;
  return note;
}

function badge(doc: Document, text: string, title: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = 'pmd-props-badge';
  span.textContent = text;
  span.title = title;
  return span;
}
