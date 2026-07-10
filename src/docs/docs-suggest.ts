/**
 * SessionStart "docs not set up" suggestion — the one place the agent learns
 * that Hivemind CAN maintain docs for a repo that hasn't opted in yet.
 *
 * The wiki note (docs-context.ts) fires only for repos ALREADY opted into auto
 * sync. That leaves a gap: a user in a real, indexed repo with docs OFF never
 * hears the feature exists. This module fills exactly that gap, and only that
 * gap — it is the inverse gate of `isAutoEnabled`.
 *
 * Two hard constraints shape the wording and the firing:
 *   1. Anti prompt-injection. The note is descriptive capability disclosure,
 *      never an imperative to the agent. It ends with an explicit "no action
 *      needed unless the user asks" so the harness's injection heuristics read
 *      it as context, not a smuggled instruction. Match docs-context.ts tone.
 *   2. Show once per (org, project). A suggestion that reappears every session
 *      is nagware. Firing is deduped through `~/.deeplake/docs-suggested.json`
 *      (sibling of docs-auto.json), keyed on (orgId, projectKey) so nested
 *      checkouts / worktrees of the same repo share one entry.
 *
 * Every read is hook-safe: a missing or corrupt registry is an empty registry,
 * never a throw. `docsSuggestNote` is a PURE function (no writes) so the caller
 * decides — and best-effort guards — the `markSuggested` write.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SuggestedEntry {
  orgId: string;
  /** Repo project key (deriveProjectKey(cwd).key). */
  project: string;
  /** Display-only: where the suggestion last fired from. */
  path: string;
  suggestedAt: string;
}

export interface SuggestedRegistry {
  entries: SuggestedEntry[];
}

export function suggestedRegistryPath(): string {
  return process.env.HIVEMIND_DOCS_SUGGESTED_FILE ?? join(homedir(), ".deeplake", "docs-suggested.json");
}

/** Read the registry. Missing/corrupt file → empty (hooks must never crash). */
export function readSuggestedRegistry(file = suggestedRegistryPath()): SuggestedRegistry {
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<SuggestedRegistry>;
    if (!Array.isArray(raw.entries)) return { entries: [] };
    const entries = raw.entries.filter(
      (e): e is SuggestedEntry =>
        !!e && typeof e === "object" &&
        typeof (e as SuggestedEntry).orgId === "string" &&
        typeof (e as SuggestedEntry).project === "string",
    );
    return { entries };
  } catch {
    return { entries: [] };
  }
}

/** Has the docs suggestion already fired for (org, project)? Hook-safe, read-only. */
export function wasSuggested(orgId: string, project: string, file = suggestedRegistryPath()): boolean {
  return readSuggestedRegistry(file).entries.some(
    (e) => e.orgId === orgId && e.project === project,
  );
}

/**
 * Record that the suggestion fired for (org, project). Atomic (tmp + rename)
 * and idempotent — a repeat call updates `path`/`suggestedAt` in place rather
 * than appending a duplicate. Best-effort by contract: the caller wraps this
 * so a write failure never breaks SessionStart.
 */
export function markSuggested(
  orgId: string,
  project: string,
  path: string,
  suggestedAt: string,
  file = suggestedRegistryPath(),
): void {
  const reg = readSuggestedRegistry(file);
  const existing = reg.entries.find((e) => e.orgId === orgId && e.project === project);
  if (existing) {
    existing.path = path;
    existing.suggestedAt = suggestedAt;
  } else {
    reg.entries.push({ orgId, project, path, suggestedAt });
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 1) + "\n");
  renameSync(tmp, file);
}

const NOTE = `

DOCS (not set up for this repo): Hivemind can maintain per-file and per-subsystem documentation that stays in sync with the code on every commit, searchable under ~/.deeplake/memory/docs/. This repo hasn't opted in. If the user would find persistent, commit-fresh code docs useful, they can enable them by running \`hivemind docs sync\` (one-time consent, then auto-maintained on commits). Purely informational — no action needed unless the user asks about it.`;

/**
 * The suggestion note, or "" when it should not fire. Returns "" — never
 * throws — when docs are already enabled, when the suggestion already fired,
 * when this is not an indexed code repo (no local graph), or on any registry
 * read failure. PURE: does not write; the caller records via `markSuggested`.
 */
export function docsSuggestNote(args: {
  orgId: string;
  project: string;
  /** True when a local code graph exists for this repo — the "real repo" gate. */
  graphPresent: boolean;
  isAutoEnabledFn: (orgId: string, project: string) => boolean;
  wasSuggestedFn?: (orgId: string, project: string) => boolean;
}): string {
  const { orgId, project, graphPresent, isAutoEnabledFn } = args;
  const wasSuggestedFn = args.wasSuggestedFn ?? wasSuggested;
  try {
    if (!graphPresent) return "";
    if (isAutoEnabledFn(orgId, project)) return "";
    if (wasSuggestedFn(orgId, project)) return "";
    return NOTE;
  } catch {
    return "";
  }
}
