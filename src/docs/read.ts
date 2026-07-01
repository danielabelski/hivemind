/**
 * Read helpers for `hivemind_docs`.
 *
 * The table is append-only with a per-doc version monotone (see ./write.ts).
 * Reads always pick the latest row per `doc_id`. Same shape as `src/rules/` —
 * v1 fetches the candidate rows and deduplicates in JS, portable across
 * whatever subset of Postgres window functions Deeplake exposes and fast
 * enough at the expected per-repo scale (file counts in the hundreds).
 *
 * `doc_id` is the stable key = the documented source file path (e.g.
 * `src/shell/deeplake-fs.ts`). `anchors` is persisted as a JSON string and
 * re-parsed here into `DocAnchor[]`; a malformed value degrades to `[]`
 * rather than throwing, so a single bad row never poisons a list read.
 */

import { sqlIdent, sqlLike, sqlStr } from "../utils/sql.js";
import { stableUnionRows } from "./stable-read.js";

export type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

/** Doc tier — `fast` per-file docs vs `slow` protected project knowledge. */
export type DocTier = "fast" | "slow";

/** One anchor tying a doc to a graph node + a hash of the code it describes. */
export interface DocAnchor {
  /** Graph node id: `<source_file>:<symbol_name>:<kind>`. */
  symbol_id: string;
  /** sha256 of the symbol's source slice when the doc was last written. */
  content_hash: string;
}

/** Shape of one row in `hivemind_docs` — mirrors DOCS_COLUMNS exactly. */
export interface DocRow {
  id: string;
  doc_id: string;
  path: string;
  content: string;
  anchors: DocAnchor[];
  tier: DocTier;
  status: string;
  project: string;
  version: number;
  created_at: string;
  updated_at: string;
  agent: string;
  plugin_version: string;
}

export interface ListDocsOpts {
  /** Filter by status. Default 'active'. Pass 'all' for everything. */
  status?: "active" | "archived" | "all";
  /** Filter to one project. Omit for all projects. */
  project?: string;
  /** Max rows returned. Default 200. */
  limit?: number;
}

const SELECT_COLS =
  "id, doc_id, path, content, anchors, tier, status, project, version, " +
  "created_at, updated_at, agent, plugin_version";

/**
 * Return the latest version row for every distinct `doc_id`, filtered by
 * status (and optionally project), capped at `limit`. The "latest per id"
 * dedup happens in JS — see module docstring for the rationale.
 *
 * Newest-first ordering (by `updated_at` of the winning version) so a
 * caller listing docs sees the most-recently-refreshed files first.
 */
export async function listDocs(
  query: QueryFn,
  tableName: string,
  opts: ListDocsOpts = {},
): Promise<DocRow[]> {
  const safe = sqlIdent(tableName);
  // Read through the stability gate: the Deeplake backend can return a partial
  // row set right after writes, which would make a refresh silently skip stale
  // docs. stableUnionRows re-reads until the union converges so we see EVERY
  // row. (ORDER BY is moot through the union — we re-sort after dedup below.)
  const rows = await stableUnionRows(
    query,
    `SELECT ${SELECT_COLS} FROM "${safe}" ORDER BY version DESC, updated_at DESC, id DESC`,
  );

  const latest = new Map<string, DocRow>();
  for (const r of rows) {
    const row = normalize(r);
    if (!row) continue;
    if (!latest.has(row.doc_id)) latest.set(row.doc_id, row);
  }

  const statusFilter = opts.status ?? "active";
  const filtered = [...latest.values()].filter(r => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (opts.project !== undefined && r.project !== opts.project) return false;
    return true;
  });

  filtered.sort(
    (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id),
  );
  return filtered.slice(0, opts.limit ?? 200);
}

/** Light per-doc metadata for the index — no content, no anchors. */
export interface DocMetaRow {
  doc_id: string;
  version: number;
  updated_at: string;
  status: string;
  tier: DocTier;
}

/**
 * Latest-version METADATA for every doc (optionally scoped to a directory
 * prefix), WITHOUT pulling the `content`/`anchors` columns. This is the cheap
 * read behind the browsable docs index: the top levels need only counts and
 * timestamps, so we never transfer document bodies to render them.
 *
 * `dirPrefix` (e.g. `src/graph`) filters server-side via `doc_id LIKE`, so a
 * drill-down into one directory reads only that directory's rows.
 */
