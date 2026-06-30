import { describe, expect, it, beforeEach, vi } from "vitest";

// The read-stability gate (stableUnionRows) re-reads with delays in production
// to defeat the Deeplake partial-read bug. In these unit tests we stub it to a
// single pass-through query so call-count / SQL-shape assertions stay exact and
// fast. The gate's own behavior is covered in docs-stable-read.test.ts.
vi.mock("../../src/docs/stable-read.js", () => ({
  stableUnionRows: (q: (sql: string) => unknown, sql: string) => q(sql),
}));
import {
  insertDoc,
  editDoc,
  setDoc,
  archiveDoc,
  listDocs,
  getDocLatest,
  parseAnchors,
  _MAX_CONTENT_LENGTH,
  type DocRow,
} from "../../src/docs/index.js";

/**
 * Mock query helper. Each script step receives the SQL and returns rows
 * (or throws). The harness captures every SQL string for shape + count
 * assertions — see CLAUDE.md "mock the network boundary, not the module
 * under test" for the rationale.
 */
function mockQuery(script: Array<(sql: string) => unknown>) {
  const calls: string[] = [];
  let step = 0;
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (step < script.length) {
      const out = script[step++](sql);
      return Array.isArray(out) ? (out as Array<Record<string, unknown>>) : [];
    }
    return [];
  });
  return { calls, query };
}

const TBL = "hivemind_docs";

/**
 * Build a fake row matching DOCS_COLUMNS shape as the Deeplake client
 * returns it — note `anchors` arrives as a JSON STRING (TEXT column).
 */
function fakeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "row-uuid",
    doc_id: "src/shell/deeplake-fs.ts",
    path: "/docs/myproj/deeplake-fs.ts.md",
    content: "# deeplake-fs\n\nThe VFS.",
    anchors: JSON.stringify([{ symbol_id: "src/shell/deeplake-fs.ts:readFile:function", content_hash: "abc123" }]),
    tier: "fast",
    status: "active",
    project: "myproj",
    version: 1,
    created_at: "2026-05-20T10:00:00.000Z",
    updated_at: "2026-05-20T10:00:00.000Z",
    agent: "manual",
    plugin_version: "0.7.105",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

// ── insertDoc ─────────────────────────────────────────────────────────────────

