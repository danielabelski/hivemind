import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Stub the read-stability gate to a single pass-through query (see docs.test.ts).
vi.mock("../../src/docs/stable-read.js", () => ({
  stableUnionRows: (q: (sql: string) => unknown, sql: string) => q(sql),
}));

import { runWikiRefreshCycle, runLocalWikiRefresh, DEFAULT_MIN_PERIOD_MS, type WikiRefreshArgs } from "../../src/docs/wiki-refresh.js";
import { appendFilesIndex, collectWikiAnchors } from "../../src/docs/wiki-generate.js";
import { docRowId } from "../../src/docs/write.js";
import type { GitRunner } from "../../src/docs/candidates.js";
import type { GraphNode, GraphSnapshot } from "../../src/graph/types.js";

const P = "projkey";
const T = "hivemind_docs";
const HEAD = "headsha";
const PREV = "prevsha";
const NOW = () => new Date("2026-07-08T12:00:00.000Z");
const noSleep = () => Promise.resolve();

function node(id: string, file: string): GraphNode {
  return { id, label: id, kind: "function", source_file: file, source_location: "L1-L3", language: "typescript", exported: true };
}
function snap(nodes: GraphNode[]): GraphSnapshot {
  return { nodes, links: [] } as unknown as GraphSnapshot;
}

/**
 * Simulated backend: one `_meta` row + wiki page rows, driven by real SQL from
 * the modules under test. SELECTs are answered from state; DELETE/INSERT and
 * UPDATE mutate the meta row so lease semantics run for real.
 */
