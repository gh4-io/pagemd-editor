// Task lists (P26): `- [ ] to do`, `- [x] done` in any list. Read and written by @pagemd/syntax's `task-lists` item (our own
// rule, markdown-it-task-lists' HTML); a task is still CommonMark's list item, so this item extends that node with the box
// (`pmdTask`: { checked, mark, gap } as written) and writes `[x] ` before the item's text. On the canvas the item gets
// pagemd's classes (`task-list-item`, the list `contains-task-list`) and a checkbox drawn in front of its text, as pagemd's
// HTML has it; a click on the box ticks or clears it, one change and one undo step. In Read (and anywhere the canvas can't be
// edited) the box can't be changed. The box's accessible name is the item's text.
import { InputRule } from 'prosemirror-inputrules';
import { Mark, type Node } from 'prosemirror-model';
import { wrapInList } from 'prosemirror-schema-list';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { CommandSpec, NodeWriter, SyntaxItem } from '@pagemd-editor/core';
import { writeItem } from '../shared/write.ts';

export const TASK = 'pmdTask';

export interface TaskData {
  checked: boolean;
  /** The character written between the brackets (' ', 'x' or 'X'). */
  mark: string;
  /** The spaces after the closing bracket, as written. */
  gap: string;
}

/** A new task's box: empty, written `[ ] `. */
export const NEW_TASK: TaskData = { checked: false, mark: ' ', gap: ' ' };

const taskOf = (node: Node): TaskData | null => (node.attrs[TASK] as TaskData | null | undefined) ?? null;

/** The box ticked or cleared (`X` kept when it is ticked again; the gap kept). */
export const toggled = (task: TaskData): TaskData => ({ ...task, checked: !task.checked, mark: task.checked ? ' ' : task.mark === 'X' ? 'X' : 'x' });

/** A task's box is written only before a paragraph (a heading or a list first would read differently). */
const writesBox = (node: Node): boolean => !!taskOf(node) && node.firstChild?.type.name === 'paragraph';

const writeTask = (original: NodeWriter): NodeWriter => (state, node, parent, index) => {
  const task = taskOf(node);
  if (task && writesBox(node)) state.write(writeItem('task-lists', { ...task }));
  original(state, node, parent, index);
};

/** The transaction that ticks or clears the task at `pos` (one change, one undo step), or null when it is not a task. */
export function toggleTaskTransaction(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  const task = node && taskOf(node);
  if (!node || !task) return null;
  return state.tr.setNodeMarkup(pos, null, { ...node.attrs, [TASK]: toggled(task) });
}

/**
 * Whether two blocks are the same but for the boxes of some tasks (ticked or cleared); `changed` gets those items' places among
 * the block's list items, in document order.
 */
function sameButBoxes(a: Node, b: Node, changed: number[], counter: { n: number }): boolean {
  if (a.type !== b.type || a.childCount !== b.childCount || a.text !== b.text || !Mark.sameSet(a.marks, b.marks)) return false;
  if (a.type.name === 'list_item') {
    const rest = (n: Node): string => JSON.stringify({ ...n.attrs, [TASK]: null });
    if (rest(a) !== rest(b)) return false;
    const ta = taskOf(a);
    const tb = taskOf(b);
    if (JSON.stringify(ta) !== JSON.stringify(tb)) {
      if (!ta || !tb || ta.checked === tb.checked) return false;
      changed.push(counter.n);
    }
    counter.n++;
  } else if (JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) return false;
  for (let i = 0; i < a.childCount; i++) if (!sameButBoxes(a.child(i), b.child(i), changed, counter)) return false;
  return true;
}

/** A list item's first line up to its box: indentation, `>` and list markers (bullets, numbers, letters, Roman numerals). */
const UP_TO_BOX = /^((?:[ \t>]*(?:[-+*]|\d{1,9}[.)]|[A-Za-z][.)]|[ivxlcdmIVXLCDM]{1,9}[.)])[ \t]+)+)\[([ xX])\]/;

/**
 * A ticked or cleared box changes one character of the file (P26; Word changes only the box too): the list's old text with
 * the box's mark replaced, found from the editor's own reading of that text. Null when anything else changed.
 */
