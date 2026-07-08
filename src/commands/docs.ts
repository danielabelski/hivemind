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
import { makeHostGenerate, makeHostGenerateDoc, makeHostBatchGenerateDoc, makeHostRunPrompt, makeHostPageRunPrompt } from "../docs/refresh-llm.js";
import { generateDocs, selectTargets, type GenScope } from "../docs/generate.js";
import { generateWikiPages, selectWikiGroups, wikiDocId, WIKI_DOC_PREFIX } from "../docs/wiki-generate.js";
import { pullDocs } from "../docs/pull.js";
import { setAuto, findEntry, listEntries } from "../docs/auto-registry.js";
import { defaultIo, runDocsOnboarding } from "../docs/onboarding.js";
import { isAutoEnabled } from "../docs/auto-registry.js";
import { readRefreshMeta } from "../docs/meta.js";
import { tryGitTopLevel } from "../graph/git-hook-install.js";
import { runWikiRefreshCycle, runLocalWikiRefresh } from "../docs/wiki-refresh.js";
import { loadSnapshotByCommit } from "../graph/diff.js";
import { repoDir } from "../graph/snapshot.js";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import type { GitRunner } from "../docs/candidates.js";
import { deriveProjectKey } from "../utils/repo-identity.js";
import { makeDocEmbedder } from "../docs/embed.js";
import { backfillDocEmbeddings } from "../docs/backfill.js";
import { loadCurrentSnapshot } from "../graph/load-current.js";
import { isMissingTableError } from "../deeplake-schema.js";

const USAGE = `
hivemind docs — documentation that stays in sync with the code

Everyday:
  hivemind docs list [--repos]
      Status header for this repo (root, org, auto ON/off, sync freshness,
      graph) + the pages. --repos lists every repo registered for auto sync.
  hivemind docs sync [--cwd <dir>] [--force] [--local]
      Bring the docs up to date with the code (wiki pages + per-file docs).
      Builds the code graph under the hood if missing. First interactive run
      on an empty corpus walks the same consent flow as graph init. --local
      previews patches on the working tree only (never writes the table).
  hivemind docs pull [--cwd <dir>] [--project P] [--scope S] [--force]
      Materialize the docs locally as gitignored *.hivemind.md files next to
      the code. Incremental (local cursor); --force re-pulls everything.
  hivemind docs auto on|off [--cwd <dir>]
      Turn automatic per-commit sync on/off for THIS repo on THIS org.
      Enabling with no corpus asks for explicit confirmation (LLM cost).
  hivemind docs show <doc-id>

Advanced / plumbing:
  hivemind docs wiki [--cwd] [--include] [--exclude] [--limit] [--concurrency] [--force] [--dry-run]
      Generate the narrative wiki pages (one per subsystem) explicitly.
  hivemind docs wiki-refresh [--cwd] [--force] [--local]
      One lease-guarded wiki refresh cycle (what sync/auto run for you).
  hivemind docs refresh [--cwd <dir>] [--dry-run]
      Per-file docs drift refresh (what sync runs for you).
  hivemind docs generate [--cwd] [--scope file|symbol] [--include] [--exclude]
                         [--limit] [--concurrency] [--batch] [--force] [--dry-run]
      Auto-author per-file docs from the AST graph. Batches 5 files/call.
  hivemind docs set <doc-id> ["<markdown>"] [--file <path>] [--project P] [--tier fast|slow] [--path <vfs-path>]
  hivemind docs index [<dir>]
  hivemind docs archive <doc-id>
  hivemind docs reindex
      Backfill semantic-search vectors for docs that lack them (no LLM).
`.trim();

