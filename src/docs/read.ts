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
import { pickByScopePrecedence } from "./branch-scope.js";

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
  /** Shared view (`main` = canonical). Defaults to `main` when the column is
   *  absent — generic reads do NOT select it so un-healed tables keep working;
   *  only post-ensure paths (meta/pull/wiki) read or filter by it. */
  scope?: string;
  version: number;
  created_at: string;
  updated_at: string;
  agent: string;
  plugin_version: string;
}

export interface ListDocsOpts {
  /** Filter by status. Default 'active'. Pass 'all' for everything. */
  status?: "active" | "archived" | "all";
  /** Filter to one project (STRICT). Omit for all projects. */
  project?: string;
  /** Filter to one project but keep legacy unstamped rows (project='') visible. */
  projectOrLegacy?: string;
  /** Max rows returned. Default 200. */
  limit?: number;
}

/**
 * Row selector SQL. `project` = STRICT (write paths: never touch another
 * project's row). `projectOrLegacy` = read paths on shared tables: scope to
 * one project but keep legacy rows (written before stamping, project='')
 * visible everywhere. `scope` = the identity dimension (`main` = canonical,
 * `u:<user>|b:<branch>` = overlay): when set, resolution is confined to that
 * scope so a write/read never crosses into a sibling branch overlay or main.
 */
function buildProjectFilter(opts: { project?: string; projectOrLegacy?: string; scope?: string }): string {
  const clauses: string[] = [];
  if (opts.project !== undefined) {
    clauses.push(`project = '${sqlStr(opts.project)}'`);
  } else if (opts.projectOrLegacy !== undefined) {
    clauses.push(`(project = '${sqlStr(opts.projectOrLegacy)}' OR project = '')`);
  }
  if (opts.scope !== undefined) {
    clauses.push(`scope = '${sqlStr(opts.scope)}'`);
  }
  return clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
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

  // Dedup key includes the project: in a shared org table the same doc_id
  // legitimately exists once per project, and a doc_id-only dedup would let
  // one project's row shadow another's (the project filter below would then
  // silently drop the requested project's doc).
  // Latest is picked by EXPLICIT comparison (version, updated_at, id) — the
  // SQL ORDER BY does not survive stableUnionRows (union order is first-seen
  // across re-reads), so "first row wins" could keep a stale version.
  const latest = new Map<string, DocRow>();
  for (const r of rows) {
    const row = normalize(r);
    if (!row) continue;
    if (row.doc_id === "_meta") continue; // reserved refresh-bookkeeping row, not a doc
    if (opts.project !== undefined && row.project !== opts.project) continue;
    if (opts.projectOrLegacy !== undefined && row.project !== opts.projectOrLegacy && row.project !== "") continue;
    const key = `${row.project}\u0000${row.doc_id}`;
    const prev = latest.get(key);
    if (
      !prev ||
      row.version > prev.version ||
      (row.version === prev.version &&
        (row.updated_at.localeCompare(prev.updated_at) > 0 ||
          (row.updated_at === prev.updated_at && row.id.localeCompare(prev.id) > 0)))
    ) {
      latest.set(key, row);
    }
  }

  const statusFilter = opts.status ?? "active";
  const filtered = [...latest.values()].filter(r => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
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
  opts: { dirPrefix?: string; project?: string } = {},
): Promise<DocMetaRow[]> {
  const safe = sqlIdent(tableName);
  const clauses: string[] = [];
  if (opts.dirPrefix !== undefined && opts.dirPrefix !== "") {
    clauses.push(`doc_id LIKE '${sqlLike(opts.dirPrefix)}/%'`);
  }
  // Project scoping for shared org tables. Legacy rows (written before
  // project stamping) carry '' and stay visible to every project.
  if (opts.project !== undefined) {
    clauses.push(`(project = '${sqlStr(opts.project)}' OR project = '')`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
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
    if (doc_id === "_meta") continue; // reserved refresh-bookkeeping row, not a doc
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
  opts: { project?: string; projectOrLegacy?: string; scope?: string } = {},
): Promise<DocRow[]> {
  const ids = [...new Set(docIds.filter((d) => d !== ""))];
  if (ids.length === 0) return [];
  const safe = sqlIdent(tableName);
  const inList = ids.map((d) => `'${sqlStr(d)}'`).join(", ");
  // Optional project selector: in a shared org table the same doc_id exists
  // once per project, and an unscoped read can resolve to the wrong project's
  // row. Omitting it keeps the historical single-project behavior.
  const projFilter = buildProjectFilter(opts);
  const rows = await stableUnionRows(
    query,
    `SELECT ${SELECT_COLS} FROM "${safe}" WHERE doc_id IN (${inList})${projFilter}`,
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
  opts: { project?: string; projectOrLegacy?: string; scope?: string; readerScope?: string } = {},
): Promise<DocRow | null> {
  const safe = sqlIdent(tableName);
  // Read ALL version rows for this doc through the stability gate, then pick
  // the latest in JS. A bare `... ORDER BY version DESC LIMIT 1` is unsafe on
  // this backend: a partial read can return an OLD version as "latest" (or
  // zero rows) right after a write. Unioning every version row and choosing
  // the max guarantees we never resolve to a stale version or miss the doc.
  // Optional project selector — see listDocsByIds.
  const projFilter = buildProjectFilter(opts);

  // Read-side branch resolution: when a `readerScope` is given, DON'T filter by
  // scope in SQL — fetch every scope's rows for this doc_id and let
  // pickByScopePrecedence choose (reader's overlay > main > foreign: hidden).
  // The `scope` column is selected only in this mode (generic reads stay
  // schema-heal-safe); a table missing the column degrades gracefully — the
  // catch retries without it, so every row reads as `main`.
  if (opts.readerScope !== undefined) {
    const base = `SELECT ${SELECT_COLS}, scope FROM "${safe}" WHERE doc_id = '${sqlStr(docId)}'${projFilter}`;
    let raw: Array<Record<string, unknown>>;
    try {
      raw = await stableUnionRows(query, base);
    } catch {
      raw = await stableUnionRows(
        query,
        `SELECT ${SELECT_COLS} FROM "${safe}" WHERE doc_id = '${sqlStr(docId)}'${projFilter}`,
      );
    }
    const rows = raw.map(normalize).filter((r): r is DocRow => r !== null);
    return pickByScopePrecedence(rows, opts.readerScope);
  }

  const raw = await stableUnionRows(
    query,
    `SELECT ${SELECT_COLS} FROM "${safe}" WHERE doc_id = '${sqlStr(docId)}'${projFilter}`,
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
    scope: String(row.scope ?? "main"),
    version,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    agent: String(row.agent ?? ""),
    plugin_version: String(row.plugin_version ?? ""),
  };
}
