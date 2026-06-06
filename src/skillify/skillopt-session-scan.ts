/**
 * #4b — the event trigger's cheap pushback signal: which ORG skills got pushed
 * back in a single session, detected by the FREE heuristic anchor (no LLM).
 *
 * Reads the session's turns from Deeplake (capture already normalises every
 * agent's transcript into the sessions table, so this is multi-agent for free).
 * One pass over the session's rows builds the turns and locates each Skill
 * invocation; each invocation is windowed and run through detectAnchor. The
 * result feeds the per-skill counter (skillopt-counter), which fires the worker
 * once a skill crosses the threshold.
 *
 * Each anchored invocation gets a stable key `${sessionId}#${ordinal}` (ordinal =
 * the org-skill invocation's position in the session) so the counter dedups it
 * across repeated UserPromptSubmit/SessionEnd firings within the same session.
 */
import { sqlStr } from "../utils/sql.js";
import { detectAnchor } from "./session-anchor.js";
import { parseMessage, invokedSkillRef, splitOrgSkill, type QueryFn, type Turn } from "./skill-invocations.js";
import type { AnchoredInvocation } from "./skillopt-counter.js";

/** Escape SQL LIKE wildcards so a session id with %/_/\ matches literally. */
function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

export async function anchoredOrgSkillsInSession(
  query: QueryFn,
  sessionsTable: string,
  sessionId: string,
  opts: { before?: number; after?: number } = {},
): Promise<AnchoredInvocation[]> {
  if (!sessionId) return [];
  const sid = sqlStr(likeEscape(sessionId));
  const rows = await query(
    `SELECT message FROM "${sessionsTable}" WHERE path LIKE '/sessions/%${sid}%' ESCAPE '\\' ORDER BY creation_date ASC`,
  );

  // Single pass: build turns + record each org-skill invocation's turn-position + ordinal.
  const turns: Turn[] = [];
  const invs: Array<{ skill: string; invIndex: number; ord: number }> = [];
  let ord = 0;
  for (const r of rows) {
    const j = parseMessage(r.message);
    if (!j) continue;
    // Exact session match — `path LIKE %sid%` can collide on a substring.
    if (typeof j.session_id === "string" && j.session_id !== sessionId) continue;
    const ref = invokedSkillRef(j);
    if (ref) {
      const p = splitOrgSkill(ref); // org skills only; plugin/bare skipped
      if (p) invs.push({ skill: `${p.name}--${p.author}`, invIndex: turns.length, ord: ord++ });
      continue; // the tool_call is not a turn
    }
    const text = typeof j.content === "string" ? j.content.trim() : "";
    if (!text) continue;
    if (j.type === "user_message") turns.push({ role: "USER", text });
    else if (j.type === "assistant_message") turns.push({ role: "ASSISTANT", text });
  }

  const before = opts.before ?? 3;
  const after = opts.after ?? 6;
  const out: AnchoredInvocation[] = [];
  for (const inv of invs) {
    const start = Math.max(0, inv.invIndex - before);
    const window = turns.slice(start, inv.invIndex + after);
    const pivot = inv.invIndex - start; // first POST-invocation turn — the anchor must not scan before it
    if (detectAnchor(window, pivot).anchored) {
      out.push({ skill: inv.skill, key: `${sessionId}#${inv.ord}` });
    }
  }
  return out;
}
