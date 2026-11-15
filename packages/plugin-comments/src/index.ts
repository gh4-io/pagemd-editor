// @pagemd-editor/plugin-comments: review comments (P12, ADR-0015, R-178–R-181). The thread model and its side file
// (model.ts), the store that loads and saves it through ISidecar (store.ts) and the ProseMirror plugin that tints the
// commented blocks and finds the anchors (plugin.ts). The anchor node itself is preset-pagemd's.
export * from './model.ts';
export { CommentsStore, type StoreOptions, type StoreStatus } from './store.ts';
export {
  anchorsOf,
  commentsKey,
  commentsPlugin,
  findAnchors,
  quoteFor,
  refreshComments,
  setActiveComment,
  threadAt,
  type AnchorInfo,
  type CommentsPluginOptions,
  type CommentsPluginState,
  type ThreadStatus,
} from './plugin.ts';
