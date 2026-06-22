/**
 * Write helpers for `hivemind_docs` — INSERT-only against the immutable
 * skills/rules-table pattern. Every edit appends a fresh row with version+1;
 * we never UPDATE. Reads (see ./read.ts) pick the latest version per doc_id.
 *
 * Why no UPDATEs: the Deeplake backend silently coalesces two rapid UPDATEs
 * on the same row (see CLAUDE.md "UPDATE coalescing quirk"). INSERT-only
 * sidesteps the bug entirely. See `src/rules/write.ts` for the precedent and
 * `deeplake-schema.ts` DOCS_COLUMNS for the column list.
 *
 * Differences from rules:
 *   - `doc_id` is the documented source file path, supplied by the caller
 *     (the file path IS the stable identity), not a generated UUID.
 *   - `content` is markdown and MAY contain newlines — they are preserved,
 *     not rejected (unlike rule bodies, which are single-line).
 *   - `created_at` is an immutable creation timestamp carried across every
 *     version bump; only `updated_at` advances. This mirrors the
 *     timestamp-preservation pattern used by goals/skills.
 */

import { randomUUID } from "node:crypto";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import type { DocAnchor, DocRow, DocTier, QueryFn } from "./read.js";
import { getDocLatest } from "./read.js";

export interface InsertDocInput {
  /** Documented source file path, e.g. `src/shell/deeplake-fs.ts`. Stable key. */
  doc_id: string;
  /** VFS path the doc is read from, e.g. `/docs/<project>/<file>.md`. */
  path: string;
  /** Markdown body. */
  content: string;
  /** Anchors tying doc sections to graph nodes. Default []. */
  anchors?: DocAnchor[];
  /** `fast` (per-file, default) or `slow` (protected project knowledge). */
  tier?: DocTier;
  /** Project key the doc belongs to. Empty string lands the column default. */
  project?: string;
  /** Override the `agent` column. Default "manual". */
  agent?: string;
  /** Plugin version that produced the write. Empty string lands the default. */
  plugin_version?: string;
}

export interface EditDocInput {
  /** Stable doc_id (the source file path). */
  doc_id: string;
  /** New markdown body. Omit to keep the previous content. */
  content?: string;
  /** New anchors. Omit to keep the previous anchors. */
  anchors?: DocAnchor[];
  /** New tier. Omit to keep the previous tier. */
  tier?: DocTier;
  /** New status. Omit to keep the previous status. */
  status?: "active" | "archived";
  /** New VFS path. Omit to keep the previous path. */
  path?: string;
  agent?: string;
  plugin_version?: string;
}

export interface WriteResult {
  doc_id: string;
  version: number;
}

const MAX_CONTENT_LENGTH = 50_000;

/**
 * Validate the markdown body. Throws on empty input or over-cap length.
 * Newlines are allowed — docs are multi-line by nature.
 */
function assertValidContent(content: string): void {
  if (content.length === 0) throw new Error("Doc content must not be empty");
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(
      `Doc content exceeds ${MAX_CONTENT_LENGTH} chars (got ${content.length})`,
    );
  }
}

/** Serialize anchors to a JSON string for the `anchors` TEXT column. */
function serializeAnchors(anchors: DocAnchor[]): string {
  return JSON.stringify(
    anchors.map(a => ({ symbol_id: a.symbol_id, content_hash: a.content_hash })),
  );
}

/**
 * Insert a brand new per-file doc at version=1. `created_at` and
 * `updated_at` are both stamped now; later edits carry `created_at` forward.
 */
export async function insertDoc(
  query: QueryFn,
  tableName: string,
  input: InsertDocInput,
): Promise<WriteResult> {
  assertValidContent(input.content);
  if (input.doc_id.length === 0) throw new Error("Doc doc_id must not be empty");
  const safe = sqlIdent(tableName);
  const rowId = randomUUID();
  const now = new Date().toISOString();
  const anchors = serializeAnchors(input.anchors ?? []);
  const tier: DocTier = input.tier ?? "fast";

  const sql =
    `INSERT INTO "${safe}" ` +
    `(id, doc_id, path, content, anchors, tier, status, project, version, ` +
    `created_at, updated_at, agent, plugin_version) ` +
    `VALUES (` +
    `'${sqlStr(rowId)}', ` +
    `'${sqlStr(input.doc_id)}', ` +
    `'${sqlStr(input.path)}', ` +
    `E'${sqlStr(input.content)}', ` +
    `E'${sqlStr(anchors)}', ` +
    `'${sqlStr(tier)}', ` +
    `'active', ` +
    `'${sqlStr(input.project ?? "")}', ` +
    `1, ` +
    `'${sqlStr(now)}', ` +
    `'${sqlStr(now)}', ` +
    `'${sqlStr(input.agent ?? "manual")}', ` +
    `'${sqlStr(input.plugin_version ?? "")}'` +
    `)`;
  await query(sql);
  return { doc_id: input.doc_id, version: 1 };
}

/**
 * Edit an existing doc. Reads the latest version, then INSERTs a new row
 * with version+1 carrying the merged fields (omitted fields inherit from
 * the prior version). The immutable `created_at` is carried forward;
 * `updated_at` advances to now. Throws when the `doc_id` does not exist.
 */
export async function editDoc(
  query: QueryFn,
  tableName: string,
  input: EditDocInput,
): Promise<WriteResult> {
  const previous = await getDocLatest(query, tableName, input.doc_id);
  if (!previous) {
    throw new Error(`Doc not found: ${input.doc_id}`);
  }
  return appendVersion(query, tableName, previous, input);
}

async function appendVersion(
  query: QueryFn,
  tableName: string,
  previous: DocRow,
  next: EditDocInput,
): Promise<WriteResult> {
  const content = next.content ?? previous.content;
  assertValidContent(content);
  const safe = sqlIdent(tableName);
  const rowId = randomUUID();
  const now = new Date().toISOString();
  const nextVersion = previous.version + 1;
  const anchors = serializeAnchors(next.anchors ?? previous.anchors);
  const tier: DocTier = next.tier ?? previous.tier;
  const status = next.status ?? (previous.status as "active" | "archived");
  const path = next.path ?? previous.path;

  const sql =
    `INSERT INTO "${safe}" ` +
    `(id, doc_id, path, content, anchors, tier, status, project, version, ` +
    `created_at, updated_at, agent, plugin_version) ` +
    `VALUES (` +
    `'${sqlStr(rowId)}', ` +
    `'${sqlStr(previous.doc_id)}', ` +
    `'${sqlStr(path)}', ` +
    `E'${sqlStr(content)}', ` +
    `E'${sqlStr(anchors)}', ` +
    `'${sqlStr(tier)}', ` +
    `'${sqlStr(status)}', ` +
    `'${sqlStr(previous.project)}', ` +
    `${nextVersion}, ` +
    // created_at carried from the original row — immutable creation stamp.
    `'${sqlStr(previous.created_at)}', ` +
    `'${sqlStr(now)}', ` +
    `'${sqlStr(next.agent ?? "manual")}', ` +
    `'${sqlStr(next.plugin_version ?? "")}'` +
    `)`;
  await query(sql);
  return { doc_id: previous.doc_id, version: nextVersion };
}

/** Test-only export so unit tests can verify the cap without monkey-patching. */
export const _MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH;
