import { describe, expect, it, vi } from "vitest";

// Pass-through the read-stability gate so SQL shapes stay exact (see docs.test.ts).
vi.mock("../../src/docs/stable-read.js", () => ({
  stableUnionRows: (q: (sql: string) => unknown, sql: string) => q(sql),
}));

import { handleDocsVfs } from "../../src/docs/vfs-handler.js";

const TBL = "hivemind_docs";

function metaRow(doc_id: string, over: Record<string, unknown> = {}) {
  return { id: `id-${doc_id}`, doc_id, version: 1, updated_at: "2026-07-01T10:00:00.000Z", status: "active", tier: "fast", ...over };
}
function fullRow(doc_id: string, content: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${doc_id}`, doc_id, path: `/docs/p/${doc_id}.md`, content,
    anchors: "[]", tier: "fast", status: "active", project: "p", version: 1,
    created_at: "2026-07-01T10:00:00.000Z", updated_at: "2026-07-01T10:00:00.000Z",
    agent: "m", plugin_version: "0", ...over,
  };
}

/** Route the query by SQL shape so one fake stands in for all three reads. */
function router(meta: Record<string, unknown>[], byIds: Record<string, unknown>[], latest: Record<string, unknown>[]) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (/SELECT id, doc_id, version/.test(sql)) return meta;
    if (/doc_id IN \(/.test(sql)) return byIds;
    if (/WHERE doc_id = /.test(sql)) return latest;
    return [];
  });
  return { calls, query };
}

describe("handleDocsVfs", () => {
  const corpus = [metaRow("src/graph/diff.ts"), metaRow("src/graph/cache.ts"), metaRow("src/docs/read.ts")];

  it("renders the root index (top directories) for '' and 'index.md'", async () => {
    for (const sub of ["", "index.md"]) {
      const { query } = router(corpus, [], []);
      const r = await handleDocsVfs(sub, query, TBL);
      expect(r.kind).toBe("ok");
      expect(r.kind === "ok" && r.body).toContain("# Docs Index");
      expect(r.kind === "ok" && r.body).toContain("[src/](src/index.md)");
    }
  });

  it("renders a directory index scoped by prefix, with summaries for direct files", async () => {
    const dirMeta = [metaRow("src/graph/diff.ts"), metaRow("src/graph/extract/python.ts")];
    const { calls, query } = router(dirMeta, [fullRow("src/graph/diff.ts", "# diff\n\nCompares snapshots.")], []);
    const r = await handleDocsVfs("src/graph/index.md", query, TBL);
    expect(r.kind).toBe("ok");
    // Metadata read is directory-scoped.
    expect(calls.some((c) => c.includes("doc_id LIKE 'src/graph/%'"))).toBe(true);
    if (r.kind === "ok") {
      expect(r.body).toContain("# Docs: src/graph/");
      expect(r.body).toContain("[extract/](extract/index.md)"); // subdir
      expect(r.body).toContain("Compares snapshots."); // summary of the direct file
    }
  });

  it("returns the doc content for a leaf '<file>.md'", async () => {
    const { calls, query } = router([], [], [fullRow("src/graph/diff.ts", "# diff\n\nThe diff doc body.")]);
    const r = await handleDocsVfs("src/graph/diff.ts.md", query, TBL);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.body).toContain("# src/graph/diff.ts");
      expect(r.body).toContain("The diff doc body.");
    }
    // It resolved by exact doc_id, stripping the .md suffix.
    expect(calls.some((c) => c.includes("WHERE doc_id = 'src/graph/diff.ts'"))).toBe(true);
  });

  it("returns not-found for a leaf whose doc does not exist", async () => {
    const { query } = router([], [], []);
    const r = await handleDocsVfs("src/graph/nope.ts.md", query, TBL);
    expect(r.kind).toBe("not-found");
    expect(r.kind === "not-found" && r.message).toContain("No such file");
  });
});