describe("insertDoc", () => {
  it("INSERTs a v1 row, both timestamps equal, content + anchors as E-strings", async () => {
    const { calls, query } = mockQuery([() => []]);
    const result = await insertDoc(query, TBL, {
      doc_id: "src/shell/deeplake-fs.ts",
      path: "/docs/myproj/deeplake-fs.ts.md",
      content: "# deeplake-fs",
      anchors: [{ symbol_id: "src/shell/deeplake-fs.ts:readFile:function", content_hash: "abc123" }],
      project: "myproj",
    });
    expect(result).toEqual({ doc_id: "src/shell/deeplake-fs.ts", version: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^INSERT INTO "hivemind_docs"/);
    // version literal is 1, never quoted
    expect(calls[0]).toMatch(/, 1, /);
    expect(calls[0]).toContain("'active'");
    expect(calls[0]).toContain("'myproj'");
    // content + anchors use E-string literals so backslashes / quotes stay safe
    expect(calls[0]).toContain(`E'# deeplake-fs'`);
    expect(calls[0]).toContain(`E'[{"symbol_id":"src/shell/deeplake-fs.ts:readFile:function","content_hash":"abc123"}]'`);
    // tier defaults to fast on first insert
    expect(calls[0]).toContain("'fast'");
    // created_at and updated_at are stamped identically at insert time
    const stamps = calls[0].match(/'(\d{4}-\d{2}-\d{2}T[\d:.]+Z)'/g);
    expect(stamps).not.toBeNull();
    expect(stamps!.length).toBeGreaterThanOrEqual(2);
    expect(stamps![0]).toBe(stamps![1]);
  });

  it("PRESERVES newlines in markdown content (docs are multi-line, unlike rules)", async () => {
    const { calls, query } = mockQuery([() => []]);
    await insertDoc(query, TBL, {
      doc_id: "a.ts",
      path: "/docs/p/a.ts.md",
      content: "# Title\n\n- bullet one\n- bullet two",
    });
    // Newlines survive into the E-string body — no rejection, no mangling.
    expect(calls[0]).toContain("# Title\n\n- bullet one\n- bullet two");
  });

  it("escapes SQL-special characters in content and anchors", async () => {
    const { calls, query } = mockQuery([() => []]);
    await insertDoc(query, TBL, {
      doc_id: "a.ts",
      path: "/docs/p/a.ts.md",
      content: "don't `rm -rf /` \\ ever",
    });
    expect(calls[0]).toContain(`E'don''t \`rm -rf /\` \\\\ ever'`);
  });

  it("defaults anchors to [] and tier to fast when omitted", async () => {
    const { calls, query } = mockQuery([() => []]);
    await insertDoc(query, TBL, { doc_id: "a.ts", path: "/docs/p/a.ts.md", content: "x" });
    expect(calls[0]).toContain(`E'[]'`);
    expect(calls[0]).toContain("'fast'");
    expect(calls[0]).toContain("'manual'");
  });

  it("writes the slow tier when requested", async () => {
    const { calls, query } = mockQuery([() => []]);
    await insertDoc(query, TBL, { doc_id: "_project", path: "/docs/p/_project.md", content: "x", tier: "slow" });
    expect(calls[0]).toContain("'slow'");
  });

  it("rejects empty content", async () => {
    const { calls, query } = mockQuery([() => []]);
    await expect(
      insertDoc(query, TBL, { doc_id: "a.ts", path: "/docs/p/a.ts.md", content: "" }),
    ).rejects.toThrow(/must not be empty/);
    expect(calls).toHaveLength(0);
  });

  it("rejects empty doc_id", async () => {
    const { calls, query } = mockQuery([() => []]);
    await expect(
      insertDoc(query, TBL, { doc_id: "", path: "/docs/p/a.ts.md", content: "x" }),
    ).rejects.toThrow(/doc_id must not be empty/);
    expect(calls).toHaveLength(0);
  });

  it(`rejects content longer than ${_MAX_CONTENT_LENGTH} chars`, async () => {
    const { calls, query } = mockQuery([() => []]);
    const oversized = "x".repeat(_MAX_CONTENT_LENGTH + 1);
    await expect(
      insertDoc(query, TBL, { doc_id: "a.ts", path: "/docs/p/a.ts.md", content: oversized }),
    ).rejects.toThrow(/exceeds 50000 chars/);
    expect(calls).toHaveLength(0);
  });

  it("rejects SQL-identifier injection in the table name", async () => {
    const { query } = mockQuery([() => []]);
    await expect(
      insertDoc(query, `x"; DROP TABLE y; --`, { doc_id: "a.ts", path: "/p", content: "x" }),
    ).rejects.toThrow();
  });
});

// ── editDoc ───────────────────────────────────────────────────────────────────

describe("editDoc", () => {
  it("reads latest, then INSERTs version+1 carrying the IMMUTABLE created_at while updated_at advances", async () => {
    const { calls, query } = mockQuery([
      () => [fakeRow({ version: 1, content: "old", created_at: "2026-05-20T10:00:00.000Z" })],
      () => [],
    ]);
    const result = await editDoc(query, TBL, { doc_id: "src/shell/deeplake-fs.ts", content: "new" });
    expect(result).toEqual({ doc_id: "src/shell/deeplake-fs.ts", version: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^SELECT .* FROM "hivemind_docs" WHERE doc_id = 'src\/shell\/deeplake-fs.ts'$/);
    expect(calls[1]).toMatch(/^INSERT INTO "hivemind_docs"/);
    expect(calls[1]).toContain(`E'new'`);
    expect(calls[1]).toContain(", 2, ");
    // The original creation stamp is carried forward verbatim...
    expect(calls[1]).toContain("'2026-05-20T10:00:00.000Z'");
    // ...and updated_at is a DIFFERENT, newer timestamp (now).
    const stamps = calls[1].match(/'(\d{4}-\d{2}-\d{2}T[\d:.]+Z)'/g)!;
    expect(stamps[0]).toBe("'2026-05-20T10:00:00.000Z'"); // created_at
    expect(stamps[1]).not.toBe("'2026-05-20T10:00:00.000Z'"); // updated_at = now
  });

  it("carries over previous content + anchors when only status changes", async () => {
    const { calls, query } = mockQuery([
      () => [fakeRow({ version: 3, content: "preserve me" })],
      () => [],
    ]);
    const result = await editDoc(query, TBL, { doc_id: "src/shell/deeplake-fs.ts", status: "archived" });
    expect(result.version).toBe(4);
    expect(calls[1]).toContain(`E'preserve me'`);
    expect(calls[1]).toContain("'archived'");
    // prior anchors round-trip through serialize unchanged
    expect(calls[1]).toContain(`content_hash":"abc123`);
  });

  it("replaces anchors when new ones are supplied", async () => {
    const { calls, query } = mockQuery([
      () => [fakeRow({ version: 1 })],
      () => [],
    ]);
    await editDoc(query, TBL, {
      doc_id: "src/shell/deeplake-fs.ts",
      content: "refreshed",
      anchors: [{ symbol_id: "src/shell/deeplake-fs.ts:writeFile:function", content_hash: "def456" }],
    });
    expect(calls[1]).toContain("def456");
    expect(calls[1]).not.toContain("abc123");
  });

  it("throws when doc_id does not exist (SELECT only, no wasted INSERT)", async () => {
    const { calls, query } = mockQuery([() => []]);
    await expect(
      editDoc(query, TBL, { doc_id: "missing.ts", content: "x" }),
    ).rejects.toThrow(/Doc not found: missing.ts/);
    expect(calls).toHaveLength(1);
  });

  it("rejects empty content on edit, leaving the SELECT-but-no-INSERT trail", async () => {
    const { calls, query } = mockQuery([
      () => [fakeRow({ version: 1 })],
      () => [],
    ]);
    await expect(
      editDoc(query, TBL, { doc_id: "src/shell/deeplake-fs.ts", content: "" }),
    ).rejects.toThrow(/must not be empty/);
    expect(calls).toHaveLength(1); // SELECT only
  });
});

// ── setDoc (idempotent upsert — the fork-history fix) ─────────────────────────

describe("setDoc", () => {
  it("INSERTs v1 when the doc_id does not exist yet", async () => {
    const { calls, query } = mockQuery([
      () => [], // getDocLatest → none
      () => [], // INSERT
    ]);
    const result = await setDoc(query, TBL, {
      doc_id: "src/a.ts",
      path: "/docs/p/a.ts.md",
      content: "first",
      project: "p",
    });
    expect(result).toEqual({ doc_id: "src/a.ts", version: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^SELECT .* WHERE doc_id = 'src\/a.ts'/);
    expect(calls[1]).toMatch(/^INSERT INTO "hivemind_docs"/);
    expect(calls[1]).toMatch(/, 1, /);
  });

  it("propagates a new project on a version bump (not frozen at the old value)", async () => {
    const { calls, query } = mockQuery([
      () => [fakeRow({ doc_id: "src/a.ts", version: 1, project: "old-proj" })],
      () => [],
    ]);
    await setDoc(query, TBL, {
      doc_id: "src/a.ts",
      path: "/docs/p/a.ts.md",
      content: "updated",
      project: "new-proj",
    });
    expect(calls[1]).toContain("'new-proj'");
    expect(calls[1]).not.toContain("'old-proj'");
  });

  it("APPENDS version+1 when the doc_id already exists — never forks a second v1", async () => {
    const { calls, query } = mockQuery([
      () => [fakeRow({ doc_id: "src/a.ts", version: 4, created_at: "2026-01-01T00:00:00.000Z" })],
      () => [],
    ]);
    const result = await setDoc(query, TBL, {
      doc_id: "src/a.ts",
      path: "/docs/p/a.ts.md",
      content: "updated",
      project: "p",
    });
    expect(result).toEqual({ doc_id: "src/a.ts", version: 5 });
    expect(calls).toHaveLength(2);
    // The INSERT is version 5, NOT a second version 1 — the fork-history bug
    // Codex flagged is impossible through setDoc.
    expect(calls[1]).toContain(", 5, ");
    expect(calls[1]).not.toMatch(/, 1, /);
    // immutable created_at carried from the existing chain
    expect(calls[1]).toContain("'2026-01-01T00:00:00.000Z'");
    expect(calls[1]).toContain(`E'updated'`);
  });
});

// ── archiveDoc (soft delete primitive) ────────────────────────────────────────

describe("archiveDoc", () => {
  it("appends a version with status='archived', preserving content", async () => {
    const { calls, query } = mockQuery([
      () => [fakeRow({ doc_id: "src/gone.ts", version: 2, content: "keep me" })],
      () => [],
    ]);
    const result = await archiveDoc(query, TBL, { doc_id: "src/gone.ts" });
    expect(result.version).toBe(3);
    expect(calls[1]).toContain("'archived'");
    expect(calls[1]).toContain(`E'keep me'`);
  });

  it("throws when archiving a doc that does not exist", async () => {
    const { calls, query } = mockQuery([() => []]);
    await expect(archiveDoc(query, TBL, { doc_id: "nope.ts" })).rejects.toThrow(/Doc not found/);
    expect(calls).toHaveLength(1);
  });
});

// ── listDocs ──────────────────────────────────────────────────────────────────

describe("listDocs", () => {
  it("returns latest version per doc_id, active only, newest-first by updated_at, default limit 200", async () => {
    const { calls, query } = mockQuery([
      () => [
        fakeRow({ id: "a2", doc_id: "A", version: 2, content: "A v2", updated_at: "2026-05-20T10:02:00Z" }),
        fakeRow({ id: "a1", doc_id: "A", version: 1, content: "A v1", updated_at: "2026-05-20T10:01:00Z" }),
        fakeRow({ id: "b1", doc_id: "B", version: 1, content: "B v1", updated_at: "2026-05-20T10:00:00Z" }),
        fakeRow({ id: "c1", doc_id: "C", version: 1, status: "archived", content: "C arch", updated_at: "2026-05-20T09:59:00Z" }),
      ],
      () => [],
    ]);
    const rows = await listDocs(query, TBL);
    expect(rows.map(r => r.doc_id)).toEqual(["A", "B"]);
    expect(rows[0].content).toBe("A v2");
    expect(rows[0].version).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^SELECT .* FROM "hivemind_docs" ORDER BY version DESC, updated_at DESC, id DESC$/);
  });

  it("honors status='all'", async () => {
    const { query } = mockQuery([
      () => [
        fakeRow({ doc_id: "A", version: 1, status: "active" }),
        fakeRow({ doc_id: "B", version: 1, status: "archived" }),
      ],
    ]);
    const rows = await listDocs(query, TBL, { status: "all" });
    expect(rows.map(r => r.doc_id).sort()).toEqual(["A", "B"]);
  });

  it("filters by project", async () => {
    const { query } = mockQuery([
      () => [
        fakeRow({ doc_id: "A", version: 1, project: "p1" }),
        fakeRow({ doc_id: "B", version: 1, project: "p2" }),
      ],
    ]);
    const rows = await listDocs(query, TBL, { project: "p2" });
    expect(rows.map(r => r.doc_id)).toEqual(["B"]);
  });

  it("respects the limit parameter", async () => {
    const { query } = mockQuery([
      () => Array.from({ length: 25 }, (_, i) =>
        fakeRow({
          doc_id: `doc-${i}`,
          version: 1,
          updated_at: `2026-05-20T10:${String(i).padStart(2, "0")}:00Z`,
        }),
      ),
    ]);
    const rows = await listDocs(query, TBL, { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0].doc_id).toBe("doc-24"); // newest by updated_at
  });

  it("drops malformed rows (NaN version) silently", async () => {
    const { query } = mockQuery([
      () => [
        fakeRow({ doc_id: "good", version: 1 }),
        { doc_id: "bad", version: "not-a-number" },
      ],
    ]);
    const rows = await listDocs(query, TBL);
    expect(rows.map(r => r.doc_id)).toEqual(["good"]);
  });

  it("parses the anchors JSON string back into typed objects", async () => {
    const { query } = mockQuery([() => [fakeRow({ doc_id: "A", version: 1 })]]);
    const rows = await listDocs(query, TBL);
    expect(rows[0].anchors).toEqual([
      { symbol_id: "src/shell/deeplake-fs.ts:readFile:function", content_hash: "abc123" },
    ]);
  });
});

// ── getDocLatest ──────────────────────────────────────────────────────────────

describe("getDocLatest", () => {
  it("returns the latest row, picking max version in JS, escaped doc_id", async () => {
    // Reads ALL version rows for the doc (no LIMIT 1 — unsafe on this backend)
    // and picks the max version in JS.
    const { calls, query } = mockQuery([
      () => [
        fakeRow({ id: "r1", doc_id: "X", version: 3, content: "old" }),
        fakeRow({ id: "r2", doc_id: "X", version: 5, content: "current" }),
      ],
    ]);
    const row = await getDocLatest(query, TBL, "X");
    expect(row?.version).toBe(5);
    expect(row?.content).toBe("current");
    expect(calls[0]).toContain(`doc_id = 'X'`);
    expect(calls[0]).not.toMatch(/LIMIT 1/);
  });

  it("returns null when nothing matches", async () => {
    const { query } = mockQuery([() => []]);
    expect(await getDocLatest(query, TBL, "missing")).toBeNull();
  });

  it("escapes the doc_id in the WHERE clause", async () => {
    const { calls, query } = mockQuery([() => []]);
    await getDocLatest(query, TBL, "x' OR '1'='1");
    expect(calls[0]).toContain(`doc_id = 'x'' OR ''1''=''1'`);
  });
});

// ── parseAnchors ──────────────────────────────────────────────────────────────

describe("parseAnchors", () => {
  it("parses a JSON string into typed anchors", () => {
    expect(parseAnchors('[{"symbol_id":"a:b:function","content_hash":"h"}]')).toEqual([
      { symbol_id: "a:b:function", content_hash: "h" },
    ]);
  });

  it("degrades to [] on empty / malformed / non-array input", () => {
    expect(parseAnchors("")).toEqual([]);
    expect(parseAnchors("not json")).toEqual([]);
    expect(parseAnchors('{"not":"array"}')).toEqual([]);
    expect(parseAnchors(null)).toEqual([]);
    expect(parseAnchors(undefined)).toEqual([]);
  });

  it("filters out items missing symbol_id or content_hash", () => {
    expect(
      parseAnchors('[{"symbol_id":"a:b:fn","content_hash":"h"},{"symbol_id":"x"},{"content_hash":"y"},42]'),
    ).toEqual([{ symbol_id: "a:b:fn", content_hash: "h" }]);
  });

  it("accepts an already-parsed array (defensive)", () => {
    expect(parseAnchors([{ symbol_id: "a:b:fn", content_hash: "h" }] as unknown)).toEqual([
      { symbol_id: "a:b:fn", content_hash: "h" },
    ]);
  });
});
