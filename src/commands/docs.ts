#!/usr/bin/env node

/**
 * CLI surface for `hivemind docs` — per-file documentation kept fresh on
 * code deltas (Phase 1: manual set/show/list/archive; the delta worker
 * drives `setDoc` programmatically later).
 *
 * Usage:
 *   hivemind docs set <doc-id> ["<markdown>"] [--file <path>] [--project P] [--tier fast|slow] [--path <vfs-path>]
 *       Idempotent upsert by doc-id (the source file path). First write =
 *       v1; subsequent writes append v+1, preserving the immutable
 *       created_at. Content comes from the positional arg, or --file, or
 *       stdin when the positional is "-".
 *   hivemind docs show <doc-id>
 *       Print the latest version's metadata + markdown body.
 *   hivemind docs list [--project P] [--status active|archived|all] [--limit N]
 *       List the latest version per doc-id.
 *   hivemind docs archive <doc-id>
 *       Soft-delete (status='archived'), preserving content + audit trail.
 *
 * The handler is deliberately thin — it parses argv, loads config,
 * constructs the api client, and delegates to src/docs/{write,read}. All
 * SQL escaping and version-bump logic lives in the docs module.
 */

import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { getVersion } from "../cli/version.js";
import {
  setDoc,
  archiveDoc,
  listDocs,
  listDocMeta,
  listDocsByIds,
  getDocLatest,
  computeImpactedDocs,
  refreshDocs,
  buildAnchor,
  buildDocsIndex,
  dirOf,
  firstDocLine,
  changedFilesFromGit,
  expandToCandidateFiles,
  type DocRow,
  type DocMeta,
  type DocTier,
  type DocAnchor,
} from "../docs/index.js";
import { makeClaudeGenerate, makeClaudeGenerateDoc } from "../docs/refresh-llm.js";
import { generateDocs, selectTargets, type GenScope } from "../docs/generate.js";
import { loadCurrentSnapshot } from "../graph/load-current.js";
import { isMissingTableError } from "../deeplake-schema.js";

const USAGE = `
hivemind docs — per-file documentation kept fresh on code deltas

Usage:
  hivemind docs set <doc-id> ["<markdown>"] [--file <path>] [--project P] [--tier fast|slow] [--path <vfs-path>]
  hivemind docs show <doc-id>
  hivemind docs index [<dir>]
      Browsable per-directory index of the docs (metadata only). With no
      argument shows the top level; pass a directory to drill in.
  hivemind docs list [--project P] [--status active|archived|all] [--limit N]
  hivemind docs archive <doc-id>
  hivemind docs refresh [--cwd <dir>] [--dry-run]
      Detect docs whose anchored code drifted (vs the current graph) and
      regenerate them via the host LLM, gated. --dry-run only reports the
      impacted docs without calling the LLM or writing anything.
  hivemind docs generate [--cwd <dir>] [--scope file|symbol] [--include <glob>]
                         [--exclude <glob>] [--limit N] [--concurrency N]
                         [--force] [--dry-run]
      Auto-author docs for the codebase from the AST graph (which already skips
      .gitignored / non-code files). Default scope=file (one doc per file,
      anchored to its symbols). Skips files that already have a doc unless
      --force. --dry-run lists the targets without calling the LLM.
`.trim();

function requireConfig(): NonNullable<ReturnType<typeof loadConfig>> {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not logged in. Run `hivemind login` first.");
    process.exit(2);
    throw new Error("unreachable");
  }
  return cfg;
}

function makeApi(cfg: NonNullable<ReturnType<typeof loadConfig>>): DeeplakeApi {
  return new DeeplakeApi(cfg.token, cfg.apiUrl, cfg.orgId, cfg.workspaceId, cfg.tableName);
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return undefined;
  return args[idx].includes("=") ? args[idx].split("=", 2)[1] : args[idx + 1];
}

/** Collect ALL values of a repeatable flag (e.g. --anchor X --anchor Y). */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      if (args[i + 1] !== undefined) out.push(args[i + 1]);
      i++;
    } else if (a.startsWith(`${name}=`)) {
      out.push(a.split("=", 2)[1]);
    }
  }
  return out;
}

function parseStatus(args: string[]): "active" | "archived" | "all" {
  const raw = flagValue(args, "--status");
  if (raw === undefined) return "active";
  if (raw === "active" || raw === "archived" || raw === "all") return raw;
  console.error(`Invalid --status value: ${raw}. Allowed: active | archived | all.`);
  process.exit(1);
  throw new Error("unreachable");
}

