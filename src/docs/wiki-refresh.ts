/**
 * Wiki refresh orchestrator — the "cron that lives in the code".
 *
 * No CI, no crontab: every dev machine is a potential refresher. The
 * post-commit trigger (and any future session hook) spawns this cycle
 * detached; the cycle itself decides whether anything should happen:
 *
 *   1. GUARDS (cheap, read-only): HEAD == last_refresh_sha → up-to-date;
 *      meta row touched less than `minPeriodMs` ago → too-soon.
 *   2. LEASE: `tryClaimTurn` (TTL 30 min, read-back verified). Losing the
 *      claim is normal — someone else is refreshing; just leave.
 *   3. WORK, O(diff): `git diff last_refresh_sha..HEAD --name-only` picks the
 *      candidate pages; each is patched in place (`updateWikiPage`), escalated
 *      to a full regen when patching is the wrong tool, or generated fresh
 *      when the subsystem is new.
 *   4. COMMIT POINT: `commitRefresh(HEAD)` — the ONLY place the sha advances,
 *      and only when every candidate succeeded. A crashed or partially failed
 *      cycle leaves the sha untouched; the next turn redoes the same window
 *      (every step is idempotent, so redoing converges). A worker that lost
 *      its lease mid-cycle is refused at the commit point.
 *
 * Everything effectful is injected (query, git, LLM run, regenerate), so the
 * whole protocol is unit-testable without a repo or a backend.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitRefresh, readRefreshMeta, tryClaimTurn } from "./meta.js";
import { gateDocEdit } from "./gate.js";
import { buildUpdatePrompt, updateWikiPage, DEFAULT_WIKI_MAX_CHANGED_LINES, NO_CHANGE } from "./wiki-update.js";
import {
  appendFilesIndex,
  generateWikiPages,
  parseFilesIndex,
  selectWikiGroups,
  stripFilesIndex,
  wikiDocId,
  WIKI_DOC_PREFIX,
  type RunPromptFn,
} from "./wiki-generate.js";
import { listDocs } from "./read.js";
import { diffSnapshots, type ModifiedNode } from "../graph/diff.js";
import type { GitRunner } from "./candidates.js";
import type { DocEmbedder } from "./embed.js";
import type { DocRow, QueryFn } from "./read.js";
import type { GraphSnapshot } from "../graph/types.js";
import type { WikiGroup } from "./wiki-groups.js";

/** Minimum quiet period between cycles (any meta activity counts). */
export const DEFAULT_MIN_PERIOD_MS = 6 * 60 * 60 * 1000;

export interface WikiRefreshArgs {
  query: QueryFn;
  tableName: string;
  snap: GraphSnapshot;
  repoRoot: string;
  project: string;
  scope?: string;
  run: RunPromptFn;
  /** Final-page authoring runner for regens (see WikiGenArgs.runPage). */
  runPage?: RunPromptFn;
  /** `git -C repoRoot <args>` runner (null on failure). */
  git: GitRunner;
  /** Claim owner id, e.g. `user@host:pid`. */
  owner: string;
  minPeriodMs?: number;
  /** Skip the quiet-period guard (manual `docs wiki-refresh --force`). */
  force?: boolean;
  now?: () => Date;
  /** Injectable settle delay for the claim read-back (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Full-page regeneration seam (defaults to generateWikiPages, force). */
  regenerate?: (group: WikiGroup) => Promise<"created" | "failed">;
  /**
   * Snapshot-at-sha loader (production: loadSnapshotByCommit on the repo's
   * graphs dir). When it can resolve the snapshot at `last_refresh_sha`, the
   * cycle counts per-group SIGNATURE changes and escalates pages whose public
   * contracts churned en masse. Absent/unresolvable → 0 (patching still safe:
   * mass rewrites are caught by the edit budget instead).
   */
  loadSnapshotAt?: (sha: string) => GraphSnapshot | null;
  embed?: DocEmbedder;
  agent?: string;
  pluginVersion?: string;
  log?: (msg: string) => void;
}

export interface WikiRefreshOutcome {
  doc_id: string;
  action: "patched" | "mechanics_refreshed" | "no_change" | "regenerated" | "generated" | "failed";
  reasons?: string[];
}

export interface WikiRefreshReport {
  status: "no-git" | "up-to-date" | "too-soon" | "not-claimed" | "committed" | "incomplete" | "lost-lease";
  head?: string;
  outcomes: WikiRefreshOutcome[];
}

function defaultRegenerate(args: WikiRefreshArgs): (group: WikiGroup) => Promise<"created" | "failed"> {
  return async (group) => {
    const report = await generateWikiPages({
      query: args.query,
      tableName: args.tableName,
      snap: args.snap,
      repoRoot: args.repoRoot,
      project: args.project,
      scope: args.scope,
      include: group.files,
      existing: new Set<string>(),
      force: true,
      run: args.run,
      runPage: args.runPage,
      embed: args.embed,
      agent: args.agent,
      pluginVersion: args.pluginVersion,
    });
    return report.created > 0 && report.failed === 0 ? "created" : "failed";
  };
}

