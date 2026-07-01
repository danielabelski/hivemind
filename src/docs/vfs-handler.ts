/**
 * Virtual filesystem handler for the docs index under
 * ~/.deeplake/memory/docs/ — the same intercept pattern as the graph mount
 * (src/graph/vfs-handler.ts), but a SEPARATE surface from the session-memory
 * index so browsing docs never pollutes memory retrieval.
 *
 * Unlike the graph handler (sync, reads a local snapshot), docs live in the
 * Deeplake table, so this handler is ASYNC and takes a `query` seam. It stays
 * cheap by construction: directory levels read metadata only (`listDocMeta`,
 * no content), and one-line summaries are fetched only for the files directly
 * in the viewed directory (`listDocsByIds`).
 *
 * Path shapes (relative to <memory>/docs/):
 *   ""  |  "index.md"            → root index (top directories, counts)
 *   "<dir>"  |  "<dir>/index.md" → directory index (subdirs + files + summaries)
 *   "<path>.md"                  → the doc content for source file <path>
 *
 * `index.md` at any level is always the DIRECTORY index; a real file's doc is
 * "<basename-with-extension>.md" (e.g. `diff.ts.md`), so there is no collision.
 */

import { listDocMeta, listDocsByIds, getDocLatest, type QueryFn } from "./read.js";
import { buildDocsIndex, dirOf, firstDocLine, type DocMeta } from "./index-render.js";

export type DocsVfsResult =
  | { kind: "ok"; body: string }
  | { kind: "not-found"; message: string };

/** Resolve a `<memory>/docs/` subpath to rendered text from the docs table. */
export async function handleDocsVfs(
  subpath: string,
  query: QueryFn,
  tableName: string,
): Promise<DocsVfsResult> {
  const path = subpath.replace(/^\/+/, "").replace(/\/+$/, "");

  // Decide whether this is a directory index or a leaf doc.
  let dir: string | null = null;
  if (path === "" || path === "index.md") dir = "";
  else if (path.endsWith("/index.md")) dir = path.slice(0, -"/index.md".length);
  else if (!path.endsWith(".md")) dir = path; // a bare directory (e.g. `cat .../docs/src/graph`)

  if (dir !== null) {
    const meta: DocMeta[] = (await listDocMeta(query, tableName, { dirPrefix: dir })).map((r) => ({
      doc_id: r.doc_id,
      version: r.version,
      updated_at: r.updated_at,
      status: r.status,
      tier: r.tier,
    }));
    const directFiles = meta
      .filter((m) => m.status === "active" && dirOf(m.doc_id) === dir)
      .map((m) => m.doc_id);
    const summaries = new Map<string, string>();
    if (directFiles.length > 0) {
      for (const d of await listDocsByIds(query, tableName, directFiles)) {
        summaries.set(d.doc_id, firstDocLine(d.content));
      }
    }
    return { kind: "ok", body: buildDocsIndex(meta, dir, summaries) };
  }

  // Leaf: "<source-file>.md" → doc for that file.
  const docId = path.slice(0, -".md".length);
  const row = await getDocLatest(query, tableName, docId);
  if (!row) return { kind: "not-found", message: `${subpath}: No such file or directory` };
  const header =
    `# ${row.doc_id}\n` +
    `version: ${row.version}  tier: ${row.tier}  status: ${row.status}  updated: ${row.updated_at}\n` +
    `---\n`;
  return { kind: "ok", body: header + row.content };
}
