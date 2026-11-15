// One polite live region for everything the page says to a screen reader that nothing else says (P13b, AD-P13-10, amendment 8e):
// "Print Layout", "Page 3 of 12", the region F6 landed in, a picture selected. Components never own one; they ask the app,
// which calls `announce`. (Spots that already are a live region of their own, such as the find bar's count and the
// status bar, keep working; this is for the rest.)

/** Visually hidden, read by screen readers. */
export const announceCss = `
.pmd-announcer { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
`;

export class Announcer {
  readonly element: HTMLElement;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** What was said, newest last (kept short: tests and the keyboard journey read it). */
  readonly log: string[] = [];

  constructor(parent: HTMLElement) {
    this.element = parent.ownerDocument.createElement('div');
    this.element.className = 'pmd-announcer';
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');
    this.element.setAttribute('aria-atomic', 'true');
    parent.append(this.element);
  }

  /** Says `message`. The same message twice in a row is still said (the region is cleared first). */
  announce(message: string): void {
    if (!message) return;
    this.log.push(message);
    if (this.log.length > 50) this.log.shift();
    clearTimeout(this.#timer);
    this.element.textContent = '';
    this.#timer = setTimeout(() => {
      this.element.textContent = message;
    }, 60);
  }
}
