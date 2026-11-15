// P18: which boxes the measuring descends into (their children stack one under another) and which it measures as one piece
// (side by side: the brochure's panels are table cells). The measuring itself runs in the browser (test/e2e/print-fidelity.spec.ts).
import { describe, expect, it } from 'vitest';
import { stacks } from '../src/index.ts';

describe('stacks', () => {
  it('block-like boxes stack their children', () => {
    for (const display of ['block', 'list-item', 'flow-root', '']) expect(stacks(display)).toBe(true);
  });
  it('table cells, flex and grid boxes and inline blocks are one piece', () => {
    for (const display of ['table-cell', 'table', 'flex', 'inline-flex', 'grid', 'inline-block', 'contents']) expect(stacks(display)).toBe(false);
  });
});
