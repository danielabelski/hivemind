/**
 * Model + token-usage extraction from agent transcripts.
 *
 * The capture hooks record one trace row per session event (user prompt, tool
 * call, assistant turn). Neither Claude Code nor Codex passes model / reasoning
 * effort / token counts in the hook payload, but both write them to the
 * on-disk transcript the hook receives a path to:
 *
 *   Claude Code — `~/.claude/projects/<enc-cwd>/<session>.jsonl`. Each assistant
 *     line is `{ type:"assistant", message:{ model, stop_reason, usage:{...} } }`.
 *     Reasoning effort is not in the message — it's the user's `effortLevel`
 *     setting, read from settings at capture time (see readClaudeEffortLevel).
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

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("model-usage", msg);

/** Money cost of a turn, in the agent's billing currency (Pi / OpenClaw). */
export interface CostBreakdown {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
  total?: number;
}

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
  /** Grand total when the source reports one (Codex / SDK). */
  total_tokens?: number;
  /** Money cost of the turn — Pi / OpenClaw report it directly (fractional). */
  cost?: CostBreakdown;
}

/** Model / effort / token enrichment attached to a captured trace entry. */
export interface TraceModelMeta {
  model?: string;
  reasoning_effort?: string | null;
  /** Why the turn ended: Claude `stop_reason`, Pi/OpenClaw `stopReason`. */
  stop_reason?: string;
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
  /**
   * Per-harness fields that don't generalize across agents (kept faithful to
   * the source rather than dropped): Claude billing detail (service_tier,
   * speed, cache TTL split, server_tool_use), Codex quota (model_context_window,
   * rate_limits), etc. Omitted when the agent exposes none.
   */
  usage_extra?: Record<string, unknown>;
}