export interface LocalWikiRefreshArgs {
  snap: GraphSnapshot;
  repoRoot: string;
  run: RunPromptFn;
  git: GitRunner;
  maxChangedLines?: number;
  log?: (msg: string) => void;
}

export interface LocalWikiRefreshOutcome {
  /** Repo-relative materialized file, e.g. `pkg/core.hivemind.md`. */
  file: string;
  action: "patched" | "no_change" | "not-materialized" | "escalate-skipped" | "failed";
  reasons?: string[];
}

/**
 * LOCAL preview refresh: same patch pipeline, but the diff is the WORKING
 * TREE (uncommitted edits) and the writes go ONLY to the local gitignored
 * `<key>.hivemind.md` files — never the table. No lease, no meta, no sha:
 * this is a per-developer preview of what the canonical refresh will say
 * once the work is committed and merged. Pages not materialized locally
 * (no `docs pull` yet) are reported and skipped, and an over-budget patch
 * is skipped rather than escalated — a full regen belongs to the canonical
 * cycle, not a preview.
 */
export async function runLocalWikiRefresh(args: LocalWikiRefreshArgs): Promise<{ outcomes: LocalWikiRefreshOutcome[] }> {
  const changedOut = args.git(["diff", "--name-only", "HEAD"]);
  const changed = new Set((changedOut ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  const untracked = args.git(["ls-files", "--others", "--exclude-standard"]);
  for (const l of (untracked ?? "").split("\n")) if (l.trim()) changed.add(l.trim());

  const outcomes: LocalWikiRefreshOutcome[] = [];
  if (changed.size === 0) return { outcomes };

  for (const group of selectWikiGroups(args.snap)) {
    const touched = group.files.filter((f) => changed.has(f));
    if (touched.length === 0) continue;
    const localFile = `${group.key}.wiki.hivemind.md`; // matches localDocPath's wiki namespace
    const abs = join(args.repoRoot, localFile);
    if (!existsSync(abs)) {
      outcomes.push({ file: localFile, action: "not-materialized", reasons: ["run `hivemind docs pull` first"] });
      continue;
    }
    const diff = args.git(["diff", "HEAD", "--", ...touched]) ?? "";
    if (diff.trim() === "") continue;

    const current = readFileSync(abs, "utf-8");
    let response: string;
    try {
      response = (await args.run(buildUpdatePrompt(group.key, stripFilesIndex(current), diff))).trim();
    } catch (err) {
      outcomes.push({ file: localFile, action: "failed", reasons: [(err as Error).message] });
      continue;
    }
    if (response === NO_CHANGE || response === "") {
      outcomes.push({ file: localFile, action: "no_change" });
      continue;
    }
    const next = appendFilesIndex(response, group.files);
    const gate = gateDocEdit({
      tier: "slow",
      allowSlow: true,
      prevContent: current,
      newContent: next,
      newAnchors: [],
      snap: args.snap,
      maxChangedLines: args.maxChangedLines ?? DEFAULT_WIKI_MAX_CHANGED_LINES,
    });
    if (!gate.ok) {
      outcomes.push({ file: localFile, action: "escalate-skipped", reasons: gate.reasons });
      continue;
    }
    writeFileSync(abs, next.endsWith("\n") ? next : next + "\n");
    outcomes.push({ file: localFile, action: "patched" });
  }
  return { outcomes };
}

/** One full refresh cycle. See module docstring for the protocol. */
export async function runWikiRefreshCycle(args: WikiRefreshArgs): Promise<WikiRefreshReport> {
  const log = args.log ?? (() => {});
  const nowFn = args.now ?? (() => new Date());
  const scope = args.scope ?? "main";

  const head = args.git(["rev-parse", "HEAD"])?.trim();
  if (!head) return { status: "no-git", outcomes: [] };

  // Cheap read-only guards before taking any lease.
  const metaBefore = await readRefreshMeta(args.query, args.tableName, args.project, scope);
  if (metaBefore?.meta.last_refresh_sha === head) {
    return { status: "up-to-date", head, outcomes: [] };
  }
  if (metaBefore && !args.force) {
    const sinceLastTouch = nowFn().getTime() - new Date(metaBefore.updated_at).getTime();
    const minPeriod = args.minPeriodMs ?? DEFAULT_MIN_PERIOD_MS;
    if (Number.isFinite(sinceLastTouch) && sinceLastTouch < minPeriod) {
      return { status: "too-soon", head, outcomes: [] };
    }
  }

  const claim = await tryClaimTurn(args.query, args.tableName, args.project, scope, {
    owner: args.owner,
    now: args.now,
    sleep: args.sleep,
  });
  if (!claim.won) return { status: "not-claimed", head, outcomes: [] };

  // Someone may have committed HEAD between the guard read and our claim
  // (the claim carries their fresh sha — see tryClaimTurn). Release and go.
  if (claim.meta.last_refresh_sha === head) {
    await commitRefresh(args.query, args.tableName, args.project, scope, head, claim.meta.patch_counts, {
      owner: args.owner,
      now: args.now,
    });
    return { status: "up-to-date", head, outcomes: [] };
  }

  const lastSha = claim.meta.last_refresh_sha;
  const patchCounts = { ...claim.meta.patch_counts };

  // The refresh window. No prior sha (first cycle) or an unreachable sha
  // (history rewritten) → null = "everything is a candidate", logged.
  let changed: Set<string> | null = null;
  if (lastSha !== "") {
    const out = args.git(["diff", "--name-only", `${lastSha}..HEAD`]);
    if (out !== null) {
      changed = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
    } else {
      log(`diff ${lastSha}..HEAD unavailable — full-candidate cycle`);
    }
  } else {
    log("first refresh cycle — full-candidate cycle");
  }

  // Signature churn per file (Phase 7): diff the graph at last_refresh_sha
  // against the current one. Best-effort — no snapshot, no signal.
  let modified: ModifiedNode[] = [];
  if (lastSha !== "" && args.loadSnapshotAt) {
    const prevSnap = args.loadSnapshotAt(lastSha);
    if (prevSnap) modified = diffSnapshots(prevSnap, args.snap).nodes.modified ?? [];
    else log(`no graph snapshot at ${lastSha} — signature-churn escalation disabled this cycle`);
  }
  const sigChangesByFile = new Map<string, number>();
  for (const m of modified) {
    sigChangesByFile.set(m.after.source_file, (sigChangesByFile.get(m.after.source_file) ?? 0) + 1);
  }

  const groups = selectWikiGroups(args.snap);
  const pages = new Map<string, DocRow>();
  for (const d of await listDocs(args.query, args.tableName, { project: args.project, status: "active", limit: 100000 })) {
    if (d.doc_id.startsWith(WIKI_DOC_PREFIX)) pages.set(d.doc_id, d);
  }

  const regenerate = args.regenerate ?? defaultRegenerate(args);
  const outcomes: WikiRefreshOutcome[] = [];
  let failures = 0;

  for (const group of groups) {
    const docId = wikiDocId(group.key);
    const page = pages.get(docId);

    // New subsystem → fresh page.
    if (!page) {
      const res = await regenerate(group);
      outcomes.push({ doc_id: docId, action: res === "created" ? "generated" : "failed" });
      if (res === "failed") failures++;
      else patchCounts[docId] = 0;
      continue;
    }

    const pageFiles = parseFilesIndex(page.content);
    const membershipChanged =
      pageFiles.length > 0 &&
      (pageFiles.length !== group.files.length || group.files.some((f) => !pageFiles.includes(f)));

    // Candidate filter: page is touched by the window (or the window is
    // unknown), or its membership drifted. Everything else is skipped free.
    const touched = changed === null || group.files.some((f) => changed.has(f));
    if (!touched && !membershipChanged) continue;

    const diff = lastSha === "" ? null : args.git(["diff", `${lastSha}..HEAD`, "--", ...group.files]);
    if (diff === null && !membershipChanged) {
      // No usable diff to patch from → regenerate rather than guess.
      const res = await regenerate(group);
      outcomes.push({ doc_id: docId, action: res === "created" ? "regenerated" : "failed", reasons: ["no usable diff"] });
      if (res === "failed") failures++;
      else patchCounts[docId] = 0;
      continue;
    }

    const out = await updateWikiPage({
      query: args.query,
      tableName: args.tableName,
      page,
      pageKey: group.key,
      files: group.files,
      snap: args.snap,
      repoRoot: args.repoRoot,
      diff: diff ?? "",
      run: args.run,
      escalation: {
        membershipChanged,
        signatureChanges: group.files.reduce((n, f) => n + (sigChangesByFile.get(f) ?? 0), 0),
        patchCount: patchCounts[docId] ?? 0,
      },
      embed: args.embed,
      agent: args.agent,
      pluginVersion: args.pluginVersion,
    });

    if (out.action === "escalate") {
      const res = await regenerate(group);
      outcomes.push({ doc_id: docId, action: res === "created" ? "regenerated" : "failed", reasons: out.reasons });
      if (res === "failed") failures++;
      else patchCounts[docId] = 0;
    } else if (out.action === "failed") {
      outcomes.push({ doc_id: docId, action: "failed", reasons: [out.reason] });
      failures++;
    } else if (out.action === "patched") {
      outcomes.push({ doc_id: docId, action: "patched" });
      patchCounts[docId] = (patchCounts[docId] ?? 0) + 1;
    } else {
      outcomes.push({ doc_id: docId, action: out.action });
    }
  }

  // Commit point: the sha advances ONLY on a fully clean cycle. Failures leave
  // it untouched so the next turn redoes the window (idempotent by design).
  if (failures > 0) {
    log(`${failures} page(s) failed — sha NOT advanced, next turn redoes the window`);
    return { status: "incomplete", head, outcomes };
  }
  const committed = await commitRefresh(args.query, args.tableName, args.project, scope, head, patchCounts, {
    owner: args.owner,
    now: args.now,
  });
  if (!committed.committed) return { status: "lost-lease", head, outcomes };
  return { status: "committed", head, outcomes };
}