function makeBackend(opts: { meta?: Record<string, unknown> | null; metaUpdatedAt?: string; pages?: Array<Record<string, unknown>>; scope?: string }) {
  const state = {
    meta: opts.meta === undefined ? null : opts.meta,
    metaUpdatedAt: opts.metaUpdatedAt ?? "2026-07-08T00:00:00.000Z",
    pages: opts.pages ?? [],
  };
  const calls: string[] = [];
  const metaId = docRowId(P, opts.scope ?? "main", "_meta");
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    const s = sql.trim();
    if (/^SELECT/i.test(s)) {
      if (s.includes(`'${metaId}'`)) {
        return state.meta === null ? [] : [{ content: JSON.stringify(state.meta), updated_at: state.metaUpdatedAt }];
      }
      return state.pages; // listDocs / getDocLatest read
    }
    if (/^DELETE/i.test(s) && s.includes(`'${metaId}'`)) {
      // The healing sweep (`updated_at < ...`) removes only OLDER siblings —
      // in this single-row simulation that is a no-op, not a row wipe.
      if (!s.includes("updated_at <")) state.meta = null;
      return [];
    }
    if (/^INSERT/i.test(s) && s.includes(`'${metaId}'`)) {
      const m = /VALUES \('[^']*', '_meta', '', E'((?:[^']|'')*)'/.exec(s);
      if (m) {
        state.meta = JSON.parse(m[1].replace(/''/g, "'"));
        state.metaUpdatedAt = NOW().toISOString();
      }
      return [];
    }
    return [];
  });
  return { query, calls, state };
}

describe("runWikiRefreshCycle", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-wref-"));
    mkdirSync(join(dir, "pkg", "core"), { recursive: true });
    mkdirSync(join(dir, "pkg", "io"), { recursive: true });
    writeFileSync(join(dir, "pkg", "core", "a.ts"), "export function foo() {\n  return 1;\n}\n");
    writeFileSync(join(dir, "pkg", "io", "b.ts"), "export function bar() {\n  return 2;\n}\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SNAP = () => snap([node("pkg/core/a.ts:foo:function", "pkg/core/a.ts"), node("pkg/io/b.ts:bar:function", "pkg/io/b.ts")]);

  const gitOk =
    (changed: string[]): GitRunner =>
    (args) => {
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      if (args[0] === "diff" && args[1] === "--name-only") return changed.join("\n") + "\n";
      if (args[0] === "diff") return "- old\n+ new\n"; // per-group unified diff
      return null;
    };

  function pageRow(key: string, files: string[], narrative: string): Record<string, unknown> {
    const content = appendFilesIndex(narrative, files);
    const anchors = collectWikiAnchors(SNAP(), files, dir);
    return {
      id: `${P}|main|wiki/${key}`, doc_id: `wiki/${key}`, path: `/docs/${P}/wiki/${key}.md`,
      content, anchors: JSON.stringify(anchors), tier: "slow", status: "active",
      project: P, version: 1, created_at: "t0", updated_at: "t0", agent: "docs-wiki", plugin_version: "0",
    };
  }

  const baseArgs = (backend: ReturnType<typeof makeBackend>, git: GitRunner, extra: Partial<WikiRefreshArgs> = {}): WikiRefreshArgs => ({
    query: backend.query, tableName: T, snap: SNAP(), repoRoot: dir, project: P,
    run: async () => "NO_CHANGE", git, owner: "me", now: NOW, sleep: noSleep,
    regenerate: async () => "created",
    ...extra,
  });

  it("branch first cycle seeds the window from the merge-base with trunk (not full-candidate)", async () => {
    const backend = makeBackend({
      scope: "b:feat",
      meta: { last_refresh_sha: "", claimed_by: null, claimed_at: null, patch_counts: {} }, // fresh branch cursor
      pages: [
        pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\nfoo."),
        pageRow("pkg/io", ["pkg/io/b.ts"], "## Purpose\nbar."),
      ],
    });
    const MB = "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee";
    const gitCalls: string[] = [];
    const git: GitRunner = (args) => {
      gitCalls.push(args.join(" "));
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      if (args[0] === "symbolic-ref") return "origin/main\n";
      if (args[0] === "merge-base") return `${MB}\n`;
      if (args[0] === "diff" && args[1] === "--name-only") return "pkg/core/a.ts\n"; // only core changed vs MB
      if (args[0] === "diff") return "- old\n+ new\n";
      return null;
    };
    const report = await runWikiRefreshCycle(
      baseArgs(backend, git, { scope: "b:feat", force: true, run: async () => "## Purpose\nfoo v2." }),
    );
    // The window is seeded from the merge-base, not treated as full-candidate.
    expect(gitCalls).toContain("merge-base HEAD origin/main");
    expect(gitCalls).toContain(`diff --name-only ${MB}..HEAD`);
    // Only the branch-changed page is a candidate; the untouched page is skipped free.
    const acted = report.outcomes.map((o) => o.doc_id);
    expect(acted).toContain("wiki/pkg/core");
    expect(acted).not.toContain("wiki/pkg/io");
  });

  it("HEAD == last_refresh_sha → up-to-date, no lease taken, no LLM", async () => {
    const backend = makeBackend({ meta: { last_refresh_sha: HEAD, claimed_by: null, claimed_at: null, patch_counts: {} } });
    const run = vi.fn(async () => "NO_CHANGE");
    const report = await runWikiRefreshCycle(baseArgs(backend, gitOk([]), { run }));
    expect(report.status).toBe("up-to-date");
    expect(run).not.toHaveBeenCalled();
    expect(backend.calls.filter((c) => /^(INSERT|DELETE)/i.test(c.trim()))).toHaveLength(0);
  });

  it("quiet period: a recently-touched meta row defers the cycle (force overrides)", async () => {
    const recent = new Date(NOW().getTime() - DEFAULT_MIN_PERIOD_MS / 2).toISOString();
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} },
      metaUpdatedAt: recent,
      pages: [pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\nfresh")],
    });
    expect((await runWikiRefreshCycle(baseArgs(backend, gitOk([])))).status).toBe("too-soon");
    const forced = await runWikiRefreshCycle(baseArgs(backend, gitOk([]), { force: true }));
    expect(forced.status).not.toBe("too-soon");
  });

  it("claim race: the loser leaves without touching any page", async () => {
    const backend = makeBackend({ meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} } });
    // Sabotage the read-back: after our claim INSERT, a rival overwrites it.
    const origQuery = backend.query.getMockImplementation()!;
    let claimed = false;
    backend.query.mockImplementation(async (sql: string) => {
      const out = await origQuery(sql);
      if (/^INSERT/i.test(sql.trim()) && sql.includes("_meta") && !claimed) {
        claimed = true;
        backend.state.meta = { last_refresh_sha: PREV, claimed_by: "rival", claimed_at: NOW().toISOString(), patch_counts: {} };
      }
      return out;
    });
    const run = vi.fn(async () => "NO_CHANGE");
    const report = await runWikiRefreshCycle(baseArgs(backend, gitOk(["pkg/core/a.ts"]), { run }));
    expect(report.status).toBe("not-claimed");
    expect(run).not.toHaveBeenCalled();
  });

  it("EXPIRED claim is taken over (a crashed worker blocks nothing)", async () => {
    const backend = makeBackend({
      meta: { last_refresh_sha: HEAD, claimed_by: "dead", claimed_at: "2026-07-08T09:00:00.000Z", patch_counts: {} },
    });
    // sha == HEAD → up-to-date wins before the lease. Use PREV to reach claim:
    backend.state.meta = { last_refresh_sha: PREV, claimed_by: "dead", claimed_at: "2026-07-08T09:00:00.000Z", patch_counts: {} };
    const report = await runWikiRefreshCycle(baseArgs(backend, gitOk([])));
    expect(["committed", "incomplete"]).toContain(report.status); // got past the dead claim
  });

  it("O(diff): only the touched group is processed; the other page is never read by the LLM", async () => {
    const prompts: string[] = [];
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} },
      pages: [
        pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\ncore"),
        pageRow("pkg/io", ["pkg/io/b.ts"], "## Purpose\nio"),
      ],
    });
    const run = vi.fn(async (p: string) => { prompts.push(p); return "NO_CHANGE"; });
    const report = await runWikiRefreshCycle(baseArgs(backend, gitOk(["pkg/core/a.ts"]), { run }));
    expect(report.status).toBe("committed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain("`pkg/core`");
    // Untouched page produces NO outcome at all — skipped for free.
    expect(report.outcomes.find((o) => o.doc_id === "wiki/pkg/io")).toBeUndefined();
  });

  it("commit point: a clean cycle advances the sha and releases the claim", async () => {
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} },
      pages: [pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\ncore"), pageRow("pkg/io", ["pkg/io/b.ts"], "## Purpose\nio")],
    });
    const report = await runWikiRefreshCycle(baseArgs(backend, gitOk(["pkg/core/a.ts"])));
    expect(report.status).toBe("committed");
    expect((backend.state.meta as { last_refresh_sha: string }).last_refresh_sha).toBe(HEAD);
    expect((backend.state.meta as { claimed_by: null }).claimed_by).toBeNull();
  });

  it("crash-equivalent: a failed page leaves the sha UNTOUCHED (next turn redoes the window)", async () => {
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} },
      pages: [pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\ncore"), pageRow("pkg/io", ["pkg/io/b.ts"], "## Purpose\nio")],
    });
    const report = await runWikiRefreshCycle(
      baseArgs(backend, gitOk(["pkg/core/a.ts"]), { run: async () => { throw new Error("LLM down"); } }),
    );
    expect(report.status).toBe("incomplete");
    expect((backend.state.meta as { last_refresh_sha: string }).last_refresh_sha).toBe(PREV); // NOT advanced
  });

  it("escalation from the updater triggers a full regen of that page and resets its patch count", async () => {
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: { "wiki/pkg/core": 20 } },
      pages: [pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\ncore"), pageRow("pkg/io", ["pkg/io/b.ts"], "## Purpose\nio")],
    });
    const regenerate = vi.fn(async () => "created" as const);
    const run = vi.fn(async () => "NO_CHANGE");
    const report = await runWikiRefreshCycle(baseArgs(backend, gitOk(["pkg/core/a.ts"]), { regenerate, run }));
    expect(report.status).toBe("committed");
    // patchCount 20 >= 15 → pre-flight escalation, LLM patch never attempted.
    expect(run).not.toHaveBeenCalled();
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(report.outcomes[0]).toMatchObject({ doc_id: "wiki/pkg/core", action: "regenerated" });
    expect((backend.state.meta as { patch_counts: Record<string, number> }).patch_counts["wiki/pkg/core"]).toBe(0);
  });

  it("a subsystem with no page yet is generated fresh", async () => {
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} },
      pages: [pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\ncore")], // pkg/io missing
    });
    const regenerate = vi.fn(async () => "created" as const);
    const report = await runWikiRefreshCycle(baseArgs(backend, gitOk([]), { regenerate }));
    expect(report.outcomes).toContainEqual({ doc_id: "wiki/pkg/io", action: "generated" });
    expect(report.status).toBe("committed");
  });

  it("signature churn (via loadSnapshotAt) escalates to a regen instead of a patch", async () => {
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} },
      pages: [pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\ncore"), pageRow("pkg/io", ["pkg/io/b.ts"], "## Purpose\nio")],
    });
    // Previous snapshot: same node ids but 6 extra signature-changed symbols in pkg/core.
    const churnNodes = Array.from({ length: 6 }, (_, i) => ({
      ...node(`pkg/core/a.ts:f${i}:function`, "pkg/core/a.ts"), signature: `function f${i}(): number`,
    }));
    const prevSnap = snap([node("pkg/core/a.ts:foo:function", "pkg/core/a.ts"), node("pkg/io/b.ts:bar:function", "pkg/io/b.ts"), ...churnNodes]);
    const currSnap = snap([node("pkg/core/a.ts:foo:function", "pkg/core/a.ts"), node("pkg/io/b.ts:bar:function", "pkg/io/b.ts"),
      ...churnNodes.map((c) => ({ ...c, signature: c.signature + " | CHANGED" }))]);
    const regenerate = vi.fn(async () => "created" as const);
    const run = vi.fn(async () => "NO_CHANGE");
    const report = await runWikiRefreshCycle({
      ...baseArgs(backend, gitOk(["pkg/core/a.ts"]), { regenerate, run }),
      snap: currSnap,
      loadSnapshotAt: (sha) => (sha === PREV ? prevSnap : null),
    });
    expect(report.status).toBe("committed");
    expect(run).not.toHaveBeenCalled(); // escalated pre-flight, no patch attempted
    expect(regenerate).toHaveBeenCalledTimes(1);
    const core = report.outcomes.find((o) => o.doc_id === "wiki/pkg/core");
    expect(core?.action).toBe("regenerated");
    expect(core?.reasons?.join(" ")).toMatch(/signature changes/);
  });

  it("a min-size-SKIPPED group never poisons the cycle (skipped != failed)", async () => {
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} },
      pages: [pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\ncore")], // pkg/io has NO page
    });
    const regenerate = vi.fn(async (g: { key: string }) => (g.key === "pkg/io" ? "skipped" as const : "created" as const));
    const report = await runWikiRefreshCycle(baseArgs(backend, gitOk([]), { regenerate }));
    // The tiny group is reported as skipped, the cycle still COMMITS the sha.
    expect(report.outcomes).toContainEqual({ doc_id: "wiki/pkg/io", action: "skipped", reasons: ["below min size — no page wanted"] });
    expect(report.status).toBe("committed");
    expect((backend.state.meta as { last_refresh_sha: string }).last_refresh_sha).toBe(HEAD);
  });

  it("an INCOMPLETE cycle releases the lease immediately (sha untouched, no 30-min block)", async () => {
    const backend = makeBackend({
      meta: { last_refresh_sha: PREV, claimed_by: null, claimed_at: null, patch_counts: {} },
      pages: [pageRow("pkg/core", ["pkg/core/a.ts"], "## Purpose\ncore"), pageRow("pkg/io", ["pkg/io/b.ts"], "## Purpose\nio")],
    });
    const report = await runWikiRefreshCycle(
      baseArgs(backend, gitOk(["pkg/core/a.ts"]), { run: async () => { throw new Error("LLM down"); } }),
    );
    expect(report.status).toBe("incomplete");
    const meta = backend.state.meta as { last_refresh_sha: string; claimed_by: string | null };
    expect(meta.last_refresh_sha).toBe(PREV); // NOT advanced
    expect(meta.claimed_by).toBeNull();       // lease FREED — retry needs no TTL wait
  });

  it("no git → no-git, nothing read or written", async () => {
    const backend = makeBackend({ meta: null });
    const report = await runWikiRefreshCycle(baseArgs(backend, () => null));
    expect(report.status).toBe("no-git");
    expect(backend.calls).toHaveLength(0);
  });
});

