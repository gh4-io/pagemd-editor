// The field editors (P8): one control per field type, shared by the Element tab, the Document tab and the properties
// card. A change is applied when the author leaves the box or presses Enter (one undo step per change, not one per
// key), never while typing. Editor UI: VS Code's theme variables, VS Code's own icons (codicons, R-162).
import type { ItemField } from '@pagemd-editor/core';
import { defaultPickerColor, getIn, helpOf, listEdit, parseInput, pickerColor, setIn, textOf, type ValuePath } from './model.ts';

export interface FormOptions {
  /** Shown, not editable (Read). */
  readOnly: boolean;
  /** The file picker for `path` fields ("Browse…"); absent: no button. */
  pickFile?(extensions?: readonly string[]): Promise<string | undefined>;
  /** Makes ids unique on the page. */
  idPrefix: string;
  /** P27: notes on list rows by path ("markers.2" → "Hidden by the crop"): the row is flagged and the note shown. */
  rowNotes?: Record<string, string>;
}

/** A codicon (VS Code's own icon font, R-162), hidden from screen readers: the button carries the words. */
export function icon(doc: Document, name: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = `codicon codicon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/**
 * A small icon button with an accessible name. `keyHint` (a "Remove" button's keyboard route, such as "Delete key") goes in its
 * tooltip and description, and makes it a mouse-only button: not a Tab stop, so Tab goes from box to box (the keyboard has the
 * hint's key instead).
 */
export function iconButton(doc: Document, name: string, label: string, onClick: () => void, disabled = false, keyHint?: string): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'pmd-insp-icon-button';
  button.title = keyHint ? `${label} (${keyHint})` : label;
  button.setAttribute('aria-label', label);
  if (keyHint) {
    button.tabIndex = -1;
    button.setAttribute('aria-description', keyHint);
  }
  button.append(icon(doc, name));
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

/** The key that removes an entry from the keyboard, said in the Remove buttons' tooltips. */
export const REMOVE_KEY_HINT = 'Delete key; in a box that has text, Alt+Delete';

/**
 * Delete (or Alt+Delete) while the focus is inside `row` removes its entry, since the Remove button is not a Tab stop. In a text
 * box that has text, plain Delete keeps its own job (deleting the next letter), so only Alt+Delete removes there.
 */
export function removeOnDelete(row: HTMLElement, remove: () => void): void {
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const typing = (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'color'].includes(target.type) && !target.readOnly) || target instanceof HTMLTextAreaElement;
    if (!event.altKey && typing && (target as HTMLInputElement).value !== '') return;
    event.preventDefault();
    event.stopPropagation();
    remove();
  });
}

let counter = 0;

/**
 * The fields of one section as a form. `values` is the section's current values; `change` gets the whole new values
 * object after one field changed.
 */
export function renderFields(doc: Document, fields: readonly ItemField[], values: Record<string, unknown>, change: (values: Record<string, unknown>) => void, options: FormOptions): HTMLElement {
  const form = doc.createElement('div');
  form.className = 'pmd-insp-fields';
  const set = (path: ValuePath, value: unknown): void => change(setIn(values, path, value) as Record<string, unknown>);
  for (const field of fields) form.append(fieldRow(doc, field, [field.key], values, set, options));
  return form;
}

function fieldRow(doc: Document, field: ItemField, path: ValuePath, values: unknown, set: (path: ValuePath, value: unknown) => void, options: FormOptions): HTMLElement {
  const row = doc.createElement('div');
  row.className = `pmd-insp-field pmd-insp-${field.type}`;
  row.dataset['field'] = path.join('.');
  const id = `${options.idPrefix}-${++counter}`;
  const value = getIn(values, path);
  const readOnly = options.readOnly || field.readOnly === true;
  const label = doc.createElement('label');
  label.className = 'pmd-insp-label';
  label.htmlFor = id;
  label.textContent = field.label + (field.required ? ' *' : '');
  const help = helpOf(field);
  if (help) label.title = help;

  if (field.type === 'object') {
    const group = doc.createElement('fieldset');
    group.className = 'pmd-insp-group';
    const legend = doc.createElement('legend');
    legend.textContent = field.label;
    group.append(legend);
    for (const sub of field.fields ?? []) group.append(fieldRow(doc, sub, [...path, sub.key], values, set, options));
    row.append(group);
    return row;
  }
  if (field.type === 'list') {
    row.append(label, listEditor(doc, field, path, values, set, { ...options, readOnly }, id));
    return row;
  }

  const problem = doc.createElement('div');
  problem.className = 'pmd-insp-problem';
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  const commit = (input: HTMLInputElement | HTMLSelectElement, text: string): void => {
    const parsed = parseInput(field.type === 'number' ? 'number' : 'string', text);
    if ('problem' in parsed) {
      input.setAttribute('aria-invalid', 'true');
      problem.textContent = parsed.problem;
      problem.hidden = false;
      return;
    }
    input.removeAttribute('aria-invalid');
    problem.hidden = true;
    if (JSON.stringify(parsed.value) === JSON.stringify(value)) return;
    set(path, parsed.value);
  };

  let control: HTMLElement;
  if (field.type === 'boolean') {
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.id = id;
    box.checked = value === true || value === 'true';
    box.disabled = readOnly;
    box.addEventListener('change', () => set(path, box.checked));
    control = box;
  } else if (field.type === 'enum' && !field.free) {
    const select = doc.createElement('select');
    select.id = id;
    select.disabled = readOnly;
    const current = textOf(value);
    const choices = [...(field.values ?? [])];
    if (current && !choices.includes(current)) choices.unshift(current); // as written, even when unknown
    if (!field.required || !current) select.append(new Option('—', ''));
    for (const choice of choices) select.append(new Option(choice, choice, false, choice === current));
    select.value = current;
    select.addEventListener('change', () => commit(select, select.value));
    control = select;
  } else {
    const input = doc.createElement('input');
    input.id = id;
    input.type = 'text'; // a number is checked by parseInput (a browser number box would hide bad input)
    input.inputMode = field.type === 'number' ? 'decimal' : 'text';
    input.value = textOf(value);
    input.readOnly = readOnly;
    if (field.default !== undefined) input.placeholder = textOf(field.default);
    if (field.type === 'enum' && field.free) {
      const list = doc.createElement('datalist');
      list.id = `${id}-choices`;
      for (const choice of field.values ?? []) list.append(new Option(choice, choice));
      input.setAttribute('list', list.id);
      row.append(list);
    }
    input.addEventListener('change', () => commit(input, input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') (event.preventDefault(), commit(input, input.value));
    });
    control = input;
    if (field.type === 'color') {
      const wrap = doc.createElement('div');
      wrap.className = 'pmd-insp-inline';
      const picker = doc.createElement('input');
      picker.type = 'color';
      picker.className = 'pmd-insp-color';
      picker.value = pickerColor(input.value) ?? defaultPickerColor(textOf(field.default)) ?? '#000000'; // the item's own default, not black (AD-FIX-S50-02)
      picker.disabled = readOnly;
      picker.setAttribute('aria-label', `${field.label}: pick a color`);
      picker.addEventListener('change', () => {
        input.value = picker.value;
        commit(input, picker.value);
      });
      input.addEventListener('input', () => {
        const hex = pickerColor(input.value);
        if (hex) picker.value = hex;
      });
      wrap.append(picker, input);
      control = wrap;
    } else if (field.type === 'path' && options.pickFile && !readOnly) {
      const wrap = doc.createElement('div');
      wrap.className = 'pmd-insp-inline';
      const browse = doc.createElement('button');
      browse.type = 'button';
      browse.className = 'pmd-insp-browse';
      browse.textContent = 'Browse…';
      browse.setAttribute('aria-label', `${field.label}: browse for a file`);
      browse.addEventListener('click', () => {
        void options.pickFile!(field.extensions).then((picked) => {
          if (picked === undefined) return;
          input.value = picked;
          commit(input, picked);
        });
      });
      wrap.append(input, browse);
      control = wrap;
    }
  }
  if (field.type === 'boolean') {
    const line = doc.createElement('div');
    line.className = 'pmd-insp-inline';
    line.append(control, label);
    row.append(line, problem);
  } else row.append(label, control, problem);
  if (help) {
    const note = doc.createElement('div');
    note.className = 'pmd-insp-help';
    note.textContent = help;
    row.append(note);
  }
  return row;
}

/** A list: one row per entry (a group of fields, or one text box), with move up, move down and remove; then "Add". */
function listEditor(doc: Document, field: ItemField, path: ValuePath, values: unknown, set: (path: ValuePath, value: unknown) => void, options: FormOptions, id: string): HTMLElement {
  const list = getIn(values, path);
  const rows = Array.isArray(list) ? list : [];
  const box = doc.createElement('div');
  box.className = 'pmd-insp-list';
  box.id = id;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', field.label);
  rows.forEach((entry, index) => {
    const row = doc.createElement('div');
    row.className = 'pmd-insp-list-row';
    row.dataset['row'] = [...path, index].join('.');
    const body = doc.createElement('div');
    body.className = 'pmd-insp-list-body';
    const note = options.rowNotes?.[row.dataset['row']];
    if (note) {
      row.classList.add('pmd-insp-row-flagged');
      const flag = doc.createElement('div');
      flag.className = 'pmd-insp-row-note';
      flag.textContent = note;
      body.append(flag);
    }
    if (field.fields?.length) {
      for (const sub of field.fields) body.append(fieldRow(doc, sub, [...path, index, sub.key], values, set, options));
    } else {
      body.append(fieldRow(doc, { key: String(index), type: 'string', label: `${field.label} ${index + 1}` }, [...path, index], values, set, options));
    }
    const tools = doc.createElement('div');
    tools.className = 'pmd-insp-list-tools';
    if (!options.readOnly) {
      tools.append(
        iconButton(doc, 'arrow-up', `Move ${field.label} ${index + 1} up`, () => set(path, listEdit(rows, { move: index, by: -1 })), index === 0),
        iconButton(doc, 'arrow-down', `Move ${field.label} ${index + 1} down`, () => set(path, listEdit(rows, { move: index, by: 1 })), index === rows.length - 1),
        iconButton(doc, 'close', `Remove ${field.label} ${index + 1}`, () => set(path, listEdit(rows, { remove: index })), false, REMOVE_KEY_HINT),
      );
      removeOnDelete(row, () => set(path, listEdit(rows, { remove: index })));
    }
    row.append(body, tools);
    box.append(row);
  });
  if (!options.readOnly) {
    const add = doc.createElement('button');
    add.type = 'button';
    add.className = 'pmd-insp-add';
    add.append(icon(doc, 'add'), doc.createTextNode(` Add ${field.label.toLowerCase().replace(/s$/, '')}`));
    add.addEventListener('click', () => set(path, listEdit(rows, { add: field.fields?.length ? newRow(field.fields, rows.length) : '' })));
    box.append(add);
  }
  return box;
}

/**
 * A new list row (row number `count + 1`): a number with limits starts in the middle (a marker at 50 % of the image), a
 * required `id` gets the row's number; defaults are left out (the renderer applies them; the form shows them).
 */
export function newRow(fields: readonly ItemField[], count = 0): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'number' && f.min !== undefined && f.max !== undefined) row[f.key] = Math.round((f.min + f.max) / 2);
    else if (f.key === 'id' && f.required) row[f.key] = String(count + 1);
  }
  return row;
}
