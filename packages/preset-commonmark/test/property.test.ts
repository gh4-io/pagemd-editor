// Property tests for parse/serialize (P1 "Tests"). Writing a document fresh (no reused text) and reading
// it back must give the same document:
//  - for random documents built from every CommonMark item (fast-check);
//  - for every plain corpus file and every docs/**/*.md file;
//  - for the CommonMark spec examples, except a pinned list of known differences (R-84 review, item 3).
import fc from 'fast-check';
import type { Mark, Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { createTransformer } from '@pagemd-editor/transformer';
import { commonmarkItems } from '../src/index.ts';
import { docsFiles, plainFiles, specExamples } from '../../../test/corpus/sources.ts';

const t = createTransformer(commonmarkItems);
const { schema } = t;
const n = schema.nodes;
const m = schema.marks;
const rewrite = (doc: Node): Node => t.parse(`${t.serialize(doc)}\n`);

// ── random documents ──
// Words mix letters with every character markdown treats specially, so escaping is exercised.
const word = fc.stringMatching(/^[A-Za-z0-9*_`\\[\]#<>&!+\-.=()~|:;'"]{1,8}$/);
const words = fc.array(word, { minLength: 1, maxLength: 5 }).map((ws) => ws.join(' '));
const plainWords = fc.array(fc.stringMatching(/^[A-Za-z0-9]{1,8}$/), { minLength: 1, maxLength: 4 }).map((ws) => ws.join(' '));
const href = fc.constantFrom('https://example.com/a', '/local/path', 'page.md#part', 'mailto:me@example.com', 'a(b)c');
const title = fc.option(fc.constantFrom('Title', 'say "hi"', "it's"), { nil: null });

type Segment = readonly Node[];
const text = (s: string, marks: readonly Mark[] = []): Node => schema.text(s, marks);
const segment: fc.Arbitrary<Segment> = fc.oneof(
  { weight: 4, arbitrary: words.map((s) => [text(s)]) },
  { weight: 1, arbitrary: fc.tuple(words, fc.constantFrom('*', '_')).map(([s, markup]) => [text(s, [m['em']!.create({ markup })])]) },
  { weight: 1, arbitrary: fc.tuple(words, fc.constantFrom('**', '__')).map(([s, markup]) => [text(s, [m['strong']!.create({ markup })])]) },
  { weight: 1, arbitrary: fc.stringMatching(/^[A-Za-z0-9 `*_]{1,10}$/).filter((s) => s.trim() !== '').map((s) => [text(s, [m['code']!.create()])]) },
  { weight: 1, arbitrary: fc.tuple(plainWords, href, title).map(([s, h, ti]) => [text(s, [m['link']!.create({ href: h, title: ti })])]) },
  { weight: 1, arbitrary: fc.constant([text('https://example.com/auto', [m['link']!.create({ href: 'https://example.com/auto', title: null })])]) },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom('pic.png', 'img/a%20b.png', 'x(1).png'), fc.option(words, { nil: null }), title).map(([src, alt, ti]) => [n['image']!.create({ src, alt, title: ti })]) },
);
/** Segments separated by a space, a soft line break, a hard break, or inline HTML. */
const inline = (allowBreaks: boolean): fc.Arbitrary<Node[]> =>
  fc.tuple(segment, fc.array(fc.tuple(fc.constantFrom(...(allowBreaks ? ['space', 'soft', 'hard', 'html'] : ['space', 'html'])), segment), { maxLength: 4 })).map(([first, rest]) => {
    const out = [...first];
    for (const [sep, seg] of rest) {
      if (sep === 'space') out.push(text(' '));
      else if (sep === 'soft') out.push(text('\n'));
      else if (sep === 'hard') out.push(n['hard_break']!.create());
      else out.push(text(' '), n['html_inline']!.create({ html: '<b>' }), text(' '));
      out.push(...seg);
    }
    return out;
  });

