/**
 * Heuristic "anchor" — a HARD, observable signal in the transcript that a session
 * went badly, independent of any LLM judgment: the user pushed back on / corrected
 * what the assistant just did. Pure + free (no LLM, no I/O).
 *
 * It's the level-1 filter in the outcome pipeline: only windows with an anchor go
 * to the (paid) success-judge, and a session is labelled a failure only when the
 * anchor AND the judge agree. So this is deliberately tuned for RECALL over
 * precision — a false positive just costs one judge call (which then drops it),
 * but a false negative under-detects (conservative — it never churns a good skill).
 * Patterns are meant to be tuned against real sessions; this is a starting set.
 */
import type { Turn } from "./skill-invocations.js";

export type AnchorKind = "correction" | "none";
export interface Anchor {
  anchored: boolean;
  kind: AnchorKind;
  evidence: string; // the user turn that triggered it (truncated)
}

// Unambiguous correction — ALWAYS an anchor, even amid polite words. This must
// win over BENIGN so "thanks, but this is still failing" still fires.
const STRONG = /\b(wrong|incorrect|not what|that'?s not|does ?n'?t work|did ?n'?t work|do ?n'?t work|wo ?n'?t work|is ?n'?t|broke|broken|still (failing|broken|not working|wrong|the same)|try again|undo|revert that|that fail|not right)/i;

// Ambiguous negation: "no" is pushback ("no, that's off") but also benign
// ("no problem"), so it only anchors when the turn isn't a clear benign phrase.
const AMBIGUOUS = /\b(no|nope)\b/i;
const BENIGN = /\b(no (problem|worries|need|biggie)|no,? thanks|all good|works? (now|great|fine|perfectly)|that works|perfect|looks good)\b/i;

/**
 * Detect a correction anchor in a windowed slice of turns. A pushback is a USER turn
 * reacting to an ASSISTANT turn — and BOTH must be POST-invocation (index ≥ fromIndex),
 * so a correction that happened BEFORE the skill ran (e.g. the skill was a repair
 * attempt) isn't misattributed to this skill. fromIndex defaults to 0 (scan all).
 * Recall-oriented: a strong correction fires regardless of polite framing; only the
 * bare "no" is benign-gated.
 */
export function detectAnchor(turns: Turn[], fromIndex = 0): Anchor {
  for (let i = Math.max(1, fromIndex); i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "USER" || turns[i - 1].role !== "ASSISTANT") continue;
    if (i - 1 < fromIndex) continue; // the assistant being reacted to must be post-invocation
    const anchored = STRONG.test(t.text) || (AMBIGUOUS.test(t.text) && !BENIGN.test(t.text));
    if (anchored) {
      return { anchored: true, kind: "correction", evidence: t.text.slice(0, 200) };
    }
  }
  return { anchored: false, kind: "none", evidence: "" };
}
