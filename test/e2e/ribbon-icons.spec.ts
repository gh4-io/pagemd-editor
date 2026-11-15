// P17 in a real browser: the icon-first ribbon. Large buttons put a big icon above a short title, small ones stack three
// high, a narrow window folds groups into drop-down buttons, and the Home tab is drawn (and screenshotted) in a light and
// a dark theme. The harness page has no VS Code theme, so the tests set the theme variables VS Code's "Light Modern" and
// "Dark Modern" themes define. Screenshots go to test-results/p17-ribbon/.
// Run: npm run test:e2e (builds first).
import { expect, test, type Page } from '@playwright/test';
import { fromHost, sent, type Message } from '../support/host.ts';
import { PROTOCOL } from '../support/protocol.ts';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(new URL('./webview.html', import.meta.url).pathname).href;
const fixtures = pathToFileURL(new URL('./fixtures/', import.meta.url).pathname).href;
const PLAIN = { styles: null, gateDefaults: {}, notes: [] };
const TEXT = '# Title\n\nFirst para.\n\nSecond para.\n\n```\ncode\n```\n';


async function waitFor(page: Page, match: (m: Message) => boolean, nth = 0): Promise<Message> {
  let found: Message | undefined;
  await expect.poll(async () => (found = (await sent(page)).filter(match)[nth]), { timeout: 5000 }).toBeTruthy();
  return found!;
}

async function open(page: Page, options: { text?: string; gatedInsert?: 'ask' | 'auto' | 'warn'; mode?: string; gateDefaults?: Record<string, unknown> } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pageUrl);
  await waitFor(page, (m) => m.kind === 'event' && m.name === 'ready');
  await fromHost(page, {
    kind: 'event',
    name: 'init',
    data: { protocol: PROTOCOL, text: options.text ?? TEXT, version: 1, fileName: 'a.md', documentBase: fixtures, testing: true, styles: { ...PLAIN, gateDefaults: options.gateDefaults ?? {} }, settings: { gatedInsert: options.gatedInsert ?? 'ask' }, output: [{ id: 'pagemd', label: 'pagemd', formats: ['pdf', 'html', 'png'] }], mermaidScript: new URL('../../apps/vscode/dist/webview/mermaid/mermaid.min.js', import.meta.url).href },
  });
  await expect(page.locator('body')).toHaveAttribute('data-pmd-webview', 'ready');
  if (options.mode) await fromHost(page, { kind: 'event', name: 'setView', data: { mode: options.mode } });
  return errors;
}


/** The variables VS Code's own themes define for the colors the ribbon uses. */
const THEMES = {
  light: { fg: '#3b3b3b', bg: '#ffffff', widget: '#f8f8f8', border: '#e5e5e5', desc: '#717171', hover: '#b8b8b850', active: '#a6a6a650', focus: '#005fb8' },
  dark: { fg: '#cccccc', bg: '#1f1f1f', widget: '#202020', border: '#2b2b2b', desc: '#9d9d9d', hover: '#5a5d5e50', active: '#63666750', focus: '#0078d4' },
} as const;
type ThemeName = keyof typeof THEMES;

async function theme(page: Page, name: ThemeName) {
  const t = THEMES[name];
  await page.addStyleTag({
    content: `:root { --vscode-font-family: "Segoe UI", system-ui, sans-serif; --vscode-foreground: ${t.fg}; --vscode-editor-background: ${t.bg}; --vscode-editorWidget-background: ${t.widget}; --vscode-panel-border: ${t.border}; --vscode-descriptionForeground: ${t.desc}; --vscode-toolbar-hoverBackground: ${t.hover}; --vscode-toolbar-activeBackground: ${t.active}; --vscode-focusBorder: ${t.focus}; --vscode-icon-foreground: ${t.fg}; }
      body { background: ${t.bg}; color: ${t.fg}; font-family: var(--vscode-font-family); }`,
  });
}

const ribbon = (page: Page) => page.locator('.pmd-ribbon');
const tab = (page: Page, name: string) => ribbon(page).getByRole('tab', { name, exact: true });
const button = (page: Page, command: string) => ribbon(page).locator(`[data-command="${command}"]`);
const shot = (name: string) => `test-results/p17-ribbon/${name}.png`;
const box = async (locator: ReturnType<typeof button>) => (await locator.boundingBox())!;