export function patchTasks(before: Node, after: Node, text: string, tokens: (text: string) => { type: string; map: [number, number] | null; meta: unknown }[]): string | null {
  const changed: number[] = [];
  if (!sameButBoxes(before, after, changed, { n: 0 }) || changed.length === 0) return null;
  const items = tokens(text).filter((t) => t.type === 'list_item_open');
  const afterItems: Node[] = [];
  after.descendants((node) => {
    if (node.type.name === 'list_item') afterItems.push(node);
    return true;
  });
  if (items.length !== afterItems.length) return null;
  const starts = [0];
  for (const m of text.matchAll(/\r\n|\r|\n/g)) starts.push(m.index! + m[0].length);
  let out = text;
  for (const k of changed) {
    const line = items[k]!.map?.[0];
    const task = taskOf(afterItems[k]!);
    if (line === undefined || !task || !(items[k]!.meta as { task?: unknown } | null)?.task) return null;
    const from = starts[line]!;
    const m = UP_TO_BOX.exec(out.slice(from, starts[line + 1] ?? out.length));
    if (!m) return null;
    const at = from + m[1]!.length + 1;
    out = out.slice(0, at) + (task.checked ? task.mark : ' ') + out.slice(at + 1);
  }
  return out;
}

const taskListsKey = new PluginKey<DecorationSet>('pmd-task-lists');

/** The checkbox in front of a task's text (a widget: not part of the text, never written). */
function checkbox(task: TaskData, label: string): (view: EditorView, getPos: () => number | undefined) => HTMLElement {
  return (view, getPos) => {
    // The box and the space after it, as pagemd's HTML has (`<input …> text`): the space is the widget's, not the text's, so nothing is written
    const widget = document.createElement('span');
    widget.className = 'pmd-task-box';
    widget.contentEditable = 'false';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'task-list-item-checkbox';
    box.checked = task.checked;
    box.disabled = !view.editable;
    box.contentEditable = 'false';
    box.setAttribute('aria-label', label || 'Task');
    box.addEventListener('mousedown', (event) => event.preventDefault()); // the text cursor stays where it is
    box.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!view.editable) return;
      const at = getPos();
      if (at === undefined) return;
      // The widget sits at the start of the item's first paragraph: the item is two levels up
      const $at = view.state.doc.resolve(at);
      for (let d = $at.depth; d > 0; d--) {
        if ($at.node(d).type.name !== 'list_item') continue;
        const tr = toggleTaskTransaction(view.state, $at.before(d));
        if (tr) view.dispatch(tr);
        return;
      }
    });
    widget.append(box, ' ');
    return widget;
  };
}

/** The decorations of one stretch of the document: classes on tasks and their lists, a box in front of each task's text. */
function taskDecorations(doc: Node, from: number, to: number): Decoration[] {
  const out: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) return false;
    if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
      let any = false;
      node.forEach((child) => {
        if (taskOf(child)) any = true;
      });
      if (any) out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'contains-task-list' }));
    }
    const task = node.type.name === 'list_item' ? taskOf(node) : null;
    if (task) {
      out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'task-list-item' }));
      const first = node.firstChild;
      if (first?.type.name === 'paragraph') {
        const label = first.textContent;
        // stopEvent: ProseMirror leaves the box's own clicks alone (no text selection starts there)
        out.push(Decoration.widget(pos + 2, checkbox(task, label), { side: -1, ignoreSelection: true, stopEvent: () => true, key: `task:${task.checked ? 1 : 0}:${label}` }));
      }
    }
    return true;
  });
  return out;
}

/**
 * The tasks' look on the canvas, kept up to date per change (only the top-level blocks a change touched are read again, as
 * the canvas's soft line breaks: the 400-page keystroke budget). The boxes are switched off whenever the canvas can't be edited.
 */
export function taskListsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: taskListsKey,
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, taskDecorations(state.doc, 0, state.doc.content.size)),
      apply: (tr, set) => {
        if (!tr.docChanged) return set;
        let next = set.map(tr.mapping, tr.doc);
        tr.mapping.maps.forEach((map, i) => {
          map.forEach((_a, _b, newStart, newEnd) => {
            const rest = tr.mapping.slice(i + 1);
            const from = Math.max(0, Math.min(rest.map(newStart, -1), tr.doc.content.size));
            const to = Math.max(from, Math.min(rest.map(newEnd, 1), tr.doc.content.size));
            const $from = tr.doc.resolve(from);
            const $to = tr.doc.resolve(to);
            const start = $from.depth > 0 ? $from.before(1) : from;
            const end = $to.depth > 0 ? $to.after(1) : to;
            next = next.remove(next.find(start, end)).add(tr.doc, taskDecorations(tr.doc, start, end));
          });
        });
        return next;
      },
    },
    props: { decorations: (state) => taskListsKey.getState(state) ?? DecorationSet.empty },
    view: (view) => {
      const sync = (): void => {
        for (const box of view.dom.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) box.disabled = !view.editable;
      };
      sync();
      return { update: sync };
    },
  });
}

