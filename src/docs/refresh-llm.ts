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

/** Build a GenerateFn backed by the host `claude` CLI. */
export function makeClaudeGenerate(claudeBin?: string, timeoutMs = 120_000): GenerateFn {
  const bin = claudeBin ?? resolveCliBin("claude");
  return async (ctx) => {
    const prompt = buildRefreshPrompt(ctx);
    const inv = buildClaudeInvocation(bin, prompt);
    const out = execFileSync(inv.file, inv.args, {
      ...inv.options,
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" },
    });
    return (out ?? "").toString().trim();
  };
}