function parseTier(args: string[]): DocTier {
  const raw = flagValue(args, "--tier");
  if (raw === undefined) return "fast";
  if (raw === "fast" || raw === "slow") return raw;
  console.error(`Invalid --tier value: ${raw}. Allowed: fast | slow.`);
  process.exit(1);
  throw new Error("unreachable");
}

function parseLimit(args: string[]): number {
  const raw = flagValue(args, "--limit");
  if (raw === undefined) return 200;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`Invalid --limit value: ${raw}. Must be a positive integer.`);
    process.exit(1);
    throw new Error("unreachable");
  }
  return n;
}

const KNOWN_FLAGS = new Set(["--file", "--project", "--tier", "--path", "--status", "--limit", "--cwd", "--dry-run", "--anchor", "--scope", "--include", "--exclude", "--concurrency", "--force"]);
/** Flags that take NO value — they must not consume the following token. */
const BOOLEAN_FLAGS = new Set(["--dry-run", "--force"]);

/** Drop flag tokens (and their values) so positional scan sees only doc-id / content. */
function stripKnownFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (KNOWN_FLAGS.has(a)) {
      if (!BOOLEAN_FLAGS.has(a)) i++; // value-taking flags also skip their value
      continue;
    }
    if (KNOWN_FLAGS.has(a.split("=", 2)[0])) continue;
    out.push(a);
  }
  return out;
}

/** Resolve the markdown body from positional arg, --file, or stdin ("-"). */
function resolveContent(positionalContent: string | undefined, args: string[]): string {
  const file = flagValue(args, "--file");
  if (file !== undefined) return readFileSync(file, "utf-8");
  if (positionalContent === "-") return readFileSync(0, "utf-8"); // stdin
  return positionalContent ?? "";
}

/** Default VFS path for a doc when --path is omitted. */
function defaultVfsPath(project: string, docId: string): string {
  const proj = project || "default";
  return `/docs/${proj}/${docId}.md`;
}

function formatListRow(r: DocRow): string {
  const tag = r.status === "archived" ? "[archived]" : "[active]";
  const anchors = r.anchors.length === 1 ? "1 anchor" : `${r.anchors.length} anchors`;
  return `${tag} ${r.doc_id}  v${r.version}  (${r.tier}, ${anchors})  ${r.path}`;
}

