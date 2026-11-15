// P24: Split on a cell that is not merged adds a column (Word's Split Cells), against a pretend VS Code that answers the canvas's edits and
// reports VS Code's undo as an outside change. Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, openEditor, sent } from '../support/host.ts';
import { settle } from './pagination-harness.ts';


const open = (page: Page, text: string, mode: string) => openEditor(page, text, { mode });


const TABLE = '| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall | x | y |\n| ^^ | p | q |\n<!-- ::TABLE widths="20% 30% 50%" -->';
const DOC = `# Tables\n\nBefore.\n\n${TABLE}\n\nAfter.\n`;
const cell = (page: Page, text: string) => page.locator('.pmd-canvas td, .pmd-canvas th').filter({ hasText: new RegExp(`^${text}$`) }).first();
const button = (page: Page, command: string) => page.locator(`.pmd-ribbon [data-command="${command}"]`);
const isOff = async (page: Page, command: string) => (await button(page, command).getAttribute('aria-disabled')) === 'true';

test.describe('P24: Split on a plain cell adds a column', () => {
  {
    const mode = 'print'; // one view is enough: the logic is in the unit tests (23), Web Layout draws the same table
    test(`${mode}: Split writes an empty cell and the spans, halves the width, selects both cells, and one undo takes it all back`, async ({ page }) => {
      const { host, errors } = await open(page, DOC, mode);
      await cell(page, 'x').click();
      await expect.poll(() => isOff(page, 'table.split-cell')).toBe(false); // (off before P24: a plain cell)
      await button(page, 'table.split-cell').click();
      const split = DOC.replace(TABLE, '| A | B || C |\n| --- | --- | --- | --- |\n| wide ||| 3 |\n| tall | x |  | y |\n| ^^ | p || q |\n<!-- ::TABLE widths="20% 15% 15% 50%" -->');
      expect(await host.settle((text) => text !== DOC)).toBe(split);
      expect(host.undoStack.length).toBe(1); // one edit, so one undo step
      await expect(page.locator('.pmd-canvas .selectedCell')).toHaveCount(2); // both new cells, as in Word
      await expect.poll(() => isOff(page, 'table.merge-cells')).toBe(false);
      await expect(page.locator('.pmd-table-prompt')).toHaveCount(0); // standard form: no "fix" bar
      await expect(page.locator('.pmd-canvas tr').nth(2).locator('td, th')).toHaveCount(4);
      await host.undo();
      expect(host.text).toBe(DOC);
      await expect.poll(() => page.locator('.pmd-canvas tr').nth(2).locator('td, th').count()).toBe(3);
      expect(errors).toEqual([]);
    });
  }

  test('the tooltip says when Split is off: several cells selected', async ({ page }) => {
    await open(page, DOC, 'print');
    const a = (await cell(page, 'x').boundingBox())!;
    const b = (await cell(page, 'y').boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.pmd-canvas .selectedCell')).toHaveCount(2);
    expect(await isOff(page, 'table.split-cell')).toBe(true);
    expect(await button(page, 'table.split-cell').getAttribute('title')).toContain('Split works on one cell');
  });
});
