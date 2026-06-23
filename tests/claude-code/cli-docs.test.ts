import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * CLI handler tests for `hivemind docs`. The handler is thin (argparse +
 * dispatch into the real src/docs store), so we mock the network boundary
 * (`DeeplakeApi`), config, version, and the two heavy collaborators the
 * refresh path would otherwise reach (the graph snapshot loader and the host
 * LLM). The store functions run for real against the query spy.
 */

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
  makeClaudeGenerate: () => async () => "stub",
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
    anchors: "[]", tier: "fast", status: "active", project: "p", version: 1,
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
  it("lists rows", async () => {
    queryMock.mockResolvedValueOnce([docRow({ doc_id: "x.ts", version: 2 })]);
    await run(["list", "--status", "all"]);
    expect(logged.join("\n")).toMatch(/x\.ts/);
  });
  it("rejects a bad --status", async () => {
    expect(await run(["list", "--status", "bogus"])).toBe(1);
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
    expect(sqls.some((s) => /INSERT INTO "hivemind_docs"/.test(s) && /archived/.test(s))).toBe(true);
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
    const insert = queryMock.mock.calls.map((c) => c[0] as string).find((s) => /INSERT INTO "hivemind_docs"/.test(s));
    expect(insert).toBeDefined();
    expect(insert!).toContain("stub"); // the generated body landed
  });

  it("refresh prints a rejection outcome when the gate rejects (slow tier)", async () => {
    const stale = JSON.stringify([{ symbol_id: "f.ts:foo:function", content_hash: "stale000" }]);
    queryMock.mockResolvedValue([docRow({ doc_id: "f.ts", content: "old body", anchors: stale, tier: "slow" })]);
    await run(["refresh", "--cwd", dir]);
    expect(logged.join("\n")).toMatch(/rejected f\.ts:.*slow-tier/);
    // no write happened — slow docs are not auto-refreshed
    const inserts = queryMock.mock.calls.map((c) => c[0] as string).filter((s) => /INSERT/.test(s));
    expect(inserts).toHaveLength(0);
  });
});