/** Current HEAD sha of `cwd`, or null when not a git repo. */
function gitHeadOf(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

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

const KNOWN_FLAGS = new Set(["--file", "--project", "--tier", "--path", "--status", "--limit", "--cwd", "--dry-run", "--anchor", "--scope", "--include", "--exclude", "--concurrency", "--force", "--batch", "--local", "--repos"]);
/** Flags that take NO value — they must not consume the following token. */
const BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--local", "--repos"]);

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
      }, { project: flagValue(args, "--project") });
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
    // --repos: the global view — every repo registered for auto sync.
    if (args.includes("--repos")) {
      const entries = listEntries();
      if (entries.length === 0) {
        console.log("(no repos registered — enable one with `hivemind docs auto on` or via `hivemind graph init`)");
        return;
      }
      for (const e of entries) {
        console.log(`${e.auto ? "AUTO " : "  off"}  ${e.path}  (org: ${e.orgName ?? e.orgId}, project: ${e.project})`);
      }
      return;
    }

    // Status header for the CURRENT repo: root, org, auto, sync freshness.
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const headerProject = deriveProjectKey(cwd).key;
    const root = tryGitTopLevel(cwd) ?? cwd;
    const entry = findEntry(cfg.orgId, headerProject);
    const snapOk = loadCurrentSnapshot(cwd) !== null;
    let freshness = "never synced";
    try {
      const meta = await readRefreshMeta(query, tableName, headerProject, "main");
      if (meta?.meta.last_refresh_sha) {
        const head = gitHeadOf(cwd);
        if (head === null) freshness = "no git";
        else if (head === meta.meta.last_refresh_sha) freshness = "in sync (HEAD)";
        else freshness = `behind HEAD (last: ${meta.meta.last_refresh_sha.slice(0, 8)})`;
      }
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
    }
    console.log(`repo: ${root}  org: ${cfg.orgName ?? cfg.orgId}  auto: ${entry?.auto ? "ON" : "off"}  sync: ${freshness}  graph: ${snapOk ? "ok" : "missing"}`);
    console.log("─".repeat(60));

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
      }, { project: flagValue(args, "--project") });
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
    if (dryRun) {
      if (impacted.length === 0) {
        console.log("(no docs need refreshing — all anchors fresh)");
      } else {
        console.log(`${impacted.length} doc(s) would be refreshed:`);
        for (const i of impacted) {
          console.log(`  ${i.doc_id}  [${i.reasons.map((r) => r.kind).join(", ")}]`);
        }
      }
      return;
    }
    // Real run — ensure the table now (dry-run above already returned).
    await api.ensureDocsTable(tableName);
    if (impacted.length === 0) {
      console.log("(no docs need refreshing — all anchors fresh)");
    } else {
      const docsById = new Map(docs.map((d) => [d.doc_id, d]));
      const report = await refreshDocs({
        query,
        tableName,
        snap,
        repoRoot: cwd,
        impacted,
        docsById,
        generate: makeHostGenerate(),
        embed: makeDocEmbedder(),
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
    }

    // Self-complete the corpus: a commit that ADDS a documentable file leaves it
    // without a doc (refresh only updates existing ones). Generate docs for the
    // changed files that have none — scoped to the git diff, so still O(diff).
    // Modified files already have docs (refreshed above) and are skipped via
    // `existing`. Only runs when git gave us a diff.
    if (changed !== null && changed.length > 0) {
      const existing = new Set(docs.map((d) => d.doc_id));
      const genReport = await generateDocs({
        query,
        tableName,
        snap,
        repoRoot: cwd,
        project: deriveProjectKey(cwd).key,
        include: changed,
        existing,
        generate: makeHostGenerateDoc(),
        embed: makeDocEmbedder(),
        agent: cfg.userName,
        pluginVersion,
      });
      if (genReport.created > 0) {
        console.log(`Generated ${genReport.created} new doc(s) for added files:`);
        for (const o of genReport.outcomes) {
          if (o.status === "created") console.log(`  created ${o.doc_id}`);
        }
      }
    }
    return;
  }

  if (sub === "wiki-refresh") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const force = args.includes("--force");
    const local = args.includes("--local");
    const project = flagValue(args, "--project") ?? deriveProjectKey(cwd).key;
    const snap = loadCurrentSnapshot(cwd);
    if (!snap) {
      console.error("No local graph for this directory. Run `hivemind graph build` first.");
      process.exit(1);
      throw new Error("unreachable");
    }
    const git: GitRunner = (gitArgs) => {
      try {
        return execFileSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    };
    if (local) {
      // Working-tree preview: patches ONLY the local *.hivemind.md files,
      // never the table — no lease, no meta, no network write.
      const report = await runLocalWikiRefresh({ snap, repoRoot: cwd, run: makeHostRunPrompt(), git });
      if (report.outcomes.length === 0) {
        console.log("Local wiki preview: nothing touched by the working tree.");
      } else {
        console.log(`Local wiki preview: ${report.outcomes.length} page(s) considered.`);
        for (const o of report.outcomes) {
          console.log(`  ${o.action} ${o.file}${o.reasons ? ` (${o.reasons.join("; ")})` : ""}`);
        }
      }
      return;
    }
    await api.ensureDocsTable(tableName);
    if (!process.env.HIVEMIND_QUERY_TIMEOUT_MS) process.env.HIVEMIND_QUERY_TIMEOUT_MS = "30000";
    const report = await runWikiRefreshCycle({
      query, tableName, snap, repoRoot: cwd, project,
      run: makeHostRunPrompt(), runPage: makeHostPageRunPrompt(), git,
      owner: `${userInfo().username}@${hostname()}:${process.pid}`,
      force,
      // Snapshots live under the repo-derived key even when --project overrides
      // the table stamp.
      loadSnapshotAt: (sha) => loadSnapshotByCommit(repoDir(deriveProjectKey(cwd).key), sha),
      embed: makeDocEmbedder(),
      agent: cfg.userName, pluginVersion,
      log: (m) => console.error(`[wiki-refresh] ${m}`),
    });
    console.log(`Wiki refresh: ${report.status}${report.head ? ` @ ${report.head.slice(0, 8)}` : ""}.`);
    for (const o of report.outcomes) {
      console.log(`  ${o.action} ${o.doc_id}${o.reasons ? ` (${o.reasons.join("; ")})` : ""}`);
    }
    return;
  }

  if (sub === "sync") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const force = args.includes("--force");
    const local = args.includes("--local");
    const project = deriveProjectKey(cwd).key;
    const io = defaultIo();

    // Defense layer 2 (anti false-positive): a NON-interactive sync trusts
    // nobody — not even its own spawner. It re-checks the registry itself and
    // exits at zero LLM calls unless this exact (org, project) opted in.
    // An interactive sync IS the consent for this one run.
    if (!io.interactive && !isAutoEnabled(cfg.orgId, project)) {
      console.log("docs sync: auto not enabled for this repo on this org — nothing to do (enable with `hivemind docs auto on`).");
      return;
    }

    // Graph is plumbing: build it under the hood when missing.
    if (!loadCurrentSnapshot(cwd)) {
      console.log("Building code graph first (no LLM)...");
      // Lazy import: commands/graph.ts pulls tree-sitter (native). A static
      // import here would load it at CLI startup and crash every non-graph
      // command where the native module is absent (the PR #295 regression).
      const { runBuildCommand } = await import("./graph.js");
      await runBuildCommand(["--cwd", cwd, "--trigger", "manual"]);
    }

    // First interactive run on an empty corpus → the same onboarding as
    // graph init (consent to generation, optionally to auto).
    if (io.interactive) {
      let pages = 0;
      try {
        const rows = await listDocs(query, tableName, { project, status: "active", limit: 100000 });
        pages = rows.filter((r) => r.doc_id.startsWith(WIKI_DOC_PREFIX)).length;
      } catch (err) {
        if (!isMissingTableError((err as Error).message)) throw err;
      }
      if (pages === 0) {
        const result = await runDocsOnboarding({
          root: tryGitTopLevel(cwd) ?? cwd,
          isGitRepo: tryGitTopLevel(cwd) !== null,
          orgId: cfg.orgId,
          orgName: cfg.orgName,
          project,
          snap: loadCurrentSnapshot(cwd),
          io,
        });
        if (!result.generate) return; // no consent → no spend
      }
    }

    if (local) {
      await runDocsCommand(["wiki-refresh", "--cwd", cwd, "--local"]);
      return;
    }
    await runDocsCommand(["wiki-refresh", "--cwd", cwd, ...(force ? ["--force"] : [])]);
    await runDocsCommand(["refresh", "--cwd", cwd]);
    return;
  }

  if (sub === "auto") {
    const mode = args[1];
    if (mode !== "on" && mode !== "off") {
      console.error("Usage: hivemind docs auto on|off [--cwd <dir>]");
      process.exit(1);
      throw new Error("unreachable");
    }
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const project = deriveProjectKey(cwd).key;
    if (mode === "off") {
      setAuto({ orgId: cfg.orgId, orgName: cfg.orgName, project, path: cwd, auto: false });
      console.log(`Auto sync OFF for this repo on org ${cfg.orgName ?? cfg.orgId}.`);
      return;
    }
    // ON: explicit consent when the corpus does not exist yet — enabling auto
    // on an empty corpus means the first cycle generates EVERY page.
    const snap = loadCurrentSnapshot(cwd);
    let pages = 0;
    try {
      const rows = await listDocs(query, tableName, { project, status: "active", limit: 100000 });
      pages = rows.filter((r) => r.doc_id.startsWith(WIKI_DOC_PREFIX)).length;
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
    }
    if (pages === 0) {
      const est = snap ? `~${selectWikiGroups(snap).length} pages` : "the full corpus";
      const io = defaultIo();
      if (!io.interactive) {
        console.error(`No wiki corpus yet for this repo — enabling auto would generate ${est} on the first cycle. Run interactively (or generate first with \`hivemind docs wiki\`).`);
        process.exit(1);
        throw new Error("unreachable");
      }
      const a = await io.ask(`No wiki corpus yet: ${est} will be generated on the first cycle (LLM cost). Proceed? [y/N] `);
      if (!/^y(es)?$/i.test(a.trim())) {
        console.log("Left OFF. Generate first with: hivemind docs wiki");
        return;
      }
    }
    setAuto({ orgId: cfg.orgId, orgName: cfg.orgName, project, path: cwd, auto: true });
    console.log(`Auto sync ON for this repo on org ${cfg.orgName ?? cfg.orgId}. Docs stay fresh on every commit (consumes LLM tokens). Turn off with: hivemind docs auto off`);
    return;
  }

  if (sub === "pull") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const force = args.includes("--force");
    const scope = flagValue(args, "--scope") ?? "main";
    const project = flagValue(args, "--project") ?? deriveProjectKey(cwd).key;
    try {
      const report = await pullDocs({ query, tableName, repoRoot: cwd, project, scope, force });
      if (report.written.length === 0 && report.removed.length === 0) {
        console.log(`Docs up to date (${report.unchanged} unchanged).`);
      } else {
        console.log(`Pulled ${report.written.length} doc(s), removed ${report.removed.length} (${report.unchanged} unchanged).`);
        for (const p of report.written) console.log(`  wrote ${p}`);
        for (const p of report.removed) console.log(`  removed ${p}`);
      }
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
      console.log("(no docs table yet — nothing to pull)");
    }
    return;
  }

  if (sub === "wiki") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");
    const include = flagValues(args, "--include");
    const exclude = flagValues(args, "--exclude");
    const limitRaw = flagValue(args, "--limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    const concurrency = Number(flagValue(args, "--concurrency") ?? "2");
    // Wiki pages are canonical, shared rows — stamp the repo-derived project
    // key (same identity the graph pull/push uses) unless overridden.
    const project = flagValue(args, "--project") ?? deriveProjectKey(cwd).key;

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
    const existing = new Set(existingDocs.filter((d) => d.doc_id.startsWith(WIKI_DOC_PREFIX)).map((d) => d.doc_id));

    if (dryRun) {
      const groups = selectWikiGroups(snap, { include, exclude });
      const todo = force ? groups : groups.filter((g) => !existing.has(wikiDocId(g.key)));
      console.log(`${todo.length} wiki page(s) would be generated (${groups.length - todo.length} already exist).`);
      for (const g of todo.slice(0, limit ?? 60)) {
        console.log(`  wiki/${g.key}  (${g.files.length} files)`);
      }
      return;
    }

    await api.ensureDocsTable(tableName);
    if (!process.env.HIVEMIND_QUERY_TIMEOUT_MS) process.env.HIVEMIND_QUERY_TIMEOUT_MS = "30000";
    const report = await generateWikiPages({
      query, tableName, snap, repoRoot: cwd, project,
      include, exclude, existing, force, limit, concurrency,
      run: makeHostRunPrompt(),
      runPage: makeHostPageRunPrompt(),
      embed: makeDocEmbedder(),
      agent: cfg.userName, pluginVersion,
    });
    console.log(`Wiki: created ${report.created}, skipped ${report.skipped}, failed ${report.failed} (of ${report.groups} groups).`);
    for (const o of report.outcomes) {
      if (o.status === "created") console.log(`  created ${o.doc_id} (${o.files} files, ${o.chunks} chunk${o.chunks === 1 ? "" : "s"})`);
      else console.log(`  ${o.status} ${o.doc_id}: ${o.reason ?? ""}`);
    }
    return;
  }

  if (sub === "reindex") {
    // Backfill content_embedding for docs missing it (no LLM — embed daemon only).
    if (!process.env.HIVEMIND_QUERY_TIMEOUT_MS) process.env.HIVEMIND_QUERY_TIMEOUT_MS = "30000";
    try {
      await api.ensureDocsTable(tableName);
      const report = await backfillDocEmbeddings(query, tableName, makeDocEmbedder());
      console.log(`Reindexed: ${report.embedded} embedded (of ${report.scanned} active docs; ${report.skipped} already had a vector or skipped).`);
    } catch (err) {
      if (!isMissingTableError((err as Error).message)) throw err;
      console.log("(no docs table yet — nothing to reindex)");
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
    const concurrency = Number(flagValue(args, "--concurrency") ?? "4");
    // Same default as wiki/pull/wiki-refresh — a doc written under project ''
    // would be invisible to the project-scoped readers of the other commands.
    const project = flagValue(args, "--project") ?? deriveProjectKey(cwd).key;

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
      // Mirror the real run: generateDocs slices targets to --limit, so the
      // dry-run count must too or it overstates what will actually happen.
      const effective = limit !== undefined ? todo.slice(0, limit) : todo;
      console.log(`${effective.length} target(s) would be documented (scope=${scope}); ${allTargets.length - effective.length} already documented or skipped.`);
      for (const t of effective.slice(0, 60)) {
        console.log(`  ${t.doc_id}  (${t.symbols.length} symbols)`);
      }
      return;
    }

    await api.ensureDocsTable(tableName);
    // Bulk generate writes under load need a longer client timeout than the 10s
    // default, or writes abort mid-commit and drop files. Scope it to this
    // command (not global reads); the user can still override via env.
    if (!process.env.HIVEMIND_QUERY_TIMEOUT_MS) process.env.HIVEMIND_QUERY_TIMEOUT_MS = "30000";
    // Batch by default (5 files/call) — amortizes the per-call LLM boot ~2.5x.
    // `--batch 1` opts out; larger batches trade a little quality for speed.
    const batchSize = Number(flagValue(args, "--batch") ?? "5");
    const report = await generateDocs({
      query, tableName, snap, repoRoot: cwd, project, scope, include, exclude,
      existing, force, limit, concurrency,
      generate: makeHostGenerateDoc(),
      batchSize,
      batchGenerate: batchSize > 1 ? makeHostBatchGenerateDoc() : undefined,
      embed: makeDocEmbedder(),
      agent: cfg.userName, pluginVersion,
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
