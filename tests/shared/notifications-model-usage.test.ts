import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseClaudeTurnMeta,
  parseCodexTurnMeta,
} from "../../src/notifications/model-usage.js";

let TEMP_DIR = "";

beforeEach(() => {
  TEMP_DIR = mkdtempSync(join(tmpdir(), "hivemind-model-usage-test-"));
});

afterEach(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

function writeTranscript(lines: object[]): string {
  const file = join(TEMP_DIR, "transcript.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

// Real Claude Code assistant line shape (see transcript sample in model-usage.ts docstring).
function claudeAssistantLine(model: string, usage: Record<string, number>) {
  return {
    type: "assistant",
    message: { model, role: "assistant", content: [], usage },
  };
}

// Real Codex rollout line shapes.
function codexTurnContext(model: string, effort: string) {
  return { type: "turn_context", payload: { model, effort } };
}
function codexTokenCount(last: Record<string, number>, total: Record<string, number>) {
  return {
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
  };
}

describe("parseClaudeTurnMeta", () => {
  it("returns null for missing path / no path", () => {
    expect(parseClaudeTurnMeta(undefined)).toBeNull();
    expect(parseClaudeTurnMeta("/tmp/does-not-exist-hivemind.jsonl")).toBeNull();
  });

  it("extracts model + normalized usage from the last assistant turn", () => {
    const file = writeTranscript([
      claudeAssistantLine("claude-sonnet-4-6", {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      }),
      { type: "user", message: { role: "user", content: [] } },
      claudeAssistantLine("claude-opus-4-8", {
        input_tokens: 19088,
        output_tokens: 404,
        cache_read_input_tokens: 15547,
        cache_creation_input_tokens: 18853,
      }),
    ]);
    const meta = parseClaudeTurnMeta(file);
    // Last assistant turn wins (reverse scan), not the first.
    expect(meta?.model).toBe("claude-opus-4-8");
    expect(meta?.reasoning_effort).toBeNull();
    expect(meta?.token_usage).toEqual({
      input_tokens: 19088,
      output_tokens: 404,
      cache_read_tokens: 15547,
      cache_creation_tokens: 18853,
    });
  });

  it("omits absent usage fields rather than defaulting them to 0", () => {
    const file = writeTranscript([
      claudeAssistantLine("claude-opus-4-8", { input_tokens: 50, output_tokens: 3 }),
    ]);
    const meta = parseClaudeTurnMeta(file);
    expect(meta?.token_usage).toEqual({ input_tokens: 50, output_tokens: 3 });
    expect(meta?.token_usage).not.toHaveProperty("cache_read_tokens");
  });

  it("skips malformed lines and assistant lines without usage", () => {
    // First line is not JSON; second is an assistant line missing usage; third
    // is the valid one the reverse scan should return.
    const file = join(TEMP_DIR, "transcript.jsonl");
    const lines = [
      "not json",
      "null", // valid JSON but not an object — must not throw
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", role: "assistant" } }),
      JSON.stringify(claudeAssistantLine("claude-opus-4-8", { input_tokens: 1, output_tokens: 1 })),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");
    const meta = parseClaudeTurnMeta(file);
    expect(meta?.token_usage).toEqual({ input_tokens: 1, output_tokens: 1 });
  });
});

describe("parseCodexTurnMeta", () => {
  it("falls back to payload model when the transcript is missing", () => {
    const meta = parseCodexTurnMeta(undefined, "gpt-5.6-sol");
    expect(meta?.model).toBe("gpt-5.6-sol");
    expect(meta?.token_usage).toBeUndefined();
  });

  it("returns null when nothing is available", () => {
    expect(parseCodexTurnMeta(undefined, undefined)).toBeNull();
  });

  it("extracts model, reasoning effort, last + total usage from the rollout", () => {
    const file = writeTranscript([
      codexTurnContext("gpt-5.5", "medium"),
      codexTokenCount(
        { input_tokens: 20131, cached_input_tokens: 9984, output_tokens: 154, reasoning_output_tokens: 0, total_tokens: 20285 },
        { input_tokens: 20131, cached_input_tokens: 9984, output_tokens: 154, reasoning_output_tokens: 0, total_tokens: 20285 },
      ),
      codexTokenCount(
        { input_tokens: 32758, cached_input_tokens: 32128, output_tokens: 79, reasoning_output_tokens: 0, total_tokens: 32837 },
        { input_tokens: 212981, cached_input_tokens: 196736, output_tokens: 3427, reasoning_output_tokens: 160, total_tokens: 216408 },
      ),
    ]);
    const meta = parseCodexTurnMeta(file, "payload-model");
    // turn_context model overrides the payload fallback.
    expect(meta?.model).toBe("gpt-5.5");
    expect(meta?.reasoning_effort).toBe("medium");
    // Latest token_count wins for both per-turn and cumulative.
    expect(meta?.token_usage).toEqual({
      input_tokens: 32758,
      output_tokens: 79,
      cache_read_tokens: 32128,
      reasoning_output_tokens: 0,
      total_tokens: 32837,
    });
    expect(meta?.token_usage_total).toEqual({
      input_tokens: 212981,
      output_tokens: 3427,
      cache_read_tokens: 196736,
      reasoning_output_tokens: 160,
      total_tokens: 216408,
    });
  });

  it("does not attach a prior turn's usage to a new turn_context (model change)", () => {
    // Turn A completes with a token_count, then turn B opens with a new model
    // BEFORE its own token_count arrives (the UserPromptSubmit at turn start).
    const file = writeTranscript([
      codexTurnContext("gpt-5.5", "medium"),
      codexTokenCount(
        { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      ),
      codexTurnContext("gpt-5.6-sol", "high"),
    ]);
    const meta = parseCodexTurnMeta(file, "fb");
    expect(meta?.model).toBe("gpt-5.6-sol");
    expect(meta?.reasoning_effort).toBe("high");
    // Turn A's tokens must NOT be attributed to turn B's model.
    expect(meta?.token_usage).toBeUndefined();
    // Session cumulative is preserved across the turn boundary.
    expect(meta?.token_usage_total).toEqual({ input_tokens: 100, output_tokens: 10, total_tokens: 110 });
  });

  it("resets model + effort per turn, falling back to the hook model when a context omits them", () => {
    const file = writeTranscript([
      codexTurnContext("gpt-5.5", "medium"),
      codexTokenCount({ input_tokens: 9, output_tokens: 1, total_tokens: 10 }, { input_tokens: 9, output_tokens: 1, total_tokens: 10 }),
      { type: "turn_context", payload: {} }, // new turn with no model/effort
    ]);
    const meta = parseCodexTurnMeta(file, "hook-model");
    expect(meta?.model).toBe("hook-model"); // not the stale gpt-5.5
    expect(meta?.reasoning_effort).toBeUndefined(); // not the stale "medium"
  });

  it("rejects negative / fractional token counts", () => {
    const file = writeTranscript([
      codexTurnContext("gpt-5.5", "low"),
      codexTokenCount(
        { input_tokens: -5, output_tokens: 3.5, total_tokens: 10 },
        { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      ),
    ]);
    const meta = parseCodexTurnMeta(file, "fb");
    // input_tokens (negative) and output_tokens (fractional) dropped; total kept.
    expect(meta?.token_usage).toEqual({ total_tokens: 10 });
  });

  it("survives a bare null JSONL line (best-effort contract)", () => {
    const file = join(TEMP_DIR, "transcript.jsonl");
    const lines = [
      "null",
      JSON.stringify(codexTurnContext("gpt-5.5", "low")),
      JSON.stringify(codexTokenCount({ input_tokens: 3, output_tokens: 1, total_tokens: 4 }, { input_tokens: 3, output_tokens: 1, total_tokens: 4 })),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");
    const meta = parseCodexTurnMeta(file, "fb");
    expect(meta?.model).toBe("gpt-5.5");
    expect(meta?.token_usage?.total_tokens).toBe(4);
  });

  it("keeps payload model when the rollout has token counts but no turn_context", () => {
    const file = writeTranscript([
      codexTokenCount(
        { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      ),
    ]);
    const meta = parseCodexTurnMeta(file, "gpt-5.6-sol");
    expect(meta?.model).toBe("gpt-5.6-sol");
    expect(meta?.reasoning_effort).toBeUndefined();
    expect(meta?.token_usage?.total_tokens).toBe(7);
  });
});
