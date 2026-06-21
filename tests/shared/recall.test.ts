import { describe, it, expect } from "vitest";
import {
  shouldRecall,
  passesThreshold,
  extractKeywords,
  RECALL_THRESHOLD,
} from "../../src/hooks/shared/recall-gate.js";
import {
  parseSummaryPath,
  daysAgo,
  formatRecallContext,
  type RecallHit,
} from "../../src/hooks/shared/recall-format.js";
import { recallTopHit, recallTopHitLexical } from "../../src/hooks/shared/recall-query.js";
import { withDeadline } from "../../src/hooks/shared/with-deadline.js";

describe("shouldRecall — the precision gate (NOT every prompt)", () => {
  it("skips short acknowledgements / continuations", () => {
    for (const p of ["yes", "ok", "go on", "continue", "fix it", "run the tests", "thanks", "retry", "do it"]) {
      expect(shouldRecall(p).recall, p).toBe(false);
    }
  });

  it("skips empty / very short prompts", () => {
    expect(shouldRecall("").recall).toBe(false);
    expect(shouldRecall("   ").recall).toBe(false);
    expect(shouldRecall("add log").reason).toBe("too-short");
  });

  it("recalls on error / failure / stack-trace signals", () => {
    for (const p of [
      "I'm getting a TypeError when I call the parser",
      "the build fails with cannot find module foo",
      "segfault in column_streamers.hpp:142 on scan",
      "why does this throw an exception on startup",
    ]) {
      const d = shouldRecall(p);
      expect(d.recall, p).toBe(true);
      expect(d.reason).toBe("signal");
    }
  });

  it("recalls on recall/how-to intent", () => {
    expect(shouldRecall("how did we fix the auth token drift last time?").reason).toBe("signal");
    expect(shouldRecall("do we have a known issue with the redis cache here").reason).toBe("signal");
  });

  it("recalls on substantive prose with no explicit marker", () => {
    const d = shouldRecall("please refactor the storage provider to support byoc buckets cleanly");
    expect(d.recall).toBe(true);
    expect(d.reason).toBe("substantive");
  });

  it("skips terse low-signal instructions", () => {
    expect(shouldRecall("rename that variable").recall).toBe(false);
    expect(shouldRecall("bump the version number").recall).toBe(false);
  });
});

describe("passesThreshold", () => {
  it("gates on the cosine score", () => {
    expect(passesThreshold(RECALL_THRESHOLD)).toBe(true);
    expect(passesThreshold(RECALL_THRESHOLD - 0.01)).toBe(false);
    expect(passesThreshold(0.99)).toBe(true);
    expect(passesThreshold(NaN)).toBe(false);
  });
});

describe("parseSummaryPath", () => {
  it("extracts author + session from a summary path", () => {
    expect(parseSummaryPath("/summaries/levon/session-abc.md")).toEqual({ author: "levon", session: "session-abc" });
  });
  it("returns null for non-summary paths", () => {
    expect(parseSummaryPath("/sessions/levon/foo.jsonl")).toBeNull();
    expect(parseSummaryPath("garbage")).toBeNull();
  });
});

describe("daysAgo", () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  it("computes whole days, floored at 0", () => {
    expect(daysAgo("2026-06-20T00:00:00Z", now)).toBe(0);
    expect(daysAgo("2026-06-19T00:00:00Z", now)).toBe(1);
    expect(daysAgo("2026-06-13T12:00:00Z", now)).toBe(7);
    expect(daysAgo("2999-01-01T00:00:00Z", now)).toBe(0); // future clamps to 0
  });
  it("returns null for unparseable dates", () => {
    expect(daysAgo("not-a-date", now)).toBeNull();
  });
});

describe("formatRecallContext", () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  const base: RecallHit = {
    path: "/summaries/levon/sess-1.md",
    author: "levon",
    project: "indra",
    description: "Fixed pg-deeplake SIGSEGV on sessions scan via row-count clamp",
    lastUpdate: "2026-06-18T00:00:00Z",
    score: 0.71,
    mode: "semantic",
  };

  it("attributes a teammate's hit with relative date + project", () => {
    const out = formatRecallContext({ hit: base, currentUser: "sasun", now });
    expect(out).toContain("HIVEMIND RECALL");
    expect(out).toContain("levon"); // teammate name surfaced
    expect(out).toContain("2d ago");
    expect(out).toContain("indra");
    expect(out).toContain("Fixed pg-deeplake SIGSEGV");
    expect(out).toContain("cat ~/.deeplake/memory/summaries/levon/sess-1.md");
  });

  it("says 'you' when the hit is the current user's own work", () => {
    const out = formatRecallContext({ hit: base, currentUser: "levon", now });
    expect(out).toContain("you");
    expect(out).not.toMatch(/•\s+levon/);
  });

  it("returns empty string for an unattributable path (never inject unattributed)", () => {
    const out = formatRecallContext({ hit: { ...base, path: "/sessions/x/y.jsonl" }, currentUser: "sasun", now });
    expect(out).toBe("");
  });

  it("frames the block as context, not an instruction (prompt-injection hygiene)", () => {
    const out = formatRecallContext({ hit: base, currentUser: "sasun", now });
    expect(out.toLowerCase()).toContain("not an instruction");
  });
});

