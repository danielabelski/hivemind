import { describe, it, expect, vi } from "vitest";
import { gateEditOutcome, gateEdit, type WindowStats } from "../../src/skillify/skill-edit-gate.js";

const stats = (invocations: number, failureRate: number): WindowStats =>
  ({ invocations, anchored: Math.round(invocations * failureRate), confirmed: Math.round(invocations * failureRate), failureRate });

describe("gateEditOutcome", () => {
  it("KEEP when the failure rate dropped by >= margin", () => {
    expect(gateEditOutcome(stats(10, 0.6), stats(10, 0.1)).decision).toBe("keep");
  });
  it("REVERT when it got measurably worse", () => {
    expect(gateEditOutcome(stats(10, 0.1), stats(10, 0.5)).decision).toBe("revert");
  });
  it("INCONCLUSIVE when there's too little post-publish use", () => {
    expect(gateEditOutcome(stats(10, 0.6), stats(3, 0.0)).decision).toBe("inconclusive");
  });
  it("INCONCLUSIVE when the change is within the margin (noise)", () => {
    expect(gateEditOutcome(stats(10, 0.30), stats(10, 0.25)).decision).toBe("inconclusive");
  });
});

const invRow = (skill: string, sid: string) => ({
  message: { type: "tool_call", tool_name: "Skill", tool_input: JSON.stringify({ skill }), session_id: sid, timestamp: sid },
  last_update_date: sid,
});
const transcript = (skill: string, sid: string, pushback: boolean) => [
  { message: { type: "user_message", content: "do it" } },
  { message: { type: "assistant_message", content: "done (mocked)" } },
  { message: { type: "tool_call", tool_name: "Skill", tool_input: JSON.stringify({ skill }), timestamp: sid } },
  { message: { type: "user_message", content: pushback ? "no that's wrong, it mocks the client" : "looks good thanks" } },
];

describe("gateEdit (longitudinal before/after)", () => {
  it("keeps an edit whose failure rate dropped after publish", async () => {
    const PUB = "2026-06-05T00:00:00.000Z";
    const transcripts = new Map<string, Array<Record<string, unknown>>>();
    const beforeInvs: Array<Record<string, unknown>> = [];
    const afterInvs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 8; i++) {
      const b = `bef${i}`, a = `aft${i}`;
      beforeInvs.push(invRow("x--a", b)); transcripts.set(b, transcript("x--a", b, true));   // before: all pushback
      afterInvs.push(invRow("x--a", a)); transcripts.set(a, transcript("x--a", a, false));    // after: none
    }
    const judge = vi.fn(async (_s: string, _u: string) => '{"success":0,"confidence":0.9,"reason":"mocks"}');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('"Skill"') && sql.includes("ORDER BY last_update_date")) {
        return sql.includes(`< '${PUB}'`) ? beforeInvs : afterInvs; // before window has the untilIso bound
      }
      const m = sql.match(/\/sessions\/%([^%]+)%/);
      return m ? (transcripts.get(m[1]) ?? []) : [];
    });

    const res = await gateEdit(query, "sessions", "x", "a", PUB, { windowDays: 14, nowIso: "2026-06-12T00:00:00.000Z", judge, minAfter: 5 });
    expect(res.before.failureRate).toBeCloseTo(1.0);
    expect(res.after.failureRate).toBeCloseTo(0.0);
    expect(res.decision).toBe("keep");
  });
});
