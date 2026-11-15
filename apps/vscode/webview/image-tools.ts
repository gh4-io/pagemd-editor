// The Image tab's Edit picture group (P27, R-249, R-251, R-252; ADR-0019): Crop, Rotate left/right, Flip horizontally/vertically,
// Redact and Reset picture. Every one of them is a change of the markdown only, in ONE transaction (one undo step, R-94): the crop,
// the turn and the flip are keys (`crop-x`/`crop-y`/`pos-x`/`pos-y` in %, `rotate`, `flip`), a redaction is a rectangle in the
// annotated image's `redact:` list, and NO file is written (R-195 retired; the image tools have no `writeAsset`). A plain picture
// becomes a FIGURE (an annotated image for Redact) inside the same step (R-248: no Convert buttons); one in the middle of a
// sentence is put on its own line first. The document side is preset-pagemd's (target.ts, crop-mode.ts); this file adds what
// needs the app: the status bar notes and the first redaction's note (a dialog).
import { NodeSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { CommandSpec } from '@pagemd-editor/core';
import { askChoice } from '@pagemd-editor/image-editor';
import {
  blockReason,
  canRedact,
  captionFigure,
  editableTarget,
  hasPictureEdits,
  pictureField,
  pictureSelected,
  pictureTarget,
  redactedPictures,
  redactReason,
  requestCrop,
  requestDraw,
  resetTransaction,
  stopShapeEditing,
  turnTransaction,
  type Geometry,
} from '@pagemd-editor/preset-pagemd';

export interface ImageToolsHost {
  state(): EditorState | undefined;
  /** True while the canvas can be changed (not Read). */
  editable(): boolean;
  dispatch(tr: Transaction): void;
  /** A message in the status bar. */
  flash(message: string): void;
  /** Where the dialogs open. */
  document: Document;
}

/**
 * What the author is told on the first redaction in a document and in the Redact tooltip (R-251, PROVISIONAL, OQ-61; P27
 * amendment 5, word for word).
 */
export const REDACT_NOTE =
  'Covered on the page and in Print Preview, and blacked out in exported HTML, PDF and pictures: pagemd bakes a covered copy when it builds. It is not removed from your picture file, git history, pagemd archive, or markdown viewers such as GitHub. To remove it for good, edit or replace the original file.';

const TURNS: readonly { id: string; label: string; icon: string; g: Geometry }[] = [
  { id: 'image.rotate-left', label: 'Rotate left', icon: 'discard', g: { kind: 'rotate', turn: 'left' } },
  { id: 'image.rotate-right', label: 'Rotate right', icon: 'redo', g: { kind: 'rotate', turn: 'right' } },
  { id: 'image.flip-horizontal', label: 'Flip horizontally', icon: 'arrow-both', g: { kind: 'flip', axis: 'horizontal' } },
  { id: 'image.flip-vertical', label: 'Flip vertically', icon: 'fold', g: { kind: 'flip', axis: 'vertical' } },
];

export function imageToolCommands(host: ImageToolsHost): CommandSpec[] {
  let busy = false;
  const can = (state: EditorState): boolean => !busy && host.editable() && editableTarget(state) !== null;

  /** Redact: the note first when the document has no redaction yet (R-251), then a rectangle to drag, as a shape (one undo step). */
  const redact = async (): Promise<void> => {
    const before = host.state();
    if (!before) return;
    if (redactedPictures(before.doc).length === 0) {
      const answer = await askChoice(host.document, 'Redact', REDACT_NOTE, [{ id: 'redact', label: 'Redact' }]);
      if (answer !== 'redact') return;
    }
    const state = host.state();
    const target = state && canRedact(state) ? pictureTarget(state) : null;
    // FIX-S50 (OQ-63): the redaction box is drawn by dragging, like the other shapes (draw mode).
    if (state && target) host.dispatch(requestDraw(state.tr.setSelection(NodeSelection.create(state.doc, target.pos)), target.pos, 'redact'));
    else host.flash('The picture changed meanwhile, so nothing was redacted.');
  };

  return [
    {
      id: 'image.crop',
      label: 'Crop',
      icon: 'screen-normal',
      slash: false,
      isEnabled: (state) => can(state),
      reason: blockReason,
      // Word's crop mode on the canvas (crop-mode.ts): the picture is selected as an object, shape editing ends (one mode at a time).
      run: (state, dispatch) => {
        const target = editableTarget(state);
        if (!target) return false;
        let tr = state.tr.setSelection(NodeSelection.create(state.doc, target.pos));
        if (target.kind === 'annotated') tr = stopShapeEditing(tr, target.pos);
        dispatch(requestCrop(tr, target.pos));
        return true;
      },
    },
    ...TURNS.map(
      ({ id, label, icon, g }): CommandSpec => ({
        id,
        label,
        icon,
        slash: false,
        isEnabled: (state) => can(state),
        reason: blockReason,
        run: (state, dispatch) => {
          const change = turnTransaction(state, g);
          if (!change) return false;
          dispatch(change.tr);
          if (change.notes.length) host.flash(change.notes.join(' '));
          return true;
        },
      }),
    ),
    {
      id: 'image.redact',
      label: 'Redact',
      icon: 'eye-closed',
      description: REDACT_NOTE,
      slash: false,
      isEnabled: (state) => !busy && host.editable() && canRedact(state),
      reason: redactReason,
      run: () => {
        busy = true;
        void redact()
          .catch((error: unknown) => host.flash(`Redact: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => (busy = false));
        return true;
      },
    },
    {
      id: 'image.reset',
      label: 'Reset picture',
      icon: 'history',
      slash: false,
      isEnabled: (state) => !busy && host.editable() && hasPictureEdits(state),
      run: (state, dispatch) => {
        const change = resetTransaction(state);
        if (!change) return false;
        dispatch(change.tr);
        return true;
      },
    },
  ];
}

/**
 * Image tab > Caption and Details (P20, AD-P20-05): buttons that take the author to the selected picture's Inspector box
 * (the caption, the alt text, the picture's path with its Browse button), or to its Inspector section. They write nothing
 * themselves; the Inspector writes what is typed there, as before. `open` opens the Inspector's Element tab on `field`
 * (undefined: no box focused).
 */
export function pictureFieldCommands(open: (field: string | undefined) => void, flash: (message: string) => void = () => undefined): CommandSpec[] {
  const jump = (id: string, label: string, icon: string, what: 'caption' | 'alt' | 'path'): CommandSpec => ({
    id,
    label,
    icon,
    slash: false,
    isEnabled: (state) => pictureField(state, what) !== null,
    run: (state, dispatch) => {
      const field = pictureField(state, what);
      if (field === null) return false;
      if (what === 'caption') {
        // Word's Insert Caption on a plain picture: it becomes a figure (one undo step), then the caption box takes the focus.
        const made = captionFigure(state);
        if (made) {
          dispatch(made.tr);
          if (made.notes.length) flash(made.notes.join(' '));
        }
      }
      open(field);
      return true;
    },
  });
  return [
    jump('picture.caption', 'Edit caption', 'comment', 'caption'),
    jump('picture.alt', 'Alt text', 'tag', 'alt'),
    jump('picture.path', 'Change picture', 'folder-opened', 'path'),
    { id: 'picture.properties', label: 'Picture properties', icon: 'symbol-property', slash: false, isEnabled: (state) => pictureSelected(state), run: () => (open(undefined), true) },
  ];
}
