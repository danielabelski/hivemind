import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Orchestration tests for src/hooks/recall.ts — the UserPromptSubmit proactive-
 * recall hook. Drives main() end-to-end with mocked boundaries (stdin, config,
 * embeddings, DeeplakeApi, plugin-state, debug log) and asserts the emit/skip
 * decision, semantic↔lexical fallback, mode-aware gating, latency budget, and
 * failure isolation. The pure helpers (gate/format/query/deadline) run for
 * real — only the I/O boundary is mocked.
 *
 * SEMANTIC_ENABLED and RECALL_BUDGET_MS are read at module-eval time, so each
 * case sets env + mocks BEFORE the per-test dynamic import (vi.resetModules).
 */

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const embeddingsDisabledMock = vi.fn();
const pluginEnabledMock = vi.fn();
const embedMock = vi.fn();
const queryMock = vi.fn();
const debugLogMock = vi.fn();
const recordEventMock = vi.fn();

vi.mock("../../src/hooks/shared/recall-events.js", () => ({ recordRecallEvent: (...a: unknown[]) => recordEventMock(...a) }));
vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: unknown[]) => loadConfigMock(...a) }));
vi.mock("../../src/embeddings/disable.js", () => ({ embeddingsDisabled: (...a: unknown[]) => embeddingsDisabledMock(...a) }));
vi.mock("../../src/utils/plugin-state.js", () => ({ isHivemindPluginEnabled: (...a: unknown[]) => pluginEnabledMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({ log: (_t: string, msg: string) => debugLogMock(msg) }));
vi.mock("../../src/embeddings/client.js", () => ({
  EmbedClient: class { embed(...a: unknown[]) { return embedMock(...a); } },
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class { query(sql: string) { return queryMock(sql); } },
}));

const CONFIG = {
  token: "t", apiUrl: "https://api", orgId: "o", workspaceId: "w",
  userName: "sasun", tableName: "mem", sessionsTableName: "sess",
};

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "/summaries/levon/s1.md", author: "levon", project: "indra",
    description: "Fixed the parser crash", last_update_date: "2026-06-19T00:00:00Z",
    score: 0.9, ...over,
  };
}

async function runHook(env: Record<string, string | undefined> = {}): Promise<string | null> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.resetModules();
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  try {
    await import("../../src/hooks/recall.js");
    // Wait past microtasks AND any short budget timer (the timeout case uses a
    // ~10ms budget) so main() finishes before we read the captured output.
    await new Promise((r) => setTimeout(r, 25));
    return out.join("\n") || null;
  } finally {
    console.log = orig;
  }
}

function parse(out: string | null): any {
  return JSON.parse((out ?? "").trim());
}

beforeEach(() => {
  for (const k of ["HIVEMIND_PROACTIVE_RECALL", "HIVEMIND_PROACTIVE_RECALL_DISABLED", "HIVEMIND_SEMANTIC_SEARCH", "HIVEMIND_RECALL_TIMEOUT_MS", "HIVEMIND_RECALL_MIN_OVERLAP", "HIVEMIND_WIKI_WORKER"]) delete process.env[k];
  stdinMock.mockReset().mockResolvedValue({ prompt: "how did we fix the parser typeerror crash bug", session_id: "sid", cwd: "/repo" });
  loadConfigMock.mockReset().mockReturnValue(CONFIG);
  pluginEnabledMock.mockReset().mockReturnValue(true);
  embeddingsDisabledMock.mockReset().mockReturnValue(true); // default: lexical
  embedMock.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
  queryMock.mockReset().mockResolvedValue([]);
  debugLogMock.mockReset();
  recordEventMock.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("recall hook — guards (no search, no emit)", () => {
  it("returns immediately when proactive recall is opted out (HIVEMIND_PROACTIVE_RECALL=false)", async () => {
    const out = await runHook({ HIVEMIND_PROACTIVE_RECALL: "false" });
    expect(out).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns immediately via the dedicated HIVEMIND_PROACTIVE_RECALL_DISABLED=1 flag", async () => {
    const out = await runHook({ HIVEMIND_PROACTIVE_RECALL_DISABLED: "1" });
    expect(out).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns when the plugin is disabled", async () => {
    pluginEnabledMock.mockReturnValue(false);
    const out = await runHook();
    expect(out).toBeNull();
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("skips an acknowledgement prompt before any I/O", async () => {
    stdinMock.mockResolvedValue({ prompt: "yes", session_id: "sid" });
    const out = await runHook();
    expect(out).toBeNull();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("skip gate="));
  });

  it("skips when not logged in (no config token)", async () => {
    loadConfigMock.mockReturnValue(null);
    const out = await runHook();
    expect(out).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith("skip no-config");
  });
});

describe("recall hook — lexical path (no embeddings)", () => {
  it("injects an attributed block on a lexical hit above the overlap floor", async () => {
    queryMock.mockResolvedValue([row({ score: 4, author: "levon" })]);
    const out = await runHook(); // embeddingsDisabled=true → lexical
    const parsed = parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("HIVEMIND RECALL");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("levon");
    // It used the lexical ILIKE query, not the semantic one.
    expect(queryMock.mock.calls[0][0]).toContain("ILIKE");
    expect(queryMock.mock.calls[0][0]).not.toContain("<#>");
    expect(embedMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("injected mode=lexical"));
    // Always-on telemetry records the injection.
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ event: "injected", mode: "lexical", teammate: true }));
  });

  it("does NOT inject when the lexical overlap is below the floor", async () => {
    queryMock.mockResolvedValue([row({ score: 1 })]); // < MIN_LEXICAL_OVERLAP (2)
    const out = await runHook();
    expect(out).toBeNull();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("hit=below"));
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ event: "below" }));
  });

  it("does not search when the prompt yields fewer than 2 keywords", async () => {
    stdinMock.mockResolvedValue({ prompt: "rename the parser", session_id: "sid" });
    const out = await runHook();
    expect(out).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("excludes the current session's own summary from results", async () => {
    queryMock.mockResolvedValue([row({ score: 3 })]);
    await runHook();
    expect(queryMock.mock.calls[0][0]).toContain("path <> '/summaries/sasun/sid.md'");
  });
});