export async function listDocMeta(
  query: QueryFn,
  tableName: string,
  opts: { dirPrefix?: string } = {},
): Promise<DocMetaRow[]> {
  const safe = sqlIdent(tableName);
  const where =
    opts.dirPrefix !== undefined && opts.dirPrefix !== ""
      ? ` WHERE doc_id LIKE '${sqlLike(opts.dirPrefix)}/%'`
      : "";
  // `id` is selected (not returned) so the read-stability gate can union rows
  // by their unique key — see stableUnionRows(idKey="id").
  const rows = await stableUnionRows(
    query,
    `SELECT id, doc_id, version, updated_at, status, tier FROM "${safe}"${where}`,
  );
  const latest = new Map<string, DocMetaRow>();
  for (const r of rows) {
    const doc_id = String(r.doc_id ?? "");
    if (doc_id === "") continue;
    const vRaw = r.version;
    const version = typeof vRaw === "number" ? vRaw : Number(vRaw);
    if (!Number.isFinite(version)) continue;
    const updated_at = String(r.updated_at ?? "");
    const prev = latest.get(doc_id);
    if (!prev || version > prev.version || (version === prev.version && updated_at > prev.updated_at)) {
      const tier = String(r.tier ?? "fast");
      latest.set(doc_id, {
        doc_id,
        version,
        updated_at,
        status: String(r.status ?? ""),
        tier: tier === "slow" ? "slow" : "fast",
      });
    }
  }
  return [...latest.values()];
}

/**
 * Latest full row for each of `docIds` (a filtered `doc_id IN (...)` read).
 * Two uses: fetching the small set of files' content for the index summary
 * column, and — the scale path — loading only the docs a commit's diff can
 * affect instead of the whole table. Returns latest-per-doc, active or not;
 * the caller filters by status. An empty `docIds` returns `[]` with no query.
 */
export async function listDocsByIds(
  query: QueryFn,
  tableName: string,
  docIds: string[],
): Promise<DocRow[]> {
  const ids = [...new Set(docIds.filter((d) => d !== ""))];
  if (ids.length === 0) return [];
  const safe = sqlIdent(tableName);
  const inList = ids.map((d) => `'${sqlStr(d)}'`).join(", ");
  const rows = await stableUnionRows(
    query,
    `SELECT ${SELECT_COLS} FROM "${safe}" WHERE doc_id IN (${inList})`,
  );
  const latest = new Map<string, DocRow>();
  for (const r of rows) {
    const row = normalize(r);
    if (!row) continue;
    const prev = latest.get(row.doc_id);
    if (!prev || row.version > prev.version || (row.version === prev.version && row.updated_at > prev.updated_at)) {
      latest.set(row.doc_id, row);
    }
  }
  return [...latest.values()];
}

/**
 * Return the latest version of a single doc by `doc_id`, or `null` if it
 * does not exist. Used by `editDoc` in ./write.ts to carry over the prior
 * content / immutable `created_at` when the caller omits a field.
 */
export async function getDocLatest(
  query: QueryFn,
  tableName: string,
  docId: string,
): Promise<DocRow | null> {
  const safe = sqlIdent(tableName);
  // Read ALL version rows for this doc through the stability gate, then pick
  // the latest in JS. A bare `... ORDER BY version DESC LIMIT 1` is unsafe on
  // this backend: a partial read can return an OLD version as "latest" (or
  // zero rows) right after a write. Unioning every version row and choosing
  // the max guarantees we never resolve to a stale version or miss the doc.
  const raw = await stableUnionRows(
    query,
    `SELECT ${SELECT_COLS} FROM "${safe}" WHERE doc_id = '${sqlStr(docId)}'`,
  );
  let best: DocRow | null = null;
  for (const r of raw) {
    const row = normalize(r);
    if (!row) continue;
    if (
      best === null ||
      row.version > best.version ||
      (row.version === best.version &&
        (row.updated_at.localeCompare(best.updated_at) > 0 ||
          (row.updated_at === best.updated_at && row.id.localeCompare(best.id) > 0)))
    ) {
      best = row;
    }
  }
  return best;
}

/** Parse the `anchors` JSON cell into a typed array; degrade to [] on garbage. */
export function parseAnchors(raw: unknown): DocAnchor[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return [];
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: DocAnchor[] = [];
  for (const item of arr) {
    if (item && typeof item === "object") {
      const sid = (item as Record<string, unknown>).symbol_id;
      const hash = (item as Record<string, unknown>).content_hash;
      if (typeof sid === "string" && typeof hash === "string") {
        out.push({ symbol_id: sid, content_hash: hash });
      }
    }
  }
  return out;
}

/**
 * Coerce a row from the Deeplake API client into a typed DocRow. The client
 * returns `Record<string, unknown>` because it has no schema awareness —
 * this is where we re-attach the static type and parse `anchors`.
 */
function normalize(row: Record<string, unknown>): DocRow | null {
  // version arrives as number (parsed by the client) or string (raw cell).
  // Normalize to number; a NaN means the row was malformed and we drop it.
  const vRaw = row.version;
  const version =
    typeof vRaw === "number" ? vRaw : typeof vRaw === "string" ? Number(vRaw) : NaN;
  if (!Number.isFinite(version)) return null;
  const tier = String(row.tier ?? "fast");
  return {
    id: String(row.id ?? ""),
    doc_id: String(row.doc_id ?? ""),
    path: String(row.path ?? ""),
    content: String(row.content ?? ""),
    anchors: parseAnchors(row.anchors),
    tier: tier === "slow" ? "slow" : "fast",
    status: String(row.status ?? ""),
    project: String(row.project ?? ""),
    version,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    agent: String(row.agent ?? ""),
    plugin_version: String(row.plugin_version ?? ""),
  };
}
