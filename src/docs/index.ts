/**
 * Barrel for `src/docs/`.
 *
 * Consumers (CLI handler, doc-worker, future VFS read routing) import only
 * from this entry point so internal restructuring stays a non-breaking
 * change for callers.
 */

export { insertDoc, insertDocResilient, upsertDoc, editDoc, setDoc, archiveDoc, _MAX_CONTENT_LENGTH } from "./write.js";
export type { InsertDocInput, EditDocInput, SetDocInput, WriteResult, ResilientWriteOpts } from "./write.js";

export { listDocs, listDocMeta, listDocsByIds, getDocLatest, parseAnchors } from "./read.js";
export type {
  DocRow,
  DocMetaRow,
  DocAnchor,
  DocTier,
  ListDocsOpts,
  QueryFn,
} from "./read.js";

export { buildDocsIndex, dirOf, firstDocLine } from "./index-render.js";
export type { DocMeta } from "./index-render.js";

export { changedFilesFromGit, expandToCandidateFiles } from "./candidates.js";
export type { GitRunner } from "./candidates.js";

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

export { gateDocEdit, countChangedLines, DEFAULT_MAX_CHANGED_LINES, GATE_MAX_CONTENT_LENGTH } from "./gate.js";
export type { GateInput, GateResult } from "./gate.js";

export { refreshDocs, buildRefreshPrompt } from "./refresh.js";
export type {
  GenerateFn,
  RefreshContext,
  RefreshArgs,
  RefreshReport,
  RefreshOutcome,
  ChangedSymbol,
} from "./refresh.js";
