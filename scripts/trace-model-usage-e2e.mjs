#!/usr/bin/env node
/**
 * End-to-end trace of model + reasoning effort + token usage across every model
 * provider present in the local agent transcripts.
 *
 * For each distinct model found in the real Claude Code transcripts
 * (~/.claude/projects) and Codex rollouts (~/.codex/sessions), this drives the
 * REAL compiled capture hook (dist/src/hooks/capture.js and
 * dist/src/hooks/codex/capture.js) with a synthesized hook payload whose
 * transcript_path points at that transcript, then reads the rows back from the
 * sessions table and prints the model / reasoning_effort / token_usage that
 * actually landed in the JSONB `message` column.
 *
 * It exercises the whole path — parser -> entry build -> SQL INSERT -> Deeplake
 * -> read-back — not just the parser in isolation.
 *
 * Safety:
 *   - Writes to a THROWAWAY table (HIVEMIND_SESSIONS_TABLE, default
 *     `sessions_modeltest`), never the production `sessions` table.
 *   - HIVEMIND_WIKI_WORKER=1 suppresses the hooks' side effects (owner walk,
 *     periodic summary spawn, stop trigger) so only the INSERT runs.
 *   - Deletes its own rows on completion.
 *
 * Usage:
 *   node scripts/trace-model-usage-e2e.mjs            # trace + report + cleanup
 *   HIVEMIND_SESSIONS_TABLE=my_test node scripts/trace-model-usage-e2e.mjs
 *   KEEP=1 node scripts/trace-model-usage-e2e.mjs     # keep rows for inspection
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = process.env.HIVEMIND_SESSIONS_TABLE ?? "sessions_modeltest";
const RUN_TAG = "modeltest-" + Date.now().toString(36);
const MAX_FILES_PER_AGENT = Number(process.env.MAX_FILES ?? 300);

const { parseClaudeTurnMeta, parseCodexTurnMeta, sdkTurnMeta } = await import(
  join(ROOT, "dist/src/notifications/model-usage.js")
);
const { loadConfig } = await import(join(ROOT, "dist/src/config.js"));
const { DeeplakeApi } = await import(join(ROOT, "dist/src/deeplake-api.js"));

// Env shared by every hook invocation: throwaway table, no side effects, no embed.
const HOOK_ENV = {
  ...process.env,
  HIVEMIND_SESSIONS_TABLE: TABLE,
  HIVEMIND_WIKI_WORKER: "1",
  HIVEMIND_EMBEDDINGS: "false",
  HIVEMIND_CAPTURE: "true",
};

/** Newest-first list of transcript files under a directory tree, capped. */
function listTranscripts(rootDir, cap) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(rootDir);
  return out
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, cap)
    .map((x) => x.p);
}

/** One representative transcript per distinct model, using the real parser. */
function pickOnePerModel(files, parse) {
  const byModel = new Map();
  for (const f of files) {
    let meta;
    try {
      meta = parse(f);
    } catch {
      continue;
    }
    if (meta?.model && !byModel.has(meta.model)) byModel.set(meta.model, f);
  }
  return byModel; // model -> file
}

