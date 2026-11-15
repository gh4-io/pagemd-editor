Golden corpus: plain markdown files that must round-trip byte-identically (test/corpus/corpus.test.ts).
Only *.md files here are tested. .gitattributes keeps their exact bytes (CRLF, trailing spaces, no
final newline). The docs/**/*.md files and the CommonMark spec examples are read in place (sources.ts).
