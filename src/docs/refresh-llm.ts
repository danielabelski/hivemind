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
import {
  buildClaudeStdinInvocation,
  buildStdinPromptInvocation,
  buildTrailingPromptInvocation,
  type ClaudeInvocation,
} from "../hooks/wiki-worker-spawn.js";
import { resolveCliBin } from "../utils/resolve-cli-bin.js";
import { buildRefreshPrompt, type GenerateFn } from "./refresh.js";
import {
  buildGeneratePrompt,
  buildBatchGeneratePrompt,
  parseBatchDocs,
  type GenerateDocFn,
  type BatchGenerateFn,
  type GenDocInput,
} from "./generate.js";

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

/**
 * Which host CLI rewrites/authors docs. The auto-refresh runs from a host
 * agent's post-commit hook, so `claude -p` is wrong on a codex/cursor/… box.
 * A spec names the CLI to resolve on PATH and how to shape its invocation.
 */
export interface DocLlmSpec {
  label: string;
  bin: string;
  build: (bin: string, prompt: string) => ClaudeInvocation;
}

// Known agents read the prompt from STDIN (claude: `-p` with piped input;
// codex: `exec … -`). Doc prompts embed whole source files and can exceed the
// OS argv limit — E2BIG — so they must never ride the command line.
const REGISTRY: Record<string, DocLlmSpec> = {
  claude: { label: "claude", bin: "claude", build: (b, p) => buildClaudeStdinInvocation(b, p) },
  codex: {
    label: "codex",
    bin: "codex",
    build: (b, p) => buildStdinPromptInvocation(b, ["exec", "--dangerously-bypass-approvals-and-sandbox", "-"], p),
  },
};

/**
 * Resolve the doc-LLM spec from the environment:
 *   - `HIVEMIND_DOCS_LLM_BIN` (+ optional `HIVEMIND_DOCS_LLM_FLAGS`, comma-sep)
 *     → a fully custom CLI (prompt appended as the trailing arg). Escape hatch
 *     for any agent not in the registry.
 *   - `HIVEMIND_DOCS_LLM_AGENT` = claude | codex → a named registry entry.
 *   - default → claude (byte-identical to the previous behavior).
 */
export function resolveDocLlmSpec(env: NodeJS.ProcessEnv = process.env): DocLlmSpec {
  const customBin = env.HIVEMIND_DOCS_LLM_BIN;
  if (customBin && customBin.trim() !== "") {
    const flags = (env.HIVEMIND_DOCS_LLM_FLAGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    // Trailing-arg is the historical contract for custom CLIs, but argv has an
    // OS size limit (E2BIG) that wiki/doc prompts can exceed. Set
    // HIVEMIND_DOCS_LLM_STDIN=1 if the custom CLI reads its prompt from stdin.
    const viaStdin = env.HIVEMIND_DOCS_LLM_STDIN === "1";
    return {
      label: `custom:${customBin}`,
      bin: customBin,
      build: (b, p) => (viaStdin ? buildStdinPromptInvocation(b, flags, p) : buildTrailingPromptInvocation(b, flags, p)),
    };
  }
  const agent = (env.HIVEMIND_DOCS_LLM_AGENT ?? "claude").toLowerCase();
  const spec = REGISTRY[agent];
  if (!spec) {
    throw new Error(
      `Unknown HIVEMIND_DOCS_LLM_AGENT="${agent}". Known: ${Object.keys(REGISTRY).join(", ")}. ` +
        `For any other CLI set HIVEMIND_DOCS_LLM_BIN (and HIVEMIND_DOCS_LLM_FLAGS).`,
    );
  }
  return spec;
}

/** Run a prompt through a resolved host-LLM spec, returning unwrapped output. */
export function runHostPrompt(spec: DocLlmSpec, bin: string, prompt: string, timeoutMs = 120_000): string {
  const inv = spec.build(bin, prompt);
  const out = execFileSync(inv.file, inv.args, {
    ...inv.options,
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" },
  });
  return unwrapModelOutput((out ?? "").toString());
}

/** Doc REFRESH generator backed by the resolved host agent (claude/codex/custom). */
export function makeHostGenerate(timeoutMs = 120_000, env: NodeJS.ProcessEnv = process.env): GenerateFn {
  const spec = resolveDocLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (ctx) => runHostPrompt(spec, bin, buildRefreshPrompt(ctx), timeoutMs);
}

/** Fresh doc GENERATION generator backed by the resolved host agent. */
export function makeHostGenerateDoc(timeoutMs = 120_000, env: NodeJS.ProcessEnv = process.env): GenerateDocFn {
  const spec = resolveDocLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (input) => runHostPrompt(spec, bin, buildGeneratePrompt(input), timeoutMs);
}

/**
 * BATCHED generation backed by the resolved host agent: one CLI call documents
 * K files. Amortizes the ~15s per-call boot across the batch (~3.7x faster).
 * A longer default timeout accounts for the larger prompt + K docs of output.
 */
export function makeHostBatchGenerateDoc(timeoutMs = 240_000, env: NodeJS.ProcessEnv = process.env): BatchGenerateFn {
  const spec = resolveDocLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (inputs: GenDocInput[]) => {
    const raw = runHostPrompt(spec, bin, buildBatchGeneratePrompt(inputs), timeoutMs);
    return parseBatchDocs(raw, inputs);
  };
}

/**
 * Generic prompt runner backed by the resolved host agent — the production
 * `RunPromptFn` for wiki page generation (chunk notes + synthesis prompts are
 * built by the caller; this just executes them). Longer default timeout: a
 * wiki chunk embeds up to ~120k chars of source.
 */
export function makeHostRunPrompt(timeoutMs = 300_000, env: NodeJS.ProcessEnv = process.env): (prompt: string) => Promise<string> {
  const spec = resolveDocLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (prompt) => runHostPrompt(spec, bin, prompt, timeoutMs);
}

/** Run a single prompt through the host `claude` CLI and return the unwrapped output. */
export function runClaudePrompt(bin: string, prompt: string, timeoutMs = 120_000): string {
  return runHostPrompt(REGISTRY.claude, bin, prompt, timeoutMs);
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