/** Token counts are non-negative integers; reject anything else before it reaches an aggregate. */
function toNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** Costs are non-negative finite numbers (fractional dollars); integers-only would drop them. */
function toFloat(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Copy only the numeric fields that are actually present, so absent keys stay absent. */
function assign(target: NormalizedUsage, key: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens" | "reasoning_output_tokens" | "total_tokens", v: unknown): void {
  const n = toNum(v);
  if (n !== undefined) target[key] = n;
}

/** Normalize a Pi/OpenClaw cost object `{input, output, cacheRead, cacheWrite, total}`. */
function normalizeCost(cost: unknown): CostBreakdown | undefined {
  if (!cost || typeof cost !== "object") return undefined;
  const c = cost as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
  const out: CostBreakdown = {};
  const put = (k: keyof CostBreakdown, v: unknown) => { const n = toFloat(v); if (n !== undefined) out[k] = n; };
  put("input", c.input);
  put("output", c.output);
  put("cache_read", c.cacheRead);
  put("cache_creation", c.cacheWrite);
  put("total", c.total);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read only the tail of a transcript (default 1 MiB). Model / usage / stop
 * reason all live in the MOST RECENT turn, which sits at the end of the file —
 * so reading the whole thing on every capture event is needlessly O(filesize)
 * (and O(n²) across a session for Codex, which parses on every user/tool row).
 * The tail bounds each read to a constant. When the file is larger than the
 * window the first (partial) line is dropped, so callers only ever see whole
 * lines. Best-effort: returns null on any error.
 */
export function readTailLines(path: string, maxBytes = 1_048_576): string[] | null {
  if (!path || !existsSync(path)) {
    log(`transcript missing: ${path}`);
    return null;
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= maxBytes) {
      // Whole file fits — read it all; no partial-line handling needed.
      const buf = Buffer.alloc(size);
      const n = size > 0 ? readSync(fd, buf, 0, size, 0) : 0;
      return buf.toString("utf-8", 0, n).split("\n");
    }
    // Read the window PLUS one leading byte, so we can tell whether the window
    // already starts at a line boundary. Buffer.alloc (zeroed) + decoding only
    // the bytes actually read guards against a short read exposing stale memory.
    const start = size - maxBytes - 1;
    const buf = Buffer.alloc(maxBytes + 1);
    const n = readSync(fd, buf, 0, maxBytes + 1, start);
    const text = buf.toString("utf-8", 0, n);
    // The first char is the byte BEFORE the window. If it's "\n", the window
    // starts on a complete line and slicing at index 0 keeps it; otherwise the
    // first line is partial and slicing drops it. Either case: cut at first "\n".
    const nl = text.indexOf("\n");
    return (nl >= 0 ? text.slice(nl + 1) : "").split("\n");
  } catch (e: any) {
    log(`read failed: ${e?.message ?? String(e)}`);
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed / best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Pi / OpenClaw (shared SDK usage shape)
// ---------------------------------------------------------------------------

interface SdkUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: unknown;
}

/**
 * Normalize the Pi / OpenClaw SDK usage object
 * (`{ input, output, cacheRead, cacheWrite, totalTokens, cost }`) onto
 * {@link NormalizedUsage}, including the money `cost` sub-object. Returns
 * undefined when nothing usable is present, so callers can spread it without
 * emitting an empty object.
 */
export function normalizeSdkUsage(usage: unknown): NormalizedUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as SdkUsage;
  const out: NormalizedUsage = {};
  assign(out, "input_tokens", u.input);
  assign(out, "output_tokens", u.output);
  assign(out, "cache_read_tokens", u.cacheRead);
  assign(out, "cache_creation_tokens", u.cacheWrite);
  assign(out, "total_tokens", u.totalTokens);
  const cost = normalizeCost(u.cost);
  if (cost) out.cost = cost;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the trace enrichment for an in-process SDK turn (Pi / OpenClaw), where
 * the model, usage and stop reason arrive on the message object rather than a
 * transcript file. Returns undefined when nothing usable is present. These
 * runtimes expose no reasoning-effort field, so it is left unset.
 */
export function sdkTurnMeta(model: unknown, usage: unknown, stopReason?: unknown): TraceModelMeta | undefined {
  const token_usage = normalizeSdkUsage(usage);
  const hasModel = typeof model === "string" && model.length > 0;
  const hasStop = typeof stopReason === "string" && stopReason.length > 0;
  if (!hasModel && !token_usage && !hasStop) return undefined;
  const meta: TraceModelMeta = {};
  if (hasModel) meta.model = model as string;
  if (hasStop) meta.stop_reason = stopReason as string;
  if (token_usage) meta.token_usage = token_usage;
  return meta;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

interface ClaudeUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  service_tier?: unknown;
  speed?: unknown;
  inference_geo?: unknown;
  cache_creation?: { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown };
  server_tool_use?: { web_search_requests?: unknown; web_fetch_requests?: unknown };
}

interface ClaudeLine {
  type?: string;
  cwd?: unknown;
  message?: { model?: unknown; usage?: ClaudeUsage; stop_reason?: unknown };
}

/**
 * Claude Code's reasoning effort is a user-set control (low/medium/high, with
 * `ultrathink` = high), persisted as `effortLevel` in settings — NOT in the
 * per-message transcript. Read it at capture time, preferring project settings
 * over the user default. Best-effort: returns undefined on any miss so the
 * caller falls back to null. Reflects the level configured when the turn was
 * captured (an in-prompt `ultrathink` override for a single turn isn't
 * recorded anywhere we can recover).
 */
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh"]);

export function readClaudeEffortLevel(cwd?: string): string | undefined {
  const candidates: string[] = [];
  if (cwd) {
    candidates.push(join(cwd, ".claude", "settings.local.json"));
    candidates.push(join(cwd, ".claude", "settings.json"));
  }
  candidates.push(join(homedir(), ".claude", "settings.json"));
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf-8")) as { effortLevel?: unknown };
      // Allowlist Claude's supported levels — a settings file is untrusted
      // input, and an arbitrary/oversized string would poison effort analytics.
      if (typeof j.effortLevel === "string") {
        const level = j.effortLevel.toLowerCase();
        if (CLAUDE_EFFORT_LEVELS.has(level)) return level;
      }
    } catch {
      // ignore unreadable / malformed settings and try the next candidate
    }
  }
  return undefined;
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
 * Claude-only billing detail that doesn't generalize to other agents: the
 * pricing tier / speed, the cache-creation split by TTL (1h vs 5m are priced
 * differently), and billable server-side tool calls. Returns undefined when
 * none are present.
 */
function claudeUsageExtra(u: ClaudeUsage): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (typeof u.service_tier === "string") extra.service_tier = u.service_tier;
  if (typeof u.speed === "string") extra.speed = u.speed;
  if (typeof u.inference_geo === "string") extra.inference_geo = u.inference_geo;
  const cc = u.cache_creation;
  if (cc && typeof cc === "object") {
    const ttl: Record<string, number> = {};
    const a = toNum(cc.ephemeral_1h_input_tokens); if (a !== undefined) ttl.ephemeral_1h = a;
    const b = toNum(cc.ephemeral_5m_input_tokens); if (b !== undefined) ttl.ephemeral_5m = b;
    if (Object.keys(ttl).length) extra.cache_creation_ttl = ttl;
  }
  const st = u.server_tool_use;
  if (st && typeof st === "object") {
    const s: Record<string, number> = {};
    const ws = toNum(st.web_search_requests); if (ws !== undefined) s.web_search_requests = ws;
    const wf = toNum(st.web_fetch_requests); if (wf !== undefined) s.web_fetch_requests = wf;
    if (Object.keys(s).length) extra.server_tool_use = s;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** Reverse-scan already-read lines for the last assistant turn carrying usage. */
function scanClaudeLines(lines: string[] | null): TraceModelMeta | null {
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
    const meta: TraceModelMeta = {
      model: typeof msg.model === "string" ? msg.model : undefined,
      // Not in the transcript message — read the configured effortLevel from
      // settings (null when unset), keyed to the turn's project cwd.
      reasoning_effort: readClaudeEffortLevel(typeof entry.cwd === "string" ? entry.cwd : undefined) ?? null,
      token_usage: normalizeClaudeUsage(msg.usage),
    };
    if (typeof msg.stop_reason === "string") meta.stop_reason = msg.stop_reason;
    const extra = claudeUsageExtra(msg.usage);
    if (extra) meta.usage_extra = extra;
    return meta;
  }
  return null;
}

/**
 * Extract model + last-turn usage from a Claude Code transcript. Scans from the
 * end so the returned usage belongs to the most recently completed assistant
 * turn — exactly the turn whose Stop event is being captured. Reads the file
 * tail for speed; falls back to the whole file if the usage-bearing line didn't
 * fit the tail window (a single assistant record over the window size). Returns
 * null when the file is unreadable or has no assistant line with usage.
 */
export function parseClaudeTurnMeta(transcriptPath?: string): TraceModelMeta | null {
  if (!transcriptPath) return null;
  return (
    scanClaudeLines(readTailLines(transcriptPath)) ??
    scanClaudeLines(readTailLines(transcriptPath, Number.MAX_SAFE_INTEGER))
  );
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

interface CodexRateWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface CodexLine {
  type?: string;
  payload?: {
    type?: string;
    model?: unknown;
    effort?: unknown;
    info?: {
      last_token_usage?: CodexUsage;
      total_token_usage?: CodexUsage;
      model_context_window?: unknown;
    };
    rate_limits?: { primary?: CodexRateWindow; secondary?: CodexRateWindow };
  };
}

/** Compact Codex quota detail from a token_count event: context window + rate-limit windows. */
function codexUsageExtra(
  info: { model_context_window?: unknown } | undefined,
  rateLimits: { primary?: CodexRateWindow; secondary?: CodexRateWindow } | undefined,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  const win = toNum(info?.model_context_window);
  if (win !== undefined) extra.model_context_window = win;
  const pickWin = (w?: CodexRateWindow) => {
    if (!w || typeof w !== "object") return undefined;
    const o: Record<string, number> = {};
    const up = toFloat(w.used_percent); if (up !== undefined) o.used_percent = up;
    const wm = toNum(w.window_minutes); if (wm !== undefined) o.window_minutes = wm;
    const ra = toNum(w.resets_at); if (ra !== undefined) o.resets_at = ra;
    return Object.keys(o).length ? o : undefined;
  };
  const primary = pickWin(rateLimits?.primary);
  const secondary = pickWin(rateLimits?.secondary);
  if (primary || secondary) {
    const rl: Record<string, unknown> = {};
    if (primary) rl.primary = primary;
    if (secondary) rl.secondary = secondary;
    extra.rate_limits = rl;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
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
 * Forward-scan already-read Codex rollout lines. `sawTurnContext` / `sawTokenCount`
 * report which event types were present — the two carry different halves of the
 * turn's metadata (model+effort vs usage+total+quota), so the caller only trusts
 * the tail when BOTH were seen; otherwise it widens the read.
 */
function scanCodexLines(
  lines: string[] | null,
  fallbackModel?: string,
): { meta: TraceModelMeta | null; sawTurnContext: boolean; sawTokenCount: boolean } {
  let model: string | undefined = fallbackModel;
  let reasoningEffort: string | undefined;
  let last: NormalizedUsage | undefined;
  let total: NormalizedUsage | undefined;
  let extra: Record<string, unknown> | undefined;
  let sawTurnContext = false;
  let sawTokenCount = false;

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
        sawTurnContext = true;
        model = typeof p.model === "string" ? p.model : fallbackModel;
        reasoningEffort = typeof p.effort === "string" ? p.effort : undefined;
        last = undefined;
        extra = undefined; // quota (context window / rate limits) is per-turn too
      } else if (p.type === "token_count" && p.info) {
        sawTokenCount = true;
        if (p.info.last_token_usage) last = normalizeCodexUsage(p.info.last_token_usage);
        if (p.info.total_token_usage) total = normalizeCodexUsage(p.info.total_token_usage);
        extra = codexUsageExtra(p.info, p.rate_limits); // latest token_count wins (may clear)
      }
    }
  }

  const empty = model === undefined && reasoningEffort === undefined && !last && !total && !extra;
  if (empty) return { meta: null, sawTurnContext, sawTokenCount };
  const meta: TraceModelMeta = {};
  if (model !== undefined) meta.model = model;
  if (reasoningEffort !== undefined) meta.reasoning_effort = reasoningEffort;
  if (last) meta.token_usage = last;
  if (total) meta.token_usage_total = total;
  if (extra) meta.usage_extra = extra;
  return { meta, sawTurnContext, sawTokenCount };
}

/**
 * Extract model + reasoning effort + latest token usage from a Codex rollout.
 * Keeps the last `turn_context` (model/effort) and last `token_count` (per-turn
 * + cumulative usage + quota). Reads the file tail for speed; the two event
 * types carry different halves of the metadata, so if the tail is missing
 * EITHER (a turn with >window bytes between them), it re-scans the whole file —
 * whose result is authoritative. `fallbackModel` is the hook payload's `model`.
 */
export function parseCodexTurnMeta(
  transcriptPath?: string | null,
  fallbackModel?: string,
): TraceModelMeta | null {
  if (!transcriptPath) return scanCodexLines(null, fallbackModel).meta;
  const tail = scanCodexLines(readTailLines(transcriptPath), fallbackModel);
  if (tail.sawTurnContext && tail.sawTokenCount) return tail.meta;
  const whole = scanCodexLines(readTailLines(transcriptPath, Number.MAX_SAFE_INTEGER), fallbackModel);
  return whole.meta ?? tail.meta;
}
