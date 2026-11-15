// A generated pagemd document for the large-document benchmark (P13, AD-P13-09): no 500 kB file in git, the same text every run
// (a seeded generator). Each section has a heading, three paragraphs with some inline markup, a list, a 3 x 3 table, a code block
// and a quote: about 11 blocks, about 1 page of Letter. No pictures (those would measure the disk, not the editor).
const WORDS = 'planning inspection procedure engine hydraulic torque fastener panel sealant record release aircraft schedule interval check task card shift handover tool calibration safety review revision approval supervisor shop floor access zone inspection report'.split(' ');

/** A small seeded random generator (mulberry32): the same numbers for the same seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The markdown of a document of `sections` sections (about `sections` pages). */
export function largeDocument(sections: number, seed = 1): string {
  const rnd = random(seed);
  const word = () => WORDS[Math.floor(rnd() * WORDS.length)]!;
  const words = (n: number) => Array.from({ length: n }, word).join(' ');
  const sentence = () => {
    const s = words(8 + Math.floor(rnd() * 8));
    return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
  };
  const paragraph = (marks: boolean) => {
    const parts = Array.from({ length: 4 + Math.floor(rnd() * 3) }, sentence);
    if (marks) parts[1] = `${parts[1]!.slice(0, -1)} with **${word()}** and *${word()}* and \`${word()}\`.`;
    return parts.join(' ');
  };
  const out: string[] = ['---', 'title: Large benchmark document', '---', '', '# Large benchmark document', ''];
  for (let n = 1; n <= sections; n++) {
    out.push(`## Section ${n}: ${words(3)}`, '', paragraph(true), '', paragraph(false), '', paragraph(true), '');
    out.push(...Array.from({ length: 4 }, () => `- ${sentence()}`), '');
    out.push(`| ${word()} | ${word()} | ${word()} |`, '|---|:---:|---:|');
    for (let r = 0; r < 3; r++) out.push(`| ${words(2)} | ${words(1)} | ${Math.floor(rnd() * 1000)} |`);
    out.push('', '```js', `const ${word()}${n} = ${Math.floor(rnd() * 1000)}; // ${words(3)}`, `run(${word()}${n});`, '```', '', `> ${sentence()}`, '');
  }
  return out.join('\n');
}
