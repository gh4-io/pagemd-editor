// The action runner (P7, R-156): the one place that runs an Action for the ribbon, slash menu, selection toolbar and
// keyboard, and the one place that applies the gated-insert policy (ADR-0016 M3). Components only hand it an Action.
import { Selection, type EditorState, type Transaction } from 'prosemirror-state';
import { gateSatisfied, type Action, type ActionContext, type GatedInsertMode } from './actions.ts';
import type { Registry } from './registry.ts';

/** The editor the runner acts on, read fresh at each run (the state changes between a click and an answer). */
export interface ActionTarget {
  state: EditorState;
  dispatch(tr: Transaction): void;
  focus(): void;
}

export type GateChoice = 'add' | 'insert' | 'cancel';

/** How a gated insert behaves; the app wires it to the host (settings, the prompt, the frontmatter edit). */
export interface GatePolicy {
  mode(): GatedInsertMode;
  /**
   * True (P8, R-161): "Add property" goes into the insert's own transaction through `registry.properties`, so the
   * property and the item are ONE edit and one undo step (ADR-0016 M3, ending R-155's two steps). False, or no
   * properties in the registry: the insert, then `addProperty` (two steps, the P7 behaviour).
   */
  sameStep?: boolean;
  /** `ask`: the prompt. 'add' = insert and add the property, 'insert' = insert anyway, 'cancel' = do nothing. */
  confirm(info: { label: string; field: string; value: unknown }): Promise<GateChoice>;
  /** Puts `field: value` in the document's frontmatter outside the editor (two steps); not needed with `sameStep`. */
  addProperty?(field: string, value: unknown): Promise<void>;
  /** Sends the document edits not yet sent to the host (so the property edit applies to the text the insert made). */
  flush?(): Promise<void>;
  /** `warn`: tells the author that the item won't print as intended. */
  notify(message: string): void;
}

export interface RunnerOptions {
  registry: Registry;
  target(): ActionTarget;
  context(): ActionContext;
  gate: GatePolicy;
}

export interface RunOptions {
  /**
   * Edits made in the SAME transaction as the command (the slash menu removes its "/query" here). Returns `false` when
   * the edit no longer applies (the text it meant to remove is gone): nothing is run, nothing is changed.
   */
  prepare?(tr: Transaction): void | boolean;
  args?: unknown;
}

export type ActionRunner = (action: Action, options?: RunOptions) => Promise<void>;

export function createActionRunner(options: RunnerOptions): ActionRunner {
  const { registry, gate } = options;

  /** Runs the command now; with `prepare`, its edit and the command are one transaction. Returns whether it ran. */
  const execute = (action: Action, run: RunOptions): boolean => {
    const command = registry.commands.get(action.id);
    if (!command) return false;
    const { state, dispatch } = options.target();
    if (command.kind !== 'view' && !options.context().editable) return false;
    if (!run.prepare) return registry.commands.run(action.id, state, dispatch, run.args);

    const first = state.tr;
    if (run.prepare(first) === false) return false;
    const middle = state.apply(first);
    if (!command.isEnabled(middle)) return false;
    let second: Transaction | undefined;
    if (!command.run(middle, (tr) => (second = tr), run.args) || !second) return false;
    const made = second as Transaction;
    const merged = state.tr;
    for (const step of first.steps) merged.step(step);
    for (const step of made.steps) merged.step(step);
    try {
      merged.setSelection(Selection.fromJSON(merged.doc, made.selection.toJSON()));
    } catch {
      /* the selection the command made can't be rebuilt: keep the mapped one */
    }
    if (made.storedMarksSet) merged.setStoredMarks(made.storedMarks);
    if (made.scrolledIntoView) merged.scrollIntoView();
    dispatch(merged);
    return true;
  };

  const addAfter = async (action: Action, run: RunOptions): Promise<void> => {
    const { field, value } = action.gate!;
    const properties = registry.properties;
    if (gate.sameStep && properties) {
      // One transaction: the slash menu's own edit, the property, then the insert (one undo step).
      let unreadable = false;
      const prepare = (tr: Transaction): boolean => {
        if (run.prepare?.(tr) === false) return false;
        if (properties.set(tr, field, value)) return true;
        unreadable = true;
        return false;
      };
      execute(action, { ...run, prepare });
      if (unreadable) gate.notify(`${action.label} was not inserted: "${field}" can't be added because the frontmatter can't be read.`);
      return;
    }
    if (!gate.addProperty) throw new Error('The gate policy can add the property neither in the same step nor afterwards.');
    if (!execute(action, run)) return;
    await gate.flush?.();
    await gate.addProperty(field, value);
  };

  /** Gated runs in progress, by property: a second click, key or menu pick for the same gate waits for the first to finish. */
  const inFlight = new Set<string>();

  return async (drawn, run = {}) => {
    const done = (): void => options.target().focus();
    // The action was drawn some time ago: the gate is decided from the document NOW, so an insert that already added
    // the property doesn't ask again, and a property removed since doesn't let an insert through unasked.
    const action = refreshed(drawn, options.context());
    if (action.kind === 'view' || !action.gate || action.gate.satisfied) {
      execute(action, run);
      done();
      return;
    }
    const key = action.gate.field;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await gated(action, run);
    } finally {
      inFlight.delete(key);
    }
    done();
  };

  async function gated(action: Action, run: RunOptions): Promise<void> {
    const mode = gate.mode();
    if (mode === 'warn') {
      if (execute(action, run)) gate.notify(`${action.label} needs "${action.gate!.field}" switched on in this document's frontmatter, or it may not print as intended. Nothing was added.`);
      return;
    }
    if (mode === 'auto') {
      // "Don't ask again" (R-154) means: add the property, without asking.
      await addAfter(action, run);
      return;
    }
    const choice = await gate.confirm({ label: action.label, field: action.gate!.field, value: action.gate!.value });
    if (choice === 'add') await addAfter(action, run);
    else if (choice === 'insert') execute(action, run);
  }
}

/** The action with its gate recomputed from the document's gate values (when the context has them). */
function refreshed(action: Action, context: ActionContext): Action {
  if (!action.gate || !context.gates) return action;
  return { ...action, gate: { ...action.gate, satisfied: gateSatisfied(context.gates[action.gate.field], action.gate.value) } };
}