describe("withDeadline — bounds the synchronous recall path", () => {
  it("resolves to the promise value when it beats the deadline", async () => {
    const r = await withDeadline(Promise.resolve("ok"), 1000, "fallback");
    expect(r).toBe("ok");
  });

  it("resolves to the fallback when the promise exceeds the deadline", async () => {
    const slow = new Promise<string>((res) => setTimeout(() => res("late"), 50));
    const r = await withDeadline(slow, 5, "skip");
    expect(r).toBe("skip");
  });

  it("resolves to the fallback when the promise rejects (never throws on the critical path)", async () => {
    const r = await withDeadline(Promise.reject(new Error("boom")), 1000, "skip");
    expect(r).toBe("skip");
  });
});

describe("recallTopHit — focused semantic query", () => {
  const vec = [0.1, 0.2, 0.3];

  it("builds a cosine-ranked query over the memory table and maps the top row", async () => {
    let captured = "";
    const query = async (sql: string) => {
      captured = sql;
      return [{
        path: "/summaries/levon/s1.md", author: "levon", project: "indra",
        description: "desc", last_update_date: "2026-06-18", score: 0.8,
      }];
    };
    const hit = await recallTopHit(query, "org_memory", vec, { excludePath: "/summaries/sasun/mine.md", limit: 3 });
    expect(captured).toContain("summary_embedding <#> ARRAY[");
    expect(captured).toContain('FROM "org_memory"');
    expect(captured).toContain("ARRAY_LENGTH(summary_embedding, 1) > 0");
    expect(captured).toContain("path <> '/summaries/sasun/mine.md'");
    expect(captured).toContain("ORDER BY score DESC LIMIT 3");
    expect(hit).toMatchObject({ author: "levon", project: "indra", score: 0.8, mode: "semantic" });
  });

  it("returns null when no rows match", async () => {
    const hit = await recallTopHit(async () => [], "t", vec, {});
    expect(hit).toBeNull();
  });

  it("returns null for a non-finite embedding (never builds a NULL-vector query)", async () => {
    let called = false;
    const hit = await recallTopHit(async () => { called = true; return []; }, "t", [0.1, NaN], {});
    expect(hit).toBeNull();
    expect(called).toBe(false);
  });
});

describe("extractKeywords — lexical fallback keyword extraction", () => {
  it("keeps salient/identifier tokens, drops stopwords and short tokens", () => {
    const kw = extractKeywords("why does the parser throw a TypeError in column_streamers.hpp?");
    expect(kw).toContain("parser");
    expect(kw).toContain("typeerror");
    expect(kw).toContain("column_streamers.hpp");
    expect(kw).not.toContain("the");
    expect(kw).not.toContain("why"); // stopword
  });
  it("de-dupes and caps the count", () => {
    const kw = extractKeywords("cache cache cache redis redis storage storage provider bucket byoc extra", 4);
    expect(kw.length).toBe(4);
    expect(new Set(kw).size).toBe(kw.length);
  });
  it("returns few/no keywords for terse input (can't meet the lexical bar)", () => {
    expect(extractKeywords("ok go").length).toBeLessThan(2);
  });
});

describe("recallTopHitLexical — ILIKE keyword-overlap fallback", () => {
  const kw = ["parser", "typeerror"];

  it("builds an overlap-ranked ILIKE query and tags the hit lexical", async () => {
    let captured = "";
    const query = async (sql: string) => {
      captured = sql;
      return [{ path: "/summaries/levon/s.md", author: "levon", project: "indra", description: "d", last_update_date: "2026-06-18", score: 2 }];
    };
    const hit = await recallTopHitLexical(query, "org_memory", kw, { excludePath: "/summaries/me/x.md" });
    expect(captured).toContain("ILIKE '%parser%'");
    expect(captured).toContain("ILIKE '%typeerror%'");
    expect(captured).toContain("CASE WHEN"); // overlap count
    expect(captured).toContain('FROM "org_memory"');
    expect(captured).toContain("path <> '/summaries/me/x.md'");
    expect(captured).toContain("ORDER BY score DESC");
    expect(hit).toMatchObject({ author: "levon", score: 2, mode: "lexical" });
  });

  it("returns null when fewer than 2 keywords (precision floor)", async () => {
    let called = false;
    const hit = await recallTopHitLexical(async () => { called = true; return []; }, "t", ["only"], {});
    expect(hit).toBeNull();
    expect(called).toBe(false);
  });
});
