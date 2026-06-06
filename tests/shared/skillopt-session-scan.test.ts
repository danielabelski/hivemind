import { describe, it, expect, vi } from "vitest";
import { anchoredOrgSkillsInSession } from "../../src/skillify/skillopt-session-scan.js";

/** Build a session's Deeplake rows: user/assistant turns + Skill tool_calls, in order. */
function rows(sessionId: string, seq: Array<{ k: "u" | "a" | "skill"; v: string }>) {
  return seq.map((s) => {
    if (s.k === "skill") {
      return { message: { type: "tool_call", tool_name: "Skill", tool_input: JSON.stringify({ skill: s.v }), session_id: sessionId } };
    }
    return { message: { type: s.k === "u" ? "user_message" : "assistant_message", content: s.v, session_id: sessionId } };
  });
}
const queryReturning = (data: unknown[]) => vi.fn(async (_sql: string) => data as Array<Record<string, unknown>>);

describe("anchoredOrgSkillsInSession", () => {
  it("flags an org skill the user pushed back on (free anchor, no LLM)", async () => {
    const q = queryReturning(rows("sess1", [
      { k: "u", v: "smoke test posthog" },
      { k: "skill", v: "posthog--kamo" },
      { k: "a", v: "I mocked the client" },
      { k: "u", v: "no that's wrong, mocking means the event never reaches PostHog" },
    ]));
    const out = await anchoredOrgSkillsInSession(q, "sessions", "sess1");
    expect(out).toEqual([{ skill: "posthog--kamo", key: "sess1#0" }]);
  });

  it("does NOT flag when the user was satisfied", async () => {
    const q = queryReturning(rows("sess1", [
      { k: "u", v: "do it" },
      { k: "skill", v: "posthog--kamo" },
      { k: "a", v: "done" },
      { k: "u", v: "thanks, perfect" },
    ]));
    expect(await anchoredOrgSkillsInSession(q, "sessions", "sess1")).toEqual([]);
  });

  it("keys invocations by ordinal so two invocations of the same skill are distinct", async () => {
    const q = queryReturning(rows("sX", [
      { k: "skill", v: "a--u" }, { k: "a", v: "x" }, { k: "u", v: "wrong" },
      { k: "skill", v: "a--u" }, { k: "a", v: "y" }, { k: "u", v: "still broken" },
    ]));
    const out = await anchoredOrgSkillsInSession(q, "sessions", "sX");
    expect(out).toEqual([{ skill: "a--u", key: "sX#0" }, { skill: "a--u", key: "sX#1" }]);
  });

  it("skips plugin-namespaced and bare skills (org skills only)", async () => {
    const q = queryReturning(rows("s", [
      { k: "skill", v: "hivemind:memory" }, { k: "a", v: "x" }, { k: "u", v: "wrong" },
      { k: "skill", v: "bareskill" }, { k: "a", v: "y" }, { k: "u", v: "wrong" },
      { k: "skill", v: "real--auth" }, { k: "a", v: "z" }, { k: "u", v: "wrong" },
    ]));
    const out = await anchoredOrgSkillsInSession(q, "sessions", "s");
    expect(out).toEqual([{ skill: "real--auth", key: "s#0" }]); // ordinal counts org skills only
  });

  it("does not misattribute a pushback that happened BEFORE the invocation", async () => {
    const q = queryReturning(rows("s", [
      { k: "a", v: "earlier attempt" },
      { k: "u", v: "no that's wrong" },     // pre-invocation correction
      { k: "skill", v: "a--u" },
      { k: "a", v: "new attempt" },
      { k: "u", v: "thanks!" },             // post-invocation: satisfied
    ]));
    expect(await anchoredOrgSkillsInSession(q, "sessions", "s")).toEqual([]);
  });

  it("returns [] for an empty session id without querying", async () => {
    const q = queryReturning([]);
    expect(await anchoredOrgSkillsInSession(q, "sessions", "")).toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });
});