/** The list items the selection touches (by their first block). */
function selectedItems(state: EditorState): { node: Node; pos: number }[] {
  const { from, to } = state.selection;
  const found: { node: Node; pos: number }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'list_item') return true;
    const first = node.firstChild;
    const firstEnd = pos + 1 + (first?.nodeSize ?? 0);
    if (from <= firstEnd && to >= pos + 1) found.push({ node, pos });
    return true;
  });
  return found;
}

/**
 * Home ▸ Lists ▸ Checklist: the selected list items become tasks (an empty box each); when they all are tasks already, they go
 * back to plain items. Outside a list the selected paragraphs become a bulleted checklist. One change, one undo step.
 */
export const toggleChecklist: CommandSpec = {
  id: 'task-lists.toggle',
  label: 'Checklist',
  icon: 'checklist',
  keywords: ['checklist', 'task', 'todo', 'to do', 'checkbox'],
  isEnabled: (state) => !!state.schema.nodes['list_item'] && (selectedItems(state).length > 0 || wrapInList(state.schema.nodes['bullet_list']!)(state)),
  isActive: (state) => {
    const items = selectedItems(state);
    return items.length > 0 && items.every((i) => taskOf(i.node));
  },
  run: (state, dispatch) => {
    const items = selectedItems(state);
    if (items.length > 0) {
      const all = items.every((i) => taskOf(i.node));
      const tr = state.tr;
      for (const { node, pos } of items) {
        if (all) tr.setNodeMarkup(pos, null, { ...node.attrs, [TASK]: null });
        else if (!taskOf(node)) tr.setNodeMarkup(pos, null, { ...node.attrs, [TASK]: { ...NEW_TASK } });
      }
      dispatch(tr.scrollIntoView());
      return true;
    }
    const bullet = state.schema.nodes['bullet_list'];
    if (!bullet) return false;
    let wrapped: Transaction | null = null;
    if (!wrapInList(bullet, { bullet: '-' })(state, (tr) => (wrapped = tr)) || !wrapped) return false;
    const tr = wrapped as Transaction;
    const { from, to } = state.selection;
    const a = tr.mapping.map(from, -1);
    const b = tr.mapping.map(to, 1);
    tr.doc.nodesBetween(a, b, (node, pos) => {
      if (node.type.name === 'list_item' && !taskOf(node)) tr.setNodeMarkup(pos, null, { ...node.attrs, [TASK]: { ...NEW_TASK } });
      return true;
    });
    dispatch(tr.scrollIntoView());
    return true;
  },
};

export const taskLists: SyntaxItem = {
  id: 'task-lists',
  group: 'lists',
  schema: {},
  fromTokens: {},
  toMarkdown: {},
  extend: {
    nodes: {
      list_item: {
        attrs: { [TASK]: { default: null } },
        fromToken: (tok) => {
          const pmd = (tok.meta as { pmd?: { item: string; data: TaskData } } | null)?.pmd;
          return { [TASK]: pmd?.item === 'task-lists' ? { ...pmd.data } : null };
        },
        write: writeTask,
      },
    },
  },
  patch: patchTasks,
  label: 'Checklist',
  icon: 'checklist',
  slash: { keywords: ['checklist', 'task', 'todo', 'checkbox'] },
  commands: [toggleChecklist],
  // `[ ] ` or `[x] ` typed at the start of a list item's first paragraph makes the item a task (GitHub's way of writing one).
  inputRules: (schema) =>
    schema.nodes['list_item']
      ? [
          new InputRule(/^\[([ xX])\] $/, (state, match, start, end) => {
            const $start = state.doc.resolve(start);
            const depth = $start.depth - 1;
            if (depth < 1 || $start.parent.type.name !== 'paragraph' || $start.parentOffset !== 0) return null;
            const item = $start.node(depth);
            if (item.type.name !== 'list_item' || $start.index(depth) !== 0 || taskOf(item)) return null;
            const mark = match[1]!;
            return state.tr.delete(start, end).setNodeMarkup($start.before(depth), null, { ...item.attrs, [TASK]: { checked: mark !== ' ', mark, gap: ' ' } });
          }),
        ]
      : [],
};