describe("runLocalWikiRefresh (--local preview)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-wlocal-"));
    mkdirSync(join(dir, "pkg", "core"), { recursive: true });
    writeFileSync(join(dir, "pkg", "core", "a.ts"), "export function foo() {\n  return 1;\n}\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SNAP = () => snap([node("pkg/core/a.ts:foo:function", "pkg/core/a.ts")]);
  const gitLocal =
    (workingTree: string[]): GitRunner =>
    (args) => {
      if (args[0] === "diff" && args[1] === "--name-only") return workingTree.join("\n") + "\n";
      if (args[0] === "ls-files") return "";
      if (args[0] === "diff") return "- return 1\n+ return 7\n";
      return null;
    };

  it("patches ONLY the local materialized file — no query function even exists in its API", async () => {
    const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
    const { appendFilesIndex: afi } = await import("../../src/docs/wiki-generate.js");
    wf(join(dir, "pkg", "core.wiki.hivemind.md"), afi("## Purpose\nfoo returns 1.", ["pkg/core/a.ts"]));
    const { outcomes } = await runLocalWikiRefresh({
      snap: SNAP(), repoRoot: dir, git: gitLocal(["pkg/core/a.ts"]),
      run: async () => "## Purpose\nfoo returns 7.",
    });
    expect(outcomes).toEqual([{ file: "pkg/core.wiki.hivemind.md", action: "patched" }]);
    const body = rf(join(dir, "pkg", "core.wiki.hivemind.md"), "utf-8");
    expect(body).toContain("foo returns 7.");
    expect(body).toContain("## Files"); // mechanics re-appended
  });

  it("page not materialized locally → reported, nothing written", async () => {
    const { outcomes } = await runLocalWikiRefresh({
      snap: SNAP(), repoRoot: dir, git: gitLocal(["pkg/core/a.ts"]),
      run: async () => "x",
    });
    expect(outcomes[0].action).toBe("not-materialized");
  });

  it("clean working tree → nothing considered, no LLM call", async () => {
    const run = vi.fn(async () => "x");
    const { outcomes } = await runLocalWikiRefresh({ snap: SNAP(), repoRoot: dir, git: gitLocal([]), run });
    expect(outcomes).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("an over-budget preview patch is SKIPPED (regen belongs to the canonical cycle)", async () => {
    const { writeFileSync: wf, readFileSync: rf } = await import("node:fs");
    const { appendFilesIndex: afi } = await import("../../src/docs/wiki-generate.js");
    const before = afi("## Purpose\nshort.", ["pkg/core/a.ts"]);
    wf(join(dir, "pkg", "core.wiki.hivemind.md"), before);
    const huge = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const { outcomes } = await runLocalWikiRefresh({
      snap: SNAP(), repoRoot: dir, git: gitLocal(["pkg/core/a.ts"]),
      run: async () => huge,
    });
    expect(outcomes[0].action).toBe("escalate-skipped");
    expect(rf(join(dir, "pkg", "core.wiki.hivemind.md"), "utf-8")).toBe(before); // untouched
  });
});
