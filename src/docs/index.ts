/**
 * Barrel for `src/docs/`.
 *
 * Consumers (CLI handler, doc-worker, future VFS read routing) import only
 * from this entry point so internal restructuring stays a non-breaking
 * change for callers.
 */

export { insertDoc, editDoc, setDoc, archiveDoc, _MAX_CONTENT_LENGTH } from "./write.js";
export type { InsertDocInput, EditDocInput, SetDocInput, WriteResult } from "./write.js";

export { listDocs, getDocLatest, parseAnchors } from "./read.js";
export type {
  DocRow,
  DocAnchor,
  DocTier,
  ListDocsOpts,
  QueryFn,
} from "./read.js";

export {
  parseSourceLocation,
  readSymbolSource,
  hashSource,
  computeSymbolHash,
  buildAnchor,
  anchorStatus,
} from "./anchors.js";
export type { AnchorStatus } from "./anchors.js";

export { computeStaleDocs, widenByBlastRadius, computeImpactedDocs } from "./impact.js";
export type { StaleReason, ImpactedDoc } from "./impact.js";
