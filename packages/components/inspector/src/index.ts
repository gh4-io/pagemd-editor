// @pagemd-editor/inspector (P8): the Inspector panel on the right (Element and Document tabs, R-3) and the
// document-properties card at the top of the canvas (R-4). Both draw the same forms from the registry: an item's
// fields (`fieldsFor` / `applyFields`) and the document's properties (`registry.properties`, `registry.meta`). One
// package for both, because they share the properties form and a component may import only core (AD-P8-03).
export { Inspector, type InspectorOptions, type InspectorTab } from './inspector.ts';
export { frontmatterCards, type CardOptions, type FrontmatterCards } from './card.ts';
export { PropertiesForm, type PropertiesFormOptions } from './properties.ts';
export { renderFields, icon, iconButton, newRow, type FormOptions } from './form.ts';
export * from './model.ts';
export { inspectorCss } from './css.ts';