const paragraph = inline(true).map((content) => n['paragraph']!.create(null, content));
const heading = fc.tuple(fc.integer({ min: 1, max: 6 }), fc.boolean(), inline(false)).map(([level, setext, content]) => n['heading']!.create({ level, setext: setext && level <= 2 }, content));
const codeLines = fc.array(fc.stringMatching(/^[A-Za-z0-9 `~#*<>{}();=]{0,12}$/), { minLength: 1, maxLength: 4 }).map((ls) => ls.join('\n'));
const fenced = fc.tuple(codeLines, fc.constantFrom('```', '~~~', '````'), fc.constantFrom('', 'js', 'python title="x"')).map(([code, fence, params]) => {
  // The writer lengthens a fence that the code itself contains; generate what it will write.
  const char = fence[0]!;
  const longest = Math.max(0, ...(code.match(char === '`' ? /`+/g : /~+/g) ?? []).map((r) => r.length));
  return n['code_block']!.create({ params, fence: char.repeat(Math.max(fence.length, longest + 1)) }, code ? text(code) : null);
});
const indented = fc.array(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ();]{0,10}$/), { minLength: 1, maxLength: 3 }).map((ls) => n['code_block']!.create({ params: '', fence: null }, text(ls.join('\n'))));
const rule = fc.constantFrom('---', '***', '___').map((markup) => n['horizontal_rule']!.create({ markup }));
const htmlBlock = fc.constantFrom('<div class="x">\n<p>hi</p>\n</div>', '<!-- a comment -->').map((html) => n['html_block']!.create(null, text(html)));

const leafBlock = fc.oneof({ weight: 5, arbitrary: paragraph }, heading, fenced, indented, rule, htmlBlock);

const blocks = (depth: number): fc.Arbitrary<Node[]> => {
  const inner: fc.Arbitrary<Node> =
    depth <= 0
      ? leafBlock
      : fc.oneof({ weight: 6, arbitrary: leafBlock }, blockquote(depth - 1), bulletList(depth - 1), orderedList(depth - 1));
  return fc.array(inner, { minLength: 1, maxLength: 4 }).map(separate);
};
const blockquote = (depth: number): fc.Arbitrary<Node> => blocks(depth).map((content) => n['blockquote']!.create(null, content));
/**
 * Loose lists hold any blocks. Tight list items hold a paragraph, optionally followed by a block that
 * may sit on the next line (a fence, an ATX heading, a quote, a nested list): anything else needs a
 * blank line, which makes the list loose in markdown itself.
 */
const atx = heading.map((h) => h.type.create({ ...h.attrs, setext: false }, h.content));
/** Indented code can't open a list item (the writer fences it there). */
const listItem = (content: Node[]): Node =>
  n['list_item']!.create(null, content[0]?.type.name === 'code_block' && content[0].attrs['fence'] === null ? [n['paragraph']!.create(null, text('lead')), ...content] : content);
const tightItem = (depth: number): fc.Arbitrary<Node> =>
  fc
    .tuple(paragraph, fc.option(depth <= 0 ? fc.oneof(fenced, atx) : fc.oneof(fenced, atx, blockquote(depth - 1), bulletList(depth - 1)), { nil: undefined }))
    .map(([p, next]) => n['list_item']!.create(null, next ? [p, next] : [p]));
const items = (depth: number, tight: boolean): fc.Arbitrary<Node[]> =>
  fc.array(tight ? tightItem(depth) : blocks(depth).map(listItem), { minLength: 1, maxLength: 3 });
/**
 * Markdown shows "loose" only through a blank line between blocks and through paragraphs: a loose list
 * with one single-block item, or with no paragraph in any item, reads back as tight in any tool.
 */
const expressibleTight = (tight: boolean, li: readonly Node[]): boolean => {
  const hasBlankLine = li.length > 1 || li.some((item) => item.childCount > 1);
  const hasParagraph = li.some((item) => item.firstChild?.type.name === 'paragraph' || [...Array(item.childCount).keys()].some((k) => item.child(k).type.name === 'paragraph'));
  return tight || !hasBlankLine || !hasParagraph;
};
/** `- ---` is itself a rule: an item can't start with a rule drawn with its own bullet character. */
const noRuleOfBullet = (bullet: string, li: Node[]): Node[] =>
  li.map((item) =>
    item.firstChild?.type.name === 'horizontal_rule' && (item.firstChild.attrs['markup'] as string)[0] === bullet
      ? item.copy(item.content.replaceChild(0, n['horizontal_rule']!.create({ markup: bullet === '*' ? '___' : '***' })))
      : item,
  );
const bulletList = (depth: number): fc.Arbitrary<Node> =>
  fc.tuple(fc.constantFrom('-', '*', '+'), fc.boolean()).chain(([bullet, tight]) =>
    items(depth, tight).map((li) => n['bullet_list']!.create({ bullet, tight: expressibleTight(tight, li) }, noRuleOfBullet(bullet, li))),
  );
const orderedList = (depth: number): fc.Arbitrary<Node> =>
  fc.tuple(fc.integer({ min: 0, max: 20 }), fc.constantFrom('.', ')'), fc.boolean()).chain(([order, delim, tight]) =>
    items(depth, tight).map((li) => n['ordered_list']!.create({ order, delim, tight: expressibleTight(tight, li) }, li)),
  );

/**
 * Sequences markdown itself can't write the same way (not writer bugs): two lists of the same kind in a
 * row merge into one, and indented code right after a list or after indented code is written fenced.
 * A paragraph goes between.
 */
function separate(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    const isList = (x: Node) => /list$/.test(x.type.name);
    const isIndented = (x: Node) => x.type.name === 'code_block' && x.attrs['fence'] === null;
    if (prev && ((isList(prev) && (node.type === prev.type || isIndented(node))) || (isIndented(prev) && isIndented(node)))) {
      out.push(n['paragraph']!.create(null, text('between')));
    }
    out.push(node);
  }
  return out;
}

const documents = blocks(2).map((content) => schema.topNodeType.create(null, content));

describe('parse(serialize(doc)) = doc', () => {
  it('random documents (fast-check)', () => {
    fc.assert(
      fc.property(documents, (doc) => {
        doc.check();
        const again = rewrite(doc);
        if (!again.eq(doc)) throw new Error(`written as:\n${t.serialize(doc)}\n\nread back as ${JSON.stringify(again.toJSON())}\nwanted       ${JSON.stringify(doc.toJSON())}`);
      }),
      // PMD_FC_RUNS=200000 for a long soak run.
      { numRuns: Number(process.env['PMD_FC_RUNS'] ?? 2000) },
    );
  });

  it.each([...plainFiles, ...docsFiles].map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const doc = t.parse(entry.text);
    expect(rewrite(doc).toJSON()).toEqual(doc.toJSON());
  });

  // Where a fresh rewrite legitimately reads back differently (reported, not required; approved at the
  // P1 start). Formatting attributes only: a longer fence was needed (137, 147); indented code after a
  // list (257, 313) or opening a list item (7, 273, 274, 278) is written fenced. Content: a newline or tab written as an entity (39, 40);
  // overlapping emphasis prosemirror-markdown can't write (418, 430, 432).
  const KNOWN = [7, 39, 40, 137, 147, 257, 273, 274, 278, 313, 418, 430, 432];

  it('CommonMark spec examples: only the known ones differ', () => {
    const differing = specExamples
      .map((entry, i) => ({ number: i + 1, doc: t.parse(entry.text) }))
      .filter(({ doc }) => !rewrite(doc).eq(doc))
      .map(({ number }) => number);
    expect(differing).toEqual(KNOWN);
    expect(specExamples.length - differing.length).toBe(639);
  });
});