describe("recall hook — semantic path (embeddings on)", () => {
  it("injects on a semantic hit above the cosine threshold", async () => {
    embeddingsDisabledMock.mockReturnValue(false);
    queryMock.mockResolvedValue([row({ score: 0.8, author: "levon" })]);
    const out = await runHook();
    const parsed = parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("levon");
    expect(queryMock.mock.calls[0][0]).toContain("<#>"); // cosine query
    expect(embedMock).toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("injected mode=semantic"));
  });

  it("does NOT inject when the cosine score is below threshold", async () => {
    embeddingsDisabledMock.mockReturnValue(false);
    queryMock.mockResolvedValue([row({ score: 0.2 })]);
    const out = await runHook();
    expect(out).toBeNull();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("mode=semantic hit=below"));
  });

  it("falls back to lexical when semantic finds no embedded rows", async () => {
    embeddingsDisabledMock.mockReturnValue(false);
    queryMock
      .mockResolvedValueOnce([])                       // semantic: no embedded rows
      .mockResolvedValueOnce([row({ score: 3 })]);     // lexical: keyword hit
    const out = await runHook();
    expect(parse(out).hookSpecificOutput.additionalContext).toContain("HIVEMIND RECALL");
    expect(queryMock.mock.calls[0][0]).toContain("<#>");   // 1st = semantic
    expect(queryMock.mock.calls[1][0]).toContain("ILIKE"); // 2nd = lexical
  });

  it("falls back to lexical when the embed daemon is unavailable", async () => {
    embeddingsDisabledMock.mockReturnValue(false);
    embedMock.mockResolvedValue(null); // daemon down
    queryMock.mockResolvedValue([row({ score: 3 })]);
    const out = await runHook();
    expect(parse(out).hookSpecificOutput.additionalContext).toContain("HIVEMIND RECALL");
    expect(queryMock.mock.calls[0][0]).toContain("ILIKE");
  });
});

describe("recall hook — latency budget + failure isolation", () => {
  it("skips (no emit) when the search exceeds the budget", async () => {
    queryMock.mockImplementation(() => new Promise((res) => setTimeout(() => res([row({ score: 5 })]), 60)));
    const out = await runHook({ HIVEMIND_RECALL_TIMEOUT_MS: "10" });
    expect(out).toBeNull();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("skip timeout"));
  });

  it("never throws / never emits when the query errors (failure-isolated)", async () => {
    queryMock.mockRejectedValue(new Error("backend down"));
    const out = await runHook();
    expect(out).toBeNull();
  });

  it("emits nothing when there are no matching rows", async () => {
    queryMock.mockResolvedValue([]);
    const out = await runHook();
    expect(out).toBeNull();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("hit=none"));
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ event: "none" }));
  });

  it("records a no-config event when not logged in (telemetry even on the unhappy path)", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ event: "no-config" }));
  });
});
