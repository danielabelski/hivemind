/**
 * Real host-LLM generator for doc refresh — the production `GenerateFn`.
 *
 * Reuses the no-API-key seam the wiki worker uses: shell out to the host's
 * `claude` CLI via `buildClaudeInvocation` (handles Unix vs Windows `.cmd`).
 * The prompt instructs the model to print ONLY the updated markdown, which we
 * capture from stdout.
 *
 * This module is intentionally thin and side-effecting (subprocess); the
 * orchestration + gating it feeds (`./refresh.ts`, `./gate.ts`) is pure and
 * unit-tested. Per-agent variants (codex/cursor/hermes/pi) mirror the
 * wiki-worker forks and can wrap `buildTrailingPromptInvocation` the same way.
 */

import { execFileSync } from "node:child_process";
import { buildClaudeInvocation } from "../hooks/wiki-worker-spawn.js";
import { resolveCliBin } from "../utils/resolve-cli-bin.js";
import { buildRefreshPrompt, type GenerateFn } from "./refresh.js";
import { buildGeneratePrompt, type GenerateDocFn } from "./generate.js";

/**
 * Defensively unwrap the model's output. The prompt asks for raw markdown,
 * but models sometimes wrap the whole body in a single ```fence``` (with an
 * optional language tag). Strip exactly that outer fence so it doesn't leak
 * into the stored doc; leave inner/partial fences untouched. Returns the
 * trimmed body otherwise.
 */
export function unwrapModelOutput(raw: string): string {
  const text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  return fence ? fence[1].trim() : text;
}

/** Run a single prompt through the host `claude` CLI and return the unwrapped output. */
export function runClaudePrompt(bin: string, prompt: string, timeoutMs = 120_000): string {
  const inv = buildClaudeInvocation(bin, prompt);
  const out = execFileSync(inv.file, inv.args, {
    ...inv.options,
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" },
  });
  return unwrapModelOutput((out ?? "").toString());
}

/** Resolve the claude binary once (PATH lookup), with the usual fallback. */
export function resolveClaudeBin(claudeBin?: string): string {
  return claudeBin ?? resolveCliBin("claude");
}

/** Build a GenerateFn (doc REFRESH) backed by the host `claude` CLI. */
export function makeClaudeGenerate(claudeBin?: string, timeoutMs = 120_000): GenerateFn {
  const bin = resolveClaudeBin(claudeBin);
  return async (ctx) => runClaudePrompt(bin, buildRefreshPrompt(ctx), timeoutMs);
}

/** Build a GenerateDocFn (fresh doc GENERATION) backed by the host `claude` CLI. */
export function makeClaudeGenerateDoc(claudeBin?: string, timeoutMs = 120_000): GenerateDocFn {
  const bin = resolveClaudeBin(claudeBin);
  return async (input) => runClaudePrompt(bin, buildGeneratePrompt(input), timeoutMs);
}