export async function runDocsCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(USAGE);
    return;
  }

  const cfg = requireConfig();
  const api = makeApi(cfg);
  const tableName = cfg.docsTableName;
  const query = api.query.bind(api);
  const pluginVersion = getVersion();

  // Only write subcommands need DDL — read-only show/list (and refresh
  // --dry-run) fall back to isMissingTableError so they don't pay a CREATE
  // round-trip. `refresh` ensures the table itself, but only when it will
  // actually write (handled inside its branch so --dry-run stays read-only).
  const WRITE_SUBS = new Set(["set", "archive"]);
  if (WRITE_SUBS.has(sub)) {
    await api.ensureDocsTable(tableName);
  }

  if (sub === "set") {
    const positional = stripKnownFlags(args.slice(1));
    const docId = positional[0];
    if (!docId) {
      console.error('Missing doc-id. Usage: hivemind docs set <doc-id> "<markdown>" [--file <path>]');
      process.exit(1);
      throw new Error("unreachable");
    }
    const project = flagValue(args, "--project") ?? "";
    const path = flagValue(args, "--path") ?? defaultVfsPath(project, docId);
    const tier = parseTier(args);
    // Optional anchors: build from the current graph so the doc is tied to the
    // code it describes (enables drift detection by `docs refresh`).
    const anchorIds = flagValues(args, "--anchor");
    let anchors: DocAnchor[] | undefined;
    if (anchorIds.length > 0) {
      const snap = loadCurrentSnapshot(flagValue(args, "--cwd") ?? process.cwd());
      if (!snap) {
        console.error("--anchor needs a built graph. Run `hivemind graph build` first.");
        process.exit(1);
        throw new Error("unreachable");
      }
      const nodeById = new Map(snap.nodes.map((n) => [n.id, n]));
      anchors = [];
      for (const sid of anchorIds) {
        const node = nodeById.get(sid);
        if (!node) {
          console.error(`--anchor: symbol not in graph: ${sid}`);
          process.exit(1);
          throw new Error("unreachable");
        }
        const a = buildAnchor(node, flagValue(args, "--cwd") ?? process.cwd());
        if (!a) {
          console.error(`--anchor: could not read source for ${sid}`);
          process.exit(1);
          throw new Error("unreachable");
        }
        anchors.push(a);
      }
    }
    try {
      // resolveContent reads --file / stdin and can throw on a bad path — keep
      // it inside the guard so it surfaces as a controlled CLI error.
      const content = resolveContent(positional[1], args);
      const out = await setDoc(query, tableName, {
        doc_id: docId,
        path,
        content,
        anchors,
        tier,
        project,
        agent: cfg.userName,
        plugin_version: pluginVersion,
      });
      console.log(`Set doc ${out.doc_id} → v${out.version}.`);
    } catch (err) {
      console.error(`Set failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "index") {
    // Browsable per-directory index. `atDir` ("" = root) is an optional
    // positional; drilling in scopes the metadata read to that subtree.
    const atDir = (stripKnownFlags(args.slice(1))[0] ?? "").replace(/\/+$/, "");
    let meta: DocMeta[] = [];
    try {
      const rows = await listDocMeta(query, tableName, { dirPrefix: atDir });
      meta = rows.map((r) => ({
        doc_id: r.doc_id,
        version: r.version,
        updated_at: r.updated_at,
        status: r.status,
        tier: r.tier,
      }));
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
    }
    // Fetch content ONLY for files directly in this directory → 1-line summaries.
    const directFiles = meta
      .filter((m) => m.status === "active" && dirOf(m.doc_id) === atDir)
      .map((m) => m.doc_id);
    const summaries = new Map<string, string>();
    if (directFiles.length > 0) {
      try {
        for (const d of await listDocsByIds(query, tableName, directFiles)) {
          summaries.set(d.doc_id, firstDocLine(d.content));
        }
      } catch (err) {
        if (!isMissingTableError((err as Error).message)) throw err;
      }
    }
    console.log(buildDocsIndex(meta, atDir, summaries));
    return;
  }

  if (sub === "show") {
    const docId = stripKnownFlags(args.slice(1))[0];
    if (!docId) {
      console.error("Usage: hivemind docs show <doc-id>");
      process.exit(1);
      throw new Error("unreachable");
    }
    let row: DocRow | null = null;
    try {
      row = await getDocLatest(query, tableName, docId);
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
    }
    if (!row) {
      console.log(`(no doc for ${docId})`);
      return;
    }
    console.log(`# ${row.doc_id}`);
    console.log(`version: ${row.version}  tier: ${row.tier}  status: ${row.status}`);
    console.log(`project: ${row.project}  path: ${row.path}`);
    console.log(`created: ${row.created_at}  updated: ${row.updated_at}`);
    console.log(`anchors: ${row.anchors.length}`);
    console.log("---");
    console.log(row.content);
    return;
  }

  if (sub === "list") {
    const project = flagValue(args, "--project");
    const status = parseStatus(args.slice(1));
    const limit = parseLimit(args.slice(1));
    let rows: DocRow[] = [];
    try {
      rows = await listDocs(query, tableName, { status, project, limit });
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
    }
    if (rows.length === 0) {
      console.log(`(no docs with status=${status})`);
      return;
    }
    for (const r of rows) console.log(formatListRow(r));
    return;
  }

  if (sub === "archive") {
    const docId = stripKnownFlags(args.slice(1))[0];
    if (!docId) {
      console.error("Usage: hivemind docs archive <doc-id>");
      process.exit(1);
      throw new Error("unreachable");
    }
    try {
      const out = await archiveDoc(query, tableName, {
        doc_id: docId,
        agent: cfg.userName,
        plugin_version: pluginVersion,
      });
      console.log(`Archived doc ${out.doc_id} → v${out.version}.`);
    } catch (err) {
      console.error(`Archive failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "refresh") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const dryRun = args.includes("--dry-run");
    const snap = loadCurrentSnapshot(cwd);
    if (!snap) {
      console.error("No local graph for this directory. Run `hivemind graph build` first.");
      process.exit(1);
      throw new Error("unreachable");
    }
    // Scope the read to the diff when git can tell us what changed: load only
    // the candidate docs (changed files + their transitive callers) instead of
    // the whole corpus. Per-commit work becomes O(diff), not O(all docs). No
    // git signal → full scan, logged (never a silent narrowing).
    const changed = changedFilesFromGit(cwd);
    let docs: DocRow[] = [];
    try {
      if (changed !== null) {
        const candidates = expandToCandidateFiles(snap, changed);
        docs = await listDocsByIds(query, tableName, candidates);
        docs = docs.filter((d) => d.status === "active");
        console.error(`[docs refresh] scoped to ${candidates.length} candidate file(s) from git diff (${changed.length} changed)`);
      } else {
        docs = await listDocs(query, tableName, { status: "active", limit: 100000 });
        console.error(`[docs refresh] no git signal — full scan of ${docs.length} doc(s)`);
      }
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
    }
    const impacted = computeImpactedDocs({ snap, docs, repoRoot: cwd });
    if (impacted.length === 0) {
      console.log("(no docs need refreshing — all anchors fresh)");
      return;
    }
    if (dryRun) {
      console.log(`${impacted.length} doc(s) would be refreshed:`);
      for (const i of impacted) {
        console.log(`  ${i.doc_id}  [${i.reasons.map((r) => r.kind).join(", ")}]`);
      }
      return;
    }
    // Real refresh writes — ensure the table now (dry-run above already returned).
    await api.ensureDocsTable(tableName);
    const docsById = new Map(docs.map((d) => [d.doc_id, d]));
    const report = await refreshDocs({
      query,
      tableName,
      snap,
      repoRoot: cwd,
      impacted,
      docsById,
      generate: makeClaudeGenerate(),
      agent: cfg.userName,
      pluginVersion,
    });
    console.log(
      `Refreshed ${report.refreshed}, archived ${report.archived}, rejected ${report.rejected}, skipped ${report.skipped}.`,
    );
    for (const o of report.outcomes) {
      if (o.status === "refreshed") console.log(`  refreshed ${o.doc_id} → v${o.version}`);
      else if (o.status === "archived") console.log(`  archived ${o.doc_id} → v${o.version} (${(o.reasons ?? []).join("; ")})`);
      else console.log(`  ${o.status} ${o.doc_id}: ${(o.reasons ?? []).join("; ")}`);
    }
    return;
  }

  if (sub === "generate") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");
    const scopeRaw = flagValue(args, "--scope") ?? "file";
    if (scopeRaw !== "file" && scopeRaw !== "symbol") {
      console.error("Invalid --scope. Allowed: file | symbol.");
      process.exit(1);
      throw new Error("unreachable");
    }
    const scope = scopeRaw as GenScope;
    const include = flagValues(args, "--include");
    const exclude = flagValues(args, "--exclude");
    const limitRaw = flagValue(args, "--limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    const concurrency = Number(flagValue(args, "--concurrency") ?? "6");
    const project = flagValue(args, "--project") ?? "";

    const snap = loadCurrentSnapshot(cwd);
    if (!snap) {
      console.error("No local graph for this directory. Run `hivemind graph build` first.");
      process.exit(1);
      throw new Error("unreachable");
    }
    let existingDocs: DocRow[] = [];
    try {
      existingDocs = await listDocs(query, tableName, { status: "all", limit: 1000000 });
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
    }
    const existing = new Set(existingDocs.map((d) => d.doc_id));
    const allTargets = selectTargets(snap, { scope, include, exclude });
    const todo = force ? allTargets : allTargets.filter((t) => !existing.has(t.doc_id));

    if (dryRun) {
      console.log(`${todo.length} target(s) would be documented (scope=${scope}); ${allTargets.length - todo.length} already documented or skipped.`);
      for (const t of todo.slice(0, limit ?? 60)) {
        console.log(`  ${t.doc_id}  (${t.symbols.length} symbols)`);
      }
      return;
    }

    await api.ensureDocsTable(tableName);
    const report = await generateDocs({
      query, tableName, snap, repoRoot: cwd, project, scope, include, exclude,
      existing, force, limit, concurrency,
      generate: makeClaudeGenerateDoc(), agent: cfg.userName, pluginVersion,
    });
    console.log(`Generated ${report.created}, skipped ${report.skipped}, failed ${report.failed} (of ${report.targets} targets).`);
    for (const o of report.outcomes) {
      if (o.status !== "created") console.log(`  ${o.status} ${o.doc_id}: ${o.reason ?? ""}`);
    }
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  console.error(USAGE);
  process.exit(1);
}
