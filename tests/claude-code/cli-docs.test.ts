import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * CLI handler tests for `hivemind docs`. The handler is thin (argparse +
 * dispatch into the real src/docs store), so we mock the network boundary
 * (`DeeplakeApi`), config, version, and the two heavy collaborators the
 * refresh path would otherwise reach (the graph snapshot loader and the host
 * LLM). The store functions run for real against the query spy.
 */

// Stub the read-stability gate to a single pass-through query (see docs.test.ts).
vi.mock("../../src/docs/stable-read.js", () => ({
  stableUnionRows: (q: (sql: string) => unknown, sql: string) => q(sql),
}));

const ensureDocsTableMock = vi.fn();
const queryMock = vi.fn();
const loadCurrentSnapshotMock = vi.fn();

vi.mock("../../src/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    constructor() { /* nothing */ }
    ensureDocsTable(name: string) { return ensureDocsTableMock(name); }
    query(sql: string) { return queryMock(sql); }
  },
}));
vi.mock("../../src/cli/version.js", () => ({ getVersion: () => "0.7.99" }));
vi.mock("../../src/graph/load-current.js", () => ({
  loadCurrentSnapshot: (...a: unknown[]) => loadCurrentSnapshotMock(...a),
}));
vi.mock("../../src/docs/refresh-llm.js", () => ({
  makeHostGenerate: () => async () => "stub",
  makeHostGenerateDoc: () => async () => "stub",
  makeHostBatchGenerateDoc: () => async () => new Map<string, string>(),
}));
// Hermetic: no embed daemon round-trips in unit tests.
vi.mock("../../src/docs/embed.js", () => ({
  makeDocEmbedder: () => async () => null,
  makeQueryEmbedder: () => async () => null,
}));

import { runDocsCommand } from "../../src/commands/docs.js";
import { loadConfig } from "../../src/config.js";
const loadConfigMock = loadConfig as unknown as ReturnType<typeof vi.fn>;

const VALID_CONFIG = {
  token: "tok", orgId: "org", orgName: "OrgName", userName: "alice@activeloop.ai",
  workspaceId: "ws", apiUrl: "https://api", tableName: "memory",
  sessionsTableName: "sessions", skillsTableName: "skills", rulesTableName: "hivemind_rules",
  goalsTableName: "g", kpisTableName: "k", docsTableName: "hivemind_docs",
  codebaseTableName: "codebase", memoryPath: "/tmp/mem",
};

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: "row", doc_id: "a.ts", path: "/docs/p/a.ts.md", content: "body",
    anchors: "[]", tier: "fast", status: "active",
    // Legacy unstamped row: visible under projectOrLegacy scoping from any repo.
    project: "", version: 1,
    created_at: "t", updated_at: "t", agent: "m", plugin_version: "0", ...over,
  };
}

let logged: string[] = [];
let erred: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

async function run(args: string[]): Promise<number | null> {
  try {
    await runDocsCommand(args);
    return null;
  } catch (e) {
    const m = /__EXIT_(\d+)__/.exec((e as Error).message);
    if (m) return Number(m[1]);
    throw e;
  }
}