test.describe('the icon-first ribbon (P17)', () => {
  test('a large button puts a 24 px icon above its short title; the full label stays the tooltip and the accessible name', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    const bold = button(page, 'strong.toggle');
    await expect(bold).toHaveClass(/pmd-ribbon-large/);
    const icon = await box(bold.locator('.codicon'));
    const title = await box(bold.locator('.pmd-ribbon-label'));
    expect(icon.width).toBe(24);
    expect(icon.y + icon.height).toBeLessThanOrEqual(title.y + 1); // the icon is above the title
    expect(await bold.locator('.pmd-ribbon-label').evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px');
    // a short title shows; the accessible name starts with it and holds the full label (WCAG 2.5.3, P13b)
    const bullets = button(page, 'lists.bullet');
    await expect(bullets.locator('.pmd-ribbon-label')).toHaveText('Bullets');
    await expect(bullets).toHaveAttribute('aria-label', 'Bullets (Bulleted list)');
    await expect(ribbon(page).getByRole('button', { name: 'Bulleted list' })).toHaveCount(1);
    await expect(bullets).toHaveAttribute('title', /^Bulleted list/);
  });

  test('small buttons stack three high with the icon beside the title (P20; P27: the Image tab\'s Edit picture group, a picture selected)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page, { text: `${TEXT}\n<!-- ::FIGURE src="wide.png" caption="Shot" -->\n` });
    await page.locator('.pmd-canvas .pmd-figure img').first().click({ position: { x: 4, y: 4 } });
    await expect(tab(page, 'Image')).toHaveAttribute('aria-selected', 'true');
    // Crop and Reset are large; the five small ones between them stack three, then two.
    const stacks = ribbon(page).locator('.pmd-ribbon-group', { has: page.locator('[data-command="image.rotate-left"]') }).locator('.pmd-ribbon-stack');
    await expect(stacks).toHaveCount(2);
    await expect(stacks.first().locator('button')).toHaveCount(3);
    const [a, b, c] = await Promise.all([0, 1, 2].map((i) => box(stacks.first().locator('button').nth(i))));
    expect(a!.y).toBeLessThan(b!.y);
    expect(b!.y).toBeLessThan(c!.y);
    const rotate = button(page, 'image.rotate-left');
    const icon = await box(rotate.locator('.codicon'));
    const title = await box(rotate.locator('.pmd-ribbon-label'));
    expect(icon.x + icon.width).toBeLessThanOrEqual(title.x + 1); // beside, not above
    const missing = await ribbon(page).evaluate((el) => [...el.querySelectorAll('.pmd-ribbon-panel button')].filter((b) => !b.querySelector('.codicon')).map((b) => b.getAttribute('data-command') ?? b.textContent));
    expect(missing, 'Image').toEqual([]); // every button on the Image tab has an icon too
  });

  test('every button on every tab has an icon', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    for (const name of ['Home', 'Insert', 'Table', 'Layout', 'Document', 'Review', 'View']) {
      await tab(page, name).click();
      const missing = await ribbon(page).evaluate((el) => [...el.querySelectorAll('.pmd-ribbon-panel button')].filter((b) => !b.querySelector('.codicon')).map((b) => b.getAttribute('data-command') ?? b.textContent));
      expect(missing, name).toEqual([]);
    }
  });

  for (const name of ['light', 'dark'] as const) {
    test(`Home and Insert in the ${name} theme: text is the theme's color and the ribbon stays compact (screenshots)`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await open(page);
      await theme(page, name);
      const t = THEMES[name];
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      expect(await button(page, 'strong.toggle').locator('.pmd-ribbon-label').evaluate((el) => getComputedStyle(el).color)).toBe(rgb(t.fg));
      expect(await button(page, 'strong.toggle').locator('.codicon').evaluate((el) => getComputedStyle(el).color)).toBe(rgb(t.fg));
      expect(await ribbon(page).locator('.pmd-ribbon-group-label').first().evaluate((el) => getComputedStyle(el).color)).toBe(rgb(t.desc));
      expect(await ribbon(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(rgb(t.widget));
      expect((await box(ribbon(page))).height).toBeLessThan(120);
      await ribbon(page).screenshot({ path: shot(`home-${name}`) });
      await tab(page, 'Insert').click();
      await ribbon(page).screenshot({ path: shot(`insert-${name}`) });
      await tab(page, 'Table').click();
      await ribbon(page).screenshot({ path: shot(`table-${name}`) });
    });
  }

  test('a narrow window folds groups into drop-down buttons (icon and name) before any button is lost; widening restores them', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    await theme(page, 'dark');
    const folded = ribbon(page).locator('.pmd-ribbon-menu-button');
    await expect(folded).toHaveCount(1); // Home: only "Styles" is a drop-down (seven headings)
    const all = await ribbon(page).locator('.pmd-ribbon-panel [data-command]').count();
    await page.setViewportSize({ width: 560, height: 720 });
    await expect.poll(() => folded.count()).toBeGreaterThan(1);
    expect(await ribbon(page).locator('.pmd-ribbon-panel [data-command]').count()).toBe(all); // nothing was dropped
    const panel = await ribbon(page).locator('.pmd-ribbon-panel').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(panel).toBe(true);
    const first = folded.first();
    await expect(first.locator('.codicon')).toHaveCount(1);
    await ribbon(page).screenshot({ path: shot('home-dark-narrow') });
    const foldedGroup = ribbon(page).locator('.pmd-ribbon-group', { has: page.locator('.pmd-ribbon-menu-button') }).last();
    const menuButton = foldedGroup.locator('.pmd-ribbon-menu-button');
    await menuButton.click();
    await expect(foldedGroup.getByRole('menu')).toBeVisible();
    await ribbon(page).locator('.pmd-ribbon-menu:visible').first().evaluate(() => undefined);
    await page.screenshot({ path: shot('home-dark-narrow-open'), clip: { x: 0, y: 0, width: 560, height: 420 } });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(() => folded.count()).toBe(1);
  });
});
