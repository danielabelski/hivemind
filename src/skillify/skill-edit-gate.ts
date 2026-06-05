/**
 * Edit-outcome gate — the validation organ (the paper's gate, adapted).
 *
 * A randomized A/B is the ideal, but it needs the skill VERSION recorded at
 * invocation time (a capture change we don't have yet — the Skill tool_use only
 * carries the skill name). So the feasible gate is LONGITUDINAL: after an edit is
 * published, compare the skill's confirmed-failure rate in the window AFTER publish
 * vs BEFORE. A real drop = the edit helped → keep; a real rise = it hurt → revert
 * (one `cp` from the SKILL.v<old>.bak backup). No clear signal / too few post-publish
 * uses → inconclusive (wait, or revert when stale).
 *
 * It's OBSERVATIONAL (confounded — the population shifts week to week), so it needs
 * a margin + a minimum sample. Randomized A/B is the clean upgrade once invocation-
 * version capture lands. Reuses scoreInvocations, so the same anchor+judge that
 * detects deficiency also validates the fix. Injected query/judge → unit-testable.
 */
import { listSkillInvocations, type QueryFn } from "./skill-invocations.js";
import { scoreInvocations } from "./deficiency-detector.js";
import type { ModelCall } from "./claude-model.js";

export interface WindowStats {
  invocations: number;
  anchored: number;
  confirmed: number;
  failureRate: number; // confirmed / invocations
}

export interface GateDecision {
  before: WindowStats;
  after: WindowStats;
  delta: number; // before.failureRate - after.failureRate (positive = improved)
  decision: "keep" | "revert" | "inconclusive";
}

interface MeasureOpts {
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
  window?: { before?: number; after?: number; maxChars?: number };
  judge?: ModelCall;
}

/** Confirmed-failure rate for one skill over a time window. */
export async function measureSkillFailureRate(
  query: QueryFn,
  sessionsTable: string,
  name: string,
  author: string,
  opts: MeasureOpts = {},
): Promise<WindowStats> {
  const all = await listSkillInvocations(query, sessionsTable, { sinceIso: opts.sinceIso, untilIso: opts.untilIso, limit: opts.limit });
  const mine = all.filter((i) => i.name === name && i.author === author);
  const { anchored, confirmed } = await scoreInvocations(query, sessionsTable, mine, { window: opts.window, judge: opts.judge });
  return { invocations: mine.length, anchored, confirmed, failureRate: mine.length ? confirmed / mine.length : 0 };
}

/** Pure decision from before/after stats. */
export function gateEditOutcome(
  before: WindowStats,
  after: WindowStats,
  opts: { margin?: number; minAfter?: number } = {},
): GateDecision {
  const margin = opts.margin ?? 0.2;
  const minAfter = opts.minAfter ?? 5;
  const delta = before.failureRate - after.failureRate;
  let decision: GateDecision["decision"];
  if (after.invocations < minAfter) decision = "inconclusive";              // not enough post-publish use
  else if (delta >= margin) decision = "keep";                              // failure rate dropped → helped
  else if (after.failureRate - before.failureRate >= margin) decision = "revert"; // got measurably worse
  else decision = "inconclusive";                                          // no clear signal
  return { before, after, delta, decision };
}

/** Full gate: measure before/after a publish timestamp and decide. */
export async function gateEdit(
  query: QueryFn,
  sessionsTable: string,
  name: string,
  author: string,
  publishIso: string,
  opts: { windowDays?: number; nowIso?: string; margin?: number; minAfter?: number } & MeasureOpts = {},
): Promise<GateDecision> {
  const windowDays = opts.windowDays ?? 14;
  const beforeSince = new Date(Date.parse(publishIso) - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const shared = { limit: opts.limit, window: opts.window, judge: opts.judge };
  const before = await measureSkillFailureRate(query, sessionsTable, name, author, { ...shared, sinceIso: beforeSince, untilIso: publishIso });
  const after = await measureSkillFailureRate(query, sessionsTable, name, author, { ...shared, sinceIso: publishIso, untilIso: opts.nowIso });
  return gateEditOutcome(before, after, opts);
}
