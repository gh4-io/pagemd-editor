// @pagemd-editor/pagination: Print Layout's pages (P6, amendment 6). The canvas becomes a column of paper pages
// following the document's page geometry; breaks are measured from the rendered canvas (not Paged.js, which stays
// for Print Preview, P10) and follow the profile's own `break-*` CSS. Drawn read-only; the text stays editable.
export { layoutPages, type BreakValue, type ContentHeight, type Leaf, type Line, type Page, type PageStart } from './layout.ts';
export { breakValue, canvasElementOf, GAP_CLASS, Measurer, stacks, strongest, type FramePiecesOf, type MarkerOf, type MeasuredLeaf, type Measurement, type PageMarker } from './measure.ts';
export { FRAME_GAP_CLASS, MARKER_CLASS, OUTSIDE_CHANGE_META, PAGED_CLASS, Pagination, PX_PER_MM, type PageInfo, type PageLayout, type PageSetup, type PaginationOptions } from './paginator.ts';
export { paginationCss, PRINT_CLASS } from './css.ts';
export { drawRunning, drawSizeTags, firstsOfType, FOOTER_CLASS, HEADER_CLASS, papersOf, PDF_FLATTENS_PAGE_SIZES, pdfSizeNotes, runningCss, SIZE_TAG_CLASS, sizeLabel, sizeNoteText, type PdfSizeNote } from './headers.ts';
export { arrangeCss, cellHeightOf, COLUMNS_CLASS, PageArranger, placement, type Placement } from './arrange.ts';
export { fill, namedFor, runningFor, type RunningBoxes, type RunningFor, type RunningPage } from './running.ts';
export { clampZoom, columnsFor, MAX_ZOOM, MIN_ZOOM, zoomFor, ZOOM_STEPS } from './zoom.ts';
