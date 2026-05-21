/**
 * Spawn the detached graph-pull-worker.js — same pattern as
 * src/hooks/spawn-wiki-worker.ts. Called from every agent's SessionStart
 * (claude-code / codex / cursor / hermes) so the worker fires once per
 * session open, on all agents, asynchronously.
 *
 * Async/detached: the parent SessionStart hook calls this, then continues
 * its own work and emits its `additionalContext`. The worker keeps running
 * after the parent exits (detached + unref). Any pull side-effect lands
 * for the NEXT SessionStart to observe — see graph-pull-worker.ts for the
 * trade-off rationale.
 *
 * Best-effort: any spawn failure (missing bundle, missing node) is
 * swallowed silently. The pull is a convenience, not a guarantee — when
 * it works it works, when it doesn't the agent falls back to whatever's
 * already on disk.
 *
 * Tests inject a fake spawn via the `deps.spawn` parameter — see
 * tests/shared/graph/spawn-pull-worker.test.ts. The injectable seam keeps
 * the test boundary at the OS level (no real child process) while still
 * exercising the argv/options shape we'd send to the kernel.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";

export interface SpawnPullDeps {
  /** Override for tests; defaults to node:child_process spawn. */
  spawn?: typeof spawn;
}

/**
 * Spawn graph-pull-worker.js in the background. Returns nothing (truly
 * fire-and-forget); the worker logs its own outcome to a per-repo file.
 *
 * @param cwd        - working directory passed to the worker via --cwd
 * @param bundleDir  - absolute path containing graph-pull-worker.js
 *                     (computed by the parent hook via
 *                     dirname(fileURLToPath(import.meta.url)))
 */
export function spawnGraphPullWorker(cwd: string, bundleDir: string, deps: SpawnPullDeps = {}): void {
  // Hard gate: respect the same env var pullSnapshot itself respects.
  // Avoids spawning a process that would only do the skipped-disabled
  // dance — pure waste otherwise.
  if (process.env.HIVEMIND_GRAPH_PULL === "0") return;

  const workerPath = join(bundleDir, "graph-pull-worker.js");
  const opts: SpawnOptions = {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  };
  try {
    const sp = deps.spawn ?? spawn;
    // `nohup` makes the worker survive the parent's exit on Unix. On
    // Windows nohup doesn't exist, but Claude Code's primary platforms
    // are macOS + Linux — Windows users get an EBUSY/ENOENT here which
    // the try/catch swallows, and the build pipeline still uses local
    // snapshots correctly.
    sp("nohup", ["node", workerPath, "--cwd", cwd], opts).unref();
  } catch {
    // best-effort — pull is opt-in convenience, never break the hook
  }
}