/** Find a real transcript message carrying model+usage and print the entry sdkTurnMeta would build. */
function proveSdk(name, dir) {
  const files = listTranscripts(dir, 200);
  for (const f of files) {
    let raw;
    try {
      raw = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    for (const ln of raw.split("\n")) {
      if (!ln.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(ln);
      } catch {
        continue;
      }
      const m = o.message ?? o;
      const usage = m?.usage ?? o?.usage;
      const model = m?.model ?? o?.model;
      const meta = sdkTurnMeta(model, usage);
      if (meta?.token_usage) {
        console.log(`  [${name}] ${String(meta.model ?? "?").padEnd(24)} token_usage=${JSON.stringify(meta.token_usage)}`);
        return;
      }
    }
  }
  console.log(`  [${name}] no real transcript with usage found`);
}

function runHook(entry, payload) {
  const r = spawnSync("node", [join(ROOT, entry)], {
    input: JSON.stringify(payload),
    env: HOOK_ENV,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return r.status === 0;
}

async function main() {
  const config = loadConfig();
  if (!config) {
    console.error("No Deeplake credentials resolved (log in with `hivemind login`).");
    process.exit(1);
  }
  console.log(`Org: ${config.orgName} | table: ${TABLE} | run: ${RUN_TAG}\n`);

  const claudeModels = pickOnePerModel(
    listTranscripts(join(homedir(), ".claude", "projects"), MAX_FILES_PER_AGENT),
    parseClaudeTurnMeta,
  );
  const codexModels = pickOnePerModel(
    listTranscripts(join(homedir(), ".codex", "sessions"), MAX_FILES_PER_AGENT),
    (f) => parseCodexTurnMeta(f),
  );

  console.log(
    `Discovered ${claudeModels.size} Claude model(s), ${codexModels.size} Codex model(s).\n`,
  );

  // Trace each model through the real hook. session_id carries RUN_TAG so we can
  // find and clean up exactly these rows.
  let n = 0;
  for (const [model, file] of claudeModels) {
    const sid = `${RUN_TAG}-cc-${n++}`;
    const ok = runHook("dist/src/hooks/capture.js", {
      session_id: sid,
      transcript_path: file,
      cwd: ROOT,
      hook_event_name: "Stop",
      last_assistant_message: `e2e trace for ${model}`,
    });
    console.log(`  [claude_code] ${model} -> ${ok ? "captured" : "FAILED"}`);
  }
  for (const [model, file] of codexModels) {
    const sid = `${RUN_TAG}-cx-${n++}`;
    const ok = runHook("dist/src/hooks/codex/capture.js", {
      session_id: sid,
      transcript_path: file,
      cwd: ROOT,
      hook_event_name: "UserPromptSubmit",
      model,
      prompt: `e2e trace for ${model}`,
    });
    console.log(`  [codex] ${model} -> ${ok ? "captured" : "FAILED"}`);
  }

  // Cursor: model is in the payload (no token data exists in its transcript).
  {
    const sid = `${RUN_TAG}-cur`;
    const ok = runHook("dist/src/hooks/cursor/capture.js", {
      conversation_id: sid,
      session_id: sid,
      hook_event_name: "afterAgentResponse",
      model: "cursor-default-model",
      cwd: ROOT,
      text: "e2e trace for cursor",
    });
    console.log(`  [cursor] cursor-default-model -> ${ok ? "captured" : "FAILED"}`);
  }

  // Hermes: payload carries no model / token data — capture a plain event to
  // confirm the row still lands (model/usage simply absent, never fabricated).
  {
    const sid = `${RUN_TAG}-herm`;
    const ok = runHook("dist/src/hooks/hermes/capture.js", {
      session_id: sid,
      hook_event_name: "UserPromptSubmit",
      cwd: ROOT,
      extra: { prompt: "e2e trace for hermes" },
    });
    console.log(`  [hermes] (no model/token data) -> ${ok ? "captured" : "FAILED"}`);
  }

  // Read the rows back from the store and report what actually landed.
  const api = new DeeplakeApi(
    config.token,
    config.apiUrl,
    config.orgId,
    config.workspaceId,
    TABLE,
  );
  const res = await api.query(
    `SELECT message FROM "${TABLE}" WHERE message->>'session_id' LIKE '${RUN_TAG}-%' ORDER BY agent, message->>'model'`,
  );
  const rows = res?.rows ?? res?.data ?? res ?? [];

  console.log(`\n=== Rows read back from ${TABLE} (${rows.length}) ===`);
  let withTokens = 0;
  for (const row of rows) {
    const m = typeof row.message === "string" ? JSON.parse(row.message) : row.message;
    const u = m.token_usage;
    if (u && (u.input_tokens != null || u.output_tokens != null)) withTokens++;
    console.log(
      `  ${String(m.model ?? "?").padEnd(28)} effort=${String(m.reasoning_effort ?? "—").padEnd(7)} ` +
        `usage=${u ? JSON.stringify(u) : "—"}` +
        (m.token_usage_total ? ` total=${JSON.stringify(m.token_usage_total)}` : ""),
    );
  }
  console.log(
    `\n${withTokens}/${rows.length} rows carry token counts; ${new Set(rows.map((r) => (typeof r.message === "string" ? JSON.parse(r.message) : r.message).model)).size} distinct models traced.`,
  );

  // Pi + OpenClaw capture in-process (extension event / producer hook), not via
  // a stdin subprocess, so they can't be driven here. Prove the exact enriched
  // entry they build by running the shared sdkTurnMeta over a real message from
  // each one's on-disk transcript.
  console.log(`\n=== Pi / OpenClaw entry-build proof (from real transcripts) ===`);
  proveSdk("pi", join(homedir(), ".pi", "agent", "sessions"));
  proveSdk("openclaw", join(homedir(), ".openclaw"));

  if (process.env.KEEP === "1") {
    console.log(`\nKEEP=1 — leaving ${rows.length} rows in ${TABLE}.`);
    return;
  }
  await api.query(`DELETE FROM "${TABLE}" WHERE message->>'session_id' LIKE '${RUN_TAG}-%'`);
  console.log(`\nCleaned up ${rows.length} test rows from ${TABLE}.`);
}

main().catch((e) => {
  console.error("e2e trace failed:", e?.message ?? e);
  process.exit(1);
});
