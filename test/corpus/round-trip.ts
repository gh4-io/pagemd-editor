// The open + save step the corpus harness checks: transformer (open) + lossless (save) with no edits.
import { createTransformer } from '@pagemd-editor/transformer';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';

export const transformer = createTransformer(commonmarkItems);

export function roundTrip(source: string): string {
  const doc = transformer.parse(source);
  return applyEdits(source, diffToEdits(doc, doc, source));
}
