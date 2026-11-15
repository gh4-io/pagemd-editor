// The image tools' dialog (P15; P27: the pixel dialogs are gone with the pixel edits, ADR-0019): choose between a few answers
// (the first redaction's note, R-251). Editor UI: VS Code's colors. Keyboard: Tab between the buttons (kept inside), Enter or
// Space on the focused one (the first, recommended answer has the focus), Esc cancels.

export interface DialogAction {
  id: string;
  label: string;
}

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The dialog frame: a backdrop, a box with a title, Tab kept inside, Esc closing. */
function frame(doc: Document, title: string, close: () => void): { backdrop: HTMLElement; box: HTMLElement } {
  const backdrop = element(doc, 'div', 'pmd-imgdlg-backdrop');
  const box = element(doc, 'div', 'pmd-imgdlg');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const heading = element(doc, 'h2', 'pmd-imgdlg-title', title);
  heading.id = `pmd-imgdlg-title-${Math.random().toString(36).slice(2)}`;
  box.setAttribute('aria-labelledby', heading.id);
  box.append(heading);
  backdrop.append(box);
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const focusable = [...box.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter((el) => !(el as HTMLButtonElement).disabled);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  return { backdrop, box };
}

/** Asks a question with a few answers (the first is the recommended one, taken by Enter); null for Cancel or Esc. */
export function askChoice(doc: Document, title: string, message: string, actions: readonly DialogAction[]): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = doc.activeElement as HTMLElement | null;
    const finish = (result: string | null): void => {
      backdrop.remove();
      previous?.focus?.({ preventScroll: true });
      resolve(result);
    };
    const { backdrop, box } = frame(doc, title, () => finish(null));
    const note = element(doc, 'p', 'pmd-imgdlg-message', message);
    box.append(note);
    const buttons = element(doc, 'div', 'pmd-imgdlg-buttons');
    for (const [i, action] of [...actions, { id: 'cancel', label: 'Cancel' }].entries()) {
      const button = element(doc, 'button', `pmd-imgdlg-button${i === 0 ? ' pmd-imgdlg-primary' : ''}`, action.label);
      button.type = 'button';
      button.dataset['action'] = action.id;
      button.addEventListener('click', () => finish(action.id === 'cancel' ? null : action.id));
      buttons.append(button);
    }
    box.append(buttons);
    doc.body.append(backdrop);
    buttons.querySelector<HTMLButtonElement>('button')?.focus();
  });
}

export const imageEditorCss = `
.pmd-imgdlg-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--vscode-editor-background) 60%, transparent); }
.pmd-imgdlg { max-width: min(90vw, 960px); max-height: 92vh; overflow: auto; box-sizing: border-box; padding: 12px 16px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); box-shadow: 0 4px 16px var(--vscode-widget-shadow, transparent); }
.pmd-imgdlg-title { font-size: 1.1em; font-weight: 600; margin: 0 0 8px; }
.pmd-imgdlg-message { margin: 0 0 8px; color: var(--vscode-descriptionForeground); max-width: 60ch; }
.pmd-imgdlg-buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.pmd-imgdlg-button { font: inherit; padding: 4px 12px; cursor: pointer; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-button-border, transparent); }
.pmd-imgdlg-primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.pmd-imgdlg-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
`;
