/**
 * Step 8 trigger — kick a doc refresh after a graph build, opt-in.
 *
 * `hivemind graph build` runs from the post-commit hook; the instant it
 * finishes, the snapshot on disk is fresh, so this is the race-free place to
 * detect drift and regenerate docs. We do NOT touch the hook body itself
 * (shipped + tested) — we hang the trigger off the end of the build command.
 *
 * Gated behind `HIVEMIND_DOCS_AUTO_REFRESH=1` and OFF by default: auto-refresh
 * shells out to the host LLM on every commit, which costs tokens and time, so
 * users opt in explicitly (mirrors `HIVEMIND_AUTO_KPI_FROM_COMMITS`). The
 * refresh runs in a detached child so the build never blocks on it.
 */

import { spawnDetachedNodeWorker } from "../utils/spawn-detached.js";

export interface AutoRefreshDeps {
  env?: NodeJS.ProcessEnv;
  /** The CLI entry script to re-invoke (defaults to the running cli bundle). */
  cliEntry?: string;
  /** Injectable spawn for tests. */
  spawn?: (workerPath: string, args: readonly string[]) => void;
}

/**
 * Spawn `hivemind docs refresh --cwd <cwd>` (per-file docs) and
 * `hivemind docs wiki-refresh --cwd <cwd>` (subsystem pages) detached when
 * auto-refresh is enabled. The wiki cycle carries its own cheap guards
 * (sha-unchanged, 6h quiet period, lease claim), so firing it on every
 * commit is safe — most spawns exit in one read. Returns true if refreshes
 * were spawned, false if it was a no-op (flag off, or no CLI entry to
 * re-invoke). Best-effort and non-throwing.
 */
export function maybeSpawnDocsRefresh(cwd: string, deps: AutoRefreshDeps = {}): boolean {
  // Member access only (never bare `process.env`): esbuild `define` rewrites
  // `process.env.HIVEMIND_DOCS_AUTO_REFRESH` for the openclaw bundle so its
  // ClawHub static scan sees zero process.env reads.
  const flag = deps.env ? deps.env.HIVEMIND_DOCS_AUTO_REFRESH : process.env.HIVEMIND_DOCS_AUTO_REFRESH;
  if (flag !== "1") return false;
  const cliEntry = deps.cliEntry ?? process.argv[1];
  if (!cliEntry) return false;
  const spawn = deps.spawn ?? spawnDetachedNodeWorker;
  spawn(cliEntry, ["docs", "refresh", "--cwd", cwd]);
  spawn(cliEntry, ["docs", "wiki-refresh", "--cwd", cwd]);
  return true;
}
