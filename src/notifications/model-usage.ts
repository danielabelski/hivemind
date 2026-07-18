/**
 * Model + token-usage extraction from agent transcripts.
 *
 * The capture hooks record one trace row per session event (user prompt, tool
 * call, assistant turn). Neither Claude Code nor Codex passes model / reasoning
 * effort / token counts in the hook payload, but both write them to the
 * on-disk transcript the hook receives a path to:
 *
 *   Claude Code — `~/.claude/projects/<enc-cwd>/<session>.jsonl`. Each assistant
 *     line is `{ type:"assistant", message:{ model, usage:{ input_tokens,
 *     output_tokens, cache_read_input_tokens, cache_creation_input_tokens } } }`.
 *     Reasoning effort is not a per-message field, so it is left null.
 *
 *   Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. A `turn_context`
 *     line carries `payload.model` + `payload.effort`; `event_msg` lines with
 *     `payload.type === "token_count"` carry `payload.info.last_token_usage`
 *     (this turn) and `payload.info.total_token_usage` (cumulative), each with
 *     `{ input_tokens, cached_input_tokens, output_tokens,
 *     reasoning_output_tokens, total_tokens }`.
 *
 * Both parsers normalize onto {@link NormalizedUsage} so a per-model rollup is a
 * single `GROUP BY message->>'model'` over the sessions table. They are
 * best-effort: any read/parse failure returns null and capture proceeds without
 * the enrichment (never throws, never blocks a trace write).
 */

import { existsSync, readFileSync } from "node:fs";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("model-usage", msg);

/** Token counts normalized across agents. Fields absent from the source are omitted. */
export interface NormalizedUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** Tokens served from the prompt cache (Claude cache_read_input_tokens / Codex cached_input_tokens). */
  cache_read_tokens?: number;
  /** Tokens written to the prompt cache (Claude cache_creation_input_tokens; Codex has none). */
  cache_creation_tokens?: number;
  /** Reasoning tokens billed as output (Codex only). */
  reasoning_output_tokens?: number;
  /** Grand total when the source reports one (Codex). */
  total_tokens?: number;
}

/** Model / effort / token enrichment attached to a captured trace entry. */
export interface TraceModelMeta {
  model?: string;
  reasoning_effort?: string | null;
  /** Usage for the most recent turn. */
  token_usage?: NormalizedUsage;
  /**
   * Cumulative session usage (Codex `total_token_usage`). This is a
   * whole-session running total spanning every model used, NOT per-model — a
   * session total is `MAX(total_tokens)` per session. For per-model totals,
   * sum the per-turn `token_usage`, deduping by `turn_id` (each Codex turn's
   * tool events share one snapshot).
   */
  token_usage_total?: NormalizedUsage;
}

/** Token counts are non-negative integers; reject anything else before it reaches an aggregate. */
function toNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** Copy only the numeric fields that are actually present, so absent keys stay absent. */
function assign(target: NormalizedUsage, key: keyof NormalizedUsage, v: unknown): void {
  const n = toNum(v);
  if (n !== undefined) target[key] = n;
}

function readLines(path: string): string[] | null {
  if (!path || !existsSync(path)) {
    log(`transcript missing: ${path}`);
    return null;
  }
  try {
    return readFileSync(path, "utf-8").split("\n");
  } catch (e: any) {
    log(`read failed: ${e?.message ?? String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

interface ClaudeUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

interface ClaudeLine {
  type?: string;
  message?: { model?: unknown; usage?: ClaudeUsage };
}

function normalizeClaudeUsage(u: ClaudeUsage): NormalizedUsage {
  const out: NormalizedUsage = {};
  assign(out, "input_tokens", u.input_tokens);
  assign(out, "output_tokens", u.output_tokens);
  assign(out, "cache_read_tokens", u.cache_read_input_tokens);
  assign(out, "cache_creation_tokens", u.cache_creation_input_tokens);
  return out;
}

/**
 * Extract model + last-turn usage from a Claude Code transcript. Scans from the
 * end so the returned usage belongs to the most recently completed assistant
 * turn — exactly the turn whose Stop event is being captured. Returns null when
 * the file is unreadable or contains no assistant line with usage.
 */
export function parseClaudeTurnMeta(transcriptPath?: string): TraceModelMeta | null {
  if (!transcriptPath) return null;
  const lines = readLines(transcriptPath);
  if (!lines) return null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry: ClaudeLine;
    try {
      entry = JSON.parse(trimmed) as ClaudeLine;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue; // e.g. a bare `null` line
    const msg = entry.message;
    if (entry.type !== "assistant" || !msg || !msg.usage) continue;
    return {
      model: typeof msg.model === "string" ? msg.model : undefined,
      reasoning_effort: null, // Claude has no per-message reasoning-effort field.
      token_usage: normalizeClaudeUsage(msg.usage),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

interface CodexUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

interface CodexLine {
  type?: string;
  payload?: {
    type?: string;
    model?: unknown;
    effort?: unknown;
    info?: { last_token_usage?: CodexUsage; total_token_usage?: CodexUsage };
  };
}

function normalizeCodexUsage(u: CodexUsage): NormalizedUsage {
  const out: NormalizedUsage = {};
  assign(out, "input_tokens", u.input_tokens);
  assign(out, "output_tokens", u.output_tokens);
  assign(out, "cache_read_tokens", u.cached_input_tokens);
  assign(out, "reasoning_output_tokens", u.reasoning_output_tokens);
  assign(out, "total_tokens", u.total_tokens);
  return out;
}

/**
 * Extract model + reasoning effort + latest token usage from a Codex rollout.
 * Walks forward keeping the last `turn_context` (model/effort) and last
 * `token_count` (per-turn + cumulative usage). `fallbackModel` is the hook
 * payload's `model`, used when the rollout has no `turn_context` yet.
 */
export function parseCodexTurnMeta(
  transcriptPath?: string | null,
  fallbackModel?: string,
): TraceModelMeta | null {
  const lines = transcriptPath ? readLines(transcriptPath) : null;

  let model: string | undefined = fallbackModel;
  let reasoningEffort: string | undefined;
  let last: NormalizedUsage | undefined;
  let total: NormalizedUsage | undefined;

  if (lines) {
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      let entry: CodexLine;
      try {
        entry = JSON.parse(trimmed) as CodexLine;
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue; // e.g. a bare `null` line
      const p = entry.payload;
      if (!p) continue;
      if (entry.type === "turn_context") {
        // A new turn context starts a new turn (possibly a new model/effort).
        // Reset both to this turn's values — falling back to the hook model
        // when the context omits one — so a later turn never inherits an
        // earlier turn's model or effort. The previous turn's per-turn usage is
        // cleared for the same reason; `total` is a session-wide cumulative and
        // is intentionally preserved across turns.
        model = typeof p.model === "string" ? p.model : fallbackModel;
        reasoningEffort = typeof p.effort === "string" ? p.effort : undefined;
        last = undefined;
      } else if (p.type === "token_count" && p.info) {
        if (p.info.last_token_usage) last = normalizeCodexUsage(p.info.last_token_usage);
        if (p.info.total_token_usage) total = normalizeCodexUsage(p.info.total_token_usage);
      }
    }
  }

  if (model === undefined && reasoningEffort === undefined && !last && !total) return null;

  const meta: TraceModelMeta = {};
  if (model !== undefined) meta.model = model;
  if (reasoningEffort !== undefined) meta.reasoning_effort = reasoningEffort;
  if (last) meta.token_usage = last;
  if (total) meta.token_usage_total = total;
  return meta;
}
