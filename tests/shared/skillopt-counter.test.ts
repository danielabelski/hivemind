import { describe, it, expect } from "vitest";
import { recordAnchored, fireCount, DEFAULT_FIRE_COUNT, type CounterState } from "../../src/skillify/skillopt-counter.js";

const inv = (skill: string, key: string) => ({ skill, key });
const NOW = "2026-06-06T00:00:00Z";

describe("recordAnchored", () => {
  it("accumulates below the threshold without firing", () => {
    let s: CounterState = {};
    for (let i = 0; i < DEFAULT_FIRE_COUNT - 1; i++) {
      const r = recordAnchored(s, [inv("posthog--kamo", `sess#${i}`)], NOW);
      s = r.state;
      expect(r.toFire).toEqual([]);
    }
    expect(s.counts?.["posthog--kamo"]).toBe(DEFAULT_FIRE_COUNT - 1);
  });

  it("fires exactly when a skill crosses the threshold, then resets it", () => {
    let s: CounterState = {};
    let fired: string[] = [];
    for (let i = 0; i < DEFAULT_FIRE_COUNT; i++) {
      const r = recordAnchored(s, [inv("posthog--kamo", `s#${i}`)], NOW);
      s = r.state; fired = r.toFire;
    }
    expect(fired).toEqual(["posthog--kamo"]);     // crossed on the 5th
    expect(s.counts?.["posthog--kamo"]).toBe(0);  // reset
    expect(s.lastFired?.["posthog--kamo"]).toBe(NOW);
  });

  it("dedups invocations by key — the same pushback counted once across repeated calls", () => {
    let s: CounterState = {};
    const r1 = recordAnchored(s, [inv("x--a", "sess1#3")], NOW); s = r1.state;
    const r2 = recordAnchored(s, [inv("x--a", "sess1#3")], NOW); s = r2.state; // same key again
    const r3 = recordAnchored(s, [inv("x--a", "sess1#3")], NOW); s = r3.state;
    expect(s.counts?.["x--a"]).toBe(1); // not 3
  });

  it("tracks distinct skills independently", () => {
    const r = recordAnchored({}, [inv("a--u", "k1"), inv("b--u", "k2"), inv("a--u", "k3")], NOW);
    expect(r.state.counts).toEqual({ "a--u": 2, "b--u": 1 });
    expect(r.toFire).toEqual([]);
  });

  it("honors a custom threshold and reports each crossing skill once", () => {
    const observed = [inv("a--u", "k1"), inv("a--u", "k2"), inv("b--u", "k3"), inv("b--u", "k4")];
    const r = recordAnchored({}, observed, NOW, 2);
    expect(r.toFire.sort()).toEqual(["a--u", "b--u"]);
    expect(r.state.counts).toEqual({ "a--u": 0, "b--u": 0 });
  });

  it("ignores malformed entries (empty skill or key)", () => {
    const r = recordAnchored({}, [{ skill: "", key: "k" }, { skill: "a--u", key: "" }], NOW);
    expect(r.state.counts ?? {}).toEqual({});
  });

  it("a freshly-fired skill starts a new tally on the next pushback", () => {
    let s: CounterState = {};
    for (let i = 0; i < 2; i++) { s = recordAnchored(s, [inv("a--u", `k${i}`)], NOW, 2).state; }
    expect(s.counts?.["a--u"]).toBe(0);          // fired + reset at 2
    const r = recordAnchored(s, [inv("a--u", "k-new")], NOW, 2);
    expect(r.state.counts?.["a--u"]).toBe(1);    // tally restarts
  });
});

describe("fireCount", () => {
  it("defaults to 5, env-overridable, rejects non-positive/garbage", () => {
    expect(fireCount({} as NodeJS.ProcessEnv)).toBe(5);
    expect(fireCount({ HIVEMIND_SKILLOPT_FIRE_COUNT: "3" } as never)).toBe(3);
    expect(fireCount({ HIVEMIND_SKILLOPT_FIRE_COUNT: "0" } as never)).toBe(5);
    expect(fireCount({ HIVEMIND_SKILLOPT_FIRE_COUNT: "nope" } as never)).toBe(5);
  });
});