beforeEach(() => {
  logged = []; erred = [];
  ensureDocsTableMock.mockReset().mockResolvedValue(undefined);
  queryMock.mockReset().mockResolvedValue([]);
  loadCurrentSnapshotMock.mockReset().mockReturnValue({ nodes: [], links: [] });
  loadConfigMock.mockReset().mockReturnValue(VALID_CONFIG);
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: any[]) => { logged.push(a.join(" ")); });
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: any[]) => { erred.push(a.join(" ")); });
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code ?? 0}__`);
  }) as any);
});
afterEach(() => {
  logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore();
});

describe("hivemind docs — dispatch & usage", () => {
  it("prints usage with no subcommand", async () => {
    await run([]);
    expect(logged.join("\n")).toMatch(/hivemind docs/);
  });
  it("exits 2 when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);
    expect(await run(["list"])).toBe(2);
    expect(erred.join()).toMatch(/Not logged in/);
  });
  it("errors on an unknown subcommand", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(erred.join()).toMatch(/Unknown subcommand/);
  });
});

describe("hivemind docs set", () => {
  it("requires a doc-id", async () => {
    expect(await run(["set"])).toBe(1);
    expect(erred.join()).toMatch(/Missing doc-id/);
  });
  it("creates v1 via the real store (SELECT then INSERT)", async () => {
    await run(["set", "a.ts", "the body", "--project", "p"]);
    expect(ensureDocsTableMock).toHaveBeenCalledWith("hivemind_docs");
    const sqls = queryMock.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /^SELECT/.test(s))).toBe(true);
    expect(sqls.some((s) => /^INSERT INTO "hivemind_docs"/.test(s))).toBe(true);
    expect(logged.join()).toMatch(/Set doc a\.ts → v1/);
  });
  it("rejects --anchor when the symbol is not in the graph", async () => {
    expect(await run(["set", "a.ts", "body", "--anchor", "a.ts:missing:function"])).toBe(1);
    expect(erred.join()).toMatch(/symbol not in graph/);
  });
});

describe("hivemind docs show", () => {
  it("prints (no doc) when nothing matches", async () => {
    await run(["show", "a.ts"]);
    expect(logged.join()).toMatch(/\(no doc for a\.ts\)/);
  });
  it("prints metadata and body when found", async () => {
    queryMock.mockResolvedValueOnce([docRow({ version: 3, content: "hello world" })]);
    await run(["show", "a.ts"]);
    expect(logged.join("\n")).toMatch(/version: 3/);
    expect(logged.join("\n")).toMatch(/hello world/);
  });
  it("requires a doc-id", async () => {
    expect(await run(["show"])).toBe(1);
  });
});

describe("hivemind docs list", () => {
  it("reports empty", async () => {
    await run(["list"]);
    expect(logged.join()).toMatch(/no docs with status=active/);
  });
  it("lists rows (after the status-header meta read)", async () => {
    // The status header reads the _meta row FIRST; script that read as empty,
    // then the page rows for the actual listing.
    queryMock.mockResolvedValueOnce([]); // header: readRefreshMeta
    queryMock.mockResolvedValueOnce([docRow({ doc_id: "x.ts", version: 2 })]);
    await run(["list", "--status", "all"]);
    const out = logged.join("\n");
    expect(out).toMatch(/x\.ts/);
    expect(out).toMatch(/repo: .*  org: /); // header present
  });
  it("rejects a bad --status", async () => {
    expect(await run(["list", "--status", "bogus"])).toBe(1);
  });
  it("default view hides other repos' pages; --all shows the whole table", async () => {
    // Shared org table: another repo's page must NOT appear under this
    // repo's header by default (caught live during manual e2e).
    const foreign = docRow({ doc_id: "wiki/other", project: "other-project" });
    queryMock.mockResolvedValueOnce([]); // header meta read
    queryMock.mockResolvedValueOnce([foreign, docRow({ doc_id: "mine.ts" })]);
    await run(["list", "--status", "all"]);
    let out = logged.join("\n");
    expect(out).toMatch(/mine\.ts/); // legacy '' row: always visible
    expect(out).not.toMatch(/wiki\/other/);
    logged.length = 0;
    queryMock.mockResolvedValueOnce([]); // header meta read
    queryMock.mockResolvedValueOnce([foreign, docRow({ doc_id: "mine.ts" })]);
    await run(["list", "--status", "all", "--all"]);
    out = logged.join("\n");
    expect(out).toMatch(/wiki\/other/); // global view opts back in
    // ...grouped by repo, one titled section per project — a human must
    // never have to decode project hashes to tell repos apart.
    expect(out).toMatch(/project other-project\s+—\s+1 page\(s\)/);
    expect(out).toMatch(/legacy rows — no project stamp/); // the '' row's section
  });
  it("shows wiki generation progress: done count + pending page names", async () => {
    // A real dir with 3 sizeable files -> one eligible group ("pkg").
    const dir = mkdtempSync(join(tmpdir(), "cli-list-prog-"));
    mkdirSync(join(dir, "pkg"));
    for (const f of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(dir, "pkg", f), "export const x = 1;\n".repeat(200));
    loadCurrentSnapshotMock.mockReturnValue({
      nodes: ["a", "b", "c"].map((n) => ({
        id: `pkg/${n}.ts:${n}:function`, label: n, kind: "function",
        source_file: `pkg/${n}.ts`, source_location: "L1-L2", language: "typescript", exported: true,
      })),
      links: [],
    });
    try {
      // No wiki page in the table yet -> 0/1 with the pending name.
      queryMock.mockResolvedValueOnce([]); // header meta read
      queryMock.mockResolvedValueOnce([]); // rows
      await run(["list", "--cwd", dir]);
      let out = logged.join("\n");
      expect(out).toMatch(/wiki: 0\/1 pages generated — pending: wiki\/pkg/);
      logged.length = 0;
      // Page landed -> complete.
      queryMock.mockResolvedValueOnce([]); // header meta read
      queryMock.mockResolvedValueOnce([docRow({ doc_id: "wiki/pkg" })]);
      await run(["list", "--cwd", dir]);
      out = logged.join("\n");
      expect(out).toMatch(/wiki: 1\/1 pages generated/);
      expect(out).not.toMatch(/pending/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("--all caps each repo section and points at --project for the rest", async () => {
    const many = Array.from({ length: 25 }, (_, i) => docRow({ doc_id: `wiki/p${i}`, project: "big-project" }));
    queryMock.mockResolvedValueOnce([]); // header meta read
    queryMock.mockResolvedValueOnce(many);
    await run(["list", "--status", "all", "--all"]);
    const out = logged.join("\n");
    expect(out).toMatch(/big-project\s+—\s+25 page\(s\)/);
    expect(out).toMatch(/\(\+5 more — hivemind docs list --project /);
    expect((out.match(/\[active\]/g) ?? []).length).toBe(20); // cap enforced
  });
});

describe("hivemind docs archive", () => {
  it("requires a doc-id", async () => {
    expect(await run(["archive"])).toBe(1);
  });
  it("archives an existing doc (version bump)", async () => {
    queryMock.mockResolvedValueOnce([docRow({ version: 2 })]); // getDocLatest
    await run(["archive", "a.ts"]);
    const sqls = queryMock.mock.calls.map((c) => c[0] as string);
    // UPDATE-in-place (F1): archive flips status on the existing row, not a new INSERT.
    expect(sqls.some((s) => /UPDATE "hivemind_docs" SET/.test(s) && /status = 'archived'/.test(s))).toBe(true);
    expect(logged.join()).toMatch(/Archived doc a\.ts → v3/);
  });
});

describe("hivemind docs refresh", () => {
  it("errors when no local graph exists", async () => {
    loadCurrentSnapshotMock.mockReturnValue(null);
    expect(await run(["refresh"])).toBe(1);
    expect(erred.join()).toMatch(/No local graph/);
  });
  it("reports when nothing needs refreshing", async () => {
    // empty graph + no docs → no impact, no LLM call
    await run(["refresh", "--dry-run"]);
    expect(logged.join()).toMatch(/no docs need refreshing/);
  });
});

describe("hivemind docs — anchored authoring + refresh over real files", () => {
  let dir: string;
  const fooNode = {
    id: "f.ts:foo:function", label: "foo", kind: "function",
    source_file: "f.ts", source_location: "L1-L3", language: "typescript",
    exported: true, signature: "function foo(): number",
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-docs-"));
    writeFileSync(join(dir, "f.ts"), "export function foo() {\n  return 1;\n}\n");
    loadCurrentSnapshotMock.mockReturnValue({ nodes: [fooNode], links: [] });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("set --anchor builds an anchor from the graph and stores it", async () => {
    await run(["set", "f.ts", "doc body", "--anchor", "f.ts:foo:function", "--cwd", dir, "--project", "p"]);
    const insert = queryMock.mock.calls.map((c) => c[0] as string).find((s) => /INSERT INTO "hivemind_docs"/.test(s))!;
    expect(insert).toBeDefined();
    // the anchors column carries the symbol id (not the empty [] default)
    expect(insert).toContain("f.ts:foo:function");
    expect(insert).toContain("content_hash");
    expect(logged.join()).toMatch(/Set doc f\.ts → v1/);
  });

  it("refresh regenerates an impacted doc through the stub generator + gate", async () => {
    // doc anchored to foo with a STALE hash → drift detected → refreshed.
    const stale = JSON.stringify([{ symbol_id: "f.ts:foo:function", content_hash: "stale000" }]);
    queryMock.mockResolvedValue([docRow({ doc_id: "f.ts", content: "old body", anchors: stale })]);
    await run(["refresh", "--cwd", dir]);
    expect(logged.join("\n")).toMatch(/Refreshed 1/);
    // UPDATE-in-place (F1): the existing doc row is rewritten, not re-INSERTed.
    const update = queryMock.mock.calls.map((c) => c[0] as string).find((s) => /UPDATE "hivemind_docs" SET/.test(s));
    expect(update).toBeDefined();
    expect(update!).toContain("stub"); // the generated body landed
  });

  it("refresh prints a rejection outcome when the gate rejects (slow tier)", async () => {
    const stale = JSON.stringify([{ symbol_id: "f.ts:foo:function", content_hash: "stale000" }]);
    queryMock.mockResolvedValue([docRow({ doc_id: "f.ts", content: "old body", anchors: stale, tier: "slow" })]);
    await run(["refresh", "--cwd", dir]);
    expect(logged.join("\n")).toMatch(/rejected f\.ts:.*slow-tier/);
    // no write happened — slow docs are not auto-refreshed. The refresh path
    // writes via UPDATE-in-place, so asserting only "no INSERT" would pass
    // even if the gate leaked a write; check both statement kinds.
    const writes = queryMock.mock.calls.map((c) => c[0] as string).filter((s) => /INSERT|UPDATE/.test(s));
    expect(writes).toHaveLength(0);
  });
});
