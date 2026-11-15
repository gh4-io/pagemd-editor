import { describe, expect, it } from 'vitest';
import { defaultStyles, draftCss } from '../src/index.ts';

describe('style-default', () => {
  it('has the ResolvedStyles shape, marked as the default layout', () => {
    const styles = defaultStyles();
    expect(styles.usingDefault).toBe(true);
    expect(styles.sources).toEqual(['@pagemd-editor/style-default']);
    // Letter, 1 in margins: pagemd's default page (P5, amendment 10).
    expect(styles.page).toEqual({ width: 215.9, height: 279.4, margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } });
  });

  it('scopes every rule to .pmd-canvas and colors only through VS Code theme variables', () => {
    const selectors = [...draftCss.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()));
    expect(selectors.length).toBeGreaterThan(5);
    expect(selectors.filter((s) => !s.startsWith('.pmd-canvas'))).toEqual([]);
    expect(draftCss).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });
});
