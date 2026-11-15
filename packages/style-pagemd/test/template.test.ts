// P18 (R-228): a profile's HTML template for the canvas: filled as pagemd fills it, its body with a content slot, its own <style>
// CSS scoped and added after the profile's (OQ-39).
import { describe, expect, it } from 'vitest';
import { TEMPLATE_SLOT } from '@pagemd-editor/core';
import { resolveStyles, templateParts } from '../src/index.ts';
import { memoryEnv } from './fixtures.ts';

const SLOT = `<${TEMPLATE_SLOT}></${TEMPLATE_SLOT}>`;

const INVITATION = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>{{metadata.title}}</title>
    {{styles}}
    <style>.kicker { letter-spacing: 2pt }</style>
  </head>
  <body class="invite  wide">
    <!-- a docblock that mentions <style> and {{content}} counts for nothing -->
    <article class="invitation">
      <img src=".pagemd/assets/img/logo.png" alt="{{metadata.company_name ?? 'Uncertified Organic Farmers Org'}}" />
      <h1 class="invitation-headline">{{metadata.title}}</h1>
      {{#if metadata.subtitle}}<p class="sub">{{metadata.subtitle}}</p>{{/if}}
      <div class="invitation-body">{{content}}</div>
      <style media="print">.rsvp { border: 1pt solid }</style>
      <div class="rsvp">Please respond by {{metadata.rsvp_by}}</div>
    </article>
  </body>
</html>`;

describe('templateParts', () => {
  it('fills the tokens as pagemd does, keeps the body only, with one content slot where {{content}} was', () => {
    const parts = templateParts(INVITATION, { title: 'Harvest Celebration', rsvp_by: 'October 3' });
    expect(parts.template).not.toBeNull();
    const html = parts.template!.html;
    expect(html).toContain('<h1 class="invitation-headline">Harvest Celebration</h1>');
    expect(html).toContain(`alt="Uncertified Organic Farmers Org"`); // ?? default
    expect(html).not.toContain('class="sub"'); // #if without a value
    expect(html).toContain(`<div class="invitation-body">${SLOT}</div>`);
    expect(html).toContain('Please respond by October 3');
    expect(html).not.toMatch(/<title|<head|<!--|<style|\{\{/);
    expect(html.split(SLOT)).toHaveLength(2); // the comment's {{content}} is gone with the comment
    expect(parts.template!.bodyClass).toBe('invite wide');
  });

  it("collects the template's own <style> CSS in order, a media attribute as @media", () => {
    const { css } = templateParts(INVITATION, {});
    expect(css).toBe('.kicker { letter-spacing: 2pt }\n@media print {\n.rsvp { border: 1pt solid }\n}');
  });

  it('reports tokens with no value and no default', () => {
    expect(templateParts(INVITATION, { title: 'x' }).missing).toEqual(['metadata.rsvp_by']);
  });

  it('no {{content}} in the body: no template (pagemd would show no text either)', () => {
    expect(templateParts('<body><h1>{{metadata.title}}</h1></body>', { title: 't' }).template).toBeNull();
  });

  it('a template without a <body> tag: everything after the head', () => {
    const parts = templateParts('<head><title>x</title></head><main class="m">{{content}}</main>', {});
    expect(parts.template!.html).toBe(`<main class="m">${SLOT}</main>`);
  });
});

describe('resolveStyles with a template (P18)', () => {
  const files = {
    '/proj/package.json': '{}',
    '/proj/profile.json': JSON.stringify({ id: 'inv', extends: 'standard_letter', resources: { template: '${workingPath}/.pagemd/templates/inv.html', css: ['${workingPath}/.pagemd/styles/inv.css'] } }),
    '/proj/.pagemd/templates/inv.html': INVITATION,
    '/proj/.pagemd/styles/inv.css': '.invitation-headline { font-size: 34pt }',
  };
  const doc = '---\ntitle: The Harvest\nrsvp_by: Oct 3\npipeline_profile: profile.json\n---\n\nPlease join us.\n';

  it("gives the canvas the filled template, and the template's own CSS scoped after the profile's", async () => {
    const result = await resolveStyles({ path: '/proj/doc.md', text: doc }, memoryEnv(files));
    expect(result.notes).toEqual([]);
    const styles = result.styles!;
    expect(styles.template!.html).toContain('<h1 class="invitation-headline">The Harvest</h1>');
    expect(styles.template!.html).toContain(SLOT);
    const profileRule = styles.css.indexOf('.pmd-canvas .invitation-headline');
    const ownRule = styles.css.indexOf('.pmd-canvas .kicker');
    expect(profileRule).toBeGreaterThan(-1);
    expect(ownRule).toBeGreaterThan(profileRule); // after the profile's CSS
    expect(styles.css).toContain('.pmd-canvas:where(.pmd-print) .rsvp'); // its print rule follows the canvas's print class
  });

  it('follows the frontmatter: a changed title is a changed template', async () => {
    const result = await resolveStyles({ path: '/proj/doc.md', text: doc.replace('The Harvest', 'Spring Fair') }, memoryEnv(files));
    expect(result.styles!.template!.html).toContain('>Spring Fair</h1>');
  });

  it('pagemd\'s own standard_letter template (the default profile) is drawn too: its header with the title', async () => {
    const result = await resolveStyles({ path: '/proj/doc.md', text: '---\ntitle: Plain\n---\n\nText.\n' }, memoryEnv({ '/proj/package.json': '{}' }));
    expect(result.styles!.template!.html).toContain('<h1 class="document-title">Plain</h1>');
    expect(result.styles!.template!.html).toMatch(new RegExp(`<main class="document-content">\\s*${SLOT}\\s*</main>`));
  });

  it('a template without {{content}}: no template, and a note says why', async () => {
    const result = await resolveStyles({ path: '/proj/doc.md', text: doc }, memoryEnv({ ...files, '/proj/.pagemd/templates/inv.html': '<body><h1>{{metadata.title}}</h1></body>' }));
    expect(result.styles!.template).toBeUndefined();
    expect(result.notes).toMatchObject([{ kind: 'template-without-content' }]);
  });

  it("a template that can't be found: no template, no note (template problems never stop the canvas)", async () => {
    const result = await resolveStyles({ path: '/proj/doc.md', text: doc }, memoryEnv({ ...files, '/proj/.pagemd/templates/inv.html': undefined as unknown as string }));
    expect(result.styles).not.toBeNull();
    expect(result.styles!.template).toBeUndefined();
  });
});
