// npm commonmark-spec 0.31.2 ships no types. Only what test/corpus/sources.ts uses.
declare module 'commonmark-spec' {
  const spec: {
    text: string;
    tests: { markdown: string; html: string; section: string; number: number }[];
  };
  export default spec;
}
