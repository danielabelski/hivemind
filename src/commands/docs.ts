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
  getDocLatest,
  type DocRow,
  type DocTier,
} from "../docs/index.js";
import { isMissingTableError } from "../deeplake-schema.js";

const USAGE = `
hivemind docs — per-file documentation kept fresh on code deltas

Usage:
  hivemind docs set <doc-id> ["<markdown>"] [--file <path>] [--project P] [--tier fast|slow] [--path <vfs-path>]
  hivemind docs show <doc-id>
  hivemind docs list [--project P] [--status active|archived|all] [--limit N]
  hivemind docs archive <doc-id>
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

const KNOWN_FLAGS = new Set(["--file", "--project", "--tier", "--path", "--status", "--limit"]);

/** Drop flag tokens (and their values) so positional scan sees only doc-id / content. */
function stripKnownFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (KNOWN_FLAGS.has(a)) {
      i++;
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

  // Only write subcommands need DDL — read-only show/list fall back to
  // isMissingTableError so a fresh-install user doesn't pay a CREATE round-trip.
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
    const content = resolveContent(positional[1], args);
    const path = flagValue(args, "--path") ?? defaultVfsPath(project, docId);
    const tier = parseTier(args);
    try {
      const out = await setDoc(query, tableName, {
        doc_id: docId,
        path,
        content,
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

  console.error(`Unknown subcommand: ${sub}`);
  console.error(USAGE);
  process.exit(1);
}
