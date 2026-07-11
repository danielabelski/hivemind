/**
 * Docs onboarding shown once, on the FIRST `hivemind install`.
 *
 * `hivemind install` runs on a TTY, so this is the honest place to TELL the
 * user the docs feature exists and, crucially, how to turn it ON and OFF.
 * Both directions in one block so the user is never stuck: enabling and
 * disabling are one command each, and status is discoverable.
 *
 * Shown once: a sentinel file (`~/.deeplake/.docs-hint-shown`) is written the
 * first time the block prints, so re-running install stays quiet. The sentinel
 * is best-effort — if the write fails the worst case is the hint shows again,
 * never a broken install.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Lines describing docs enable/disable, for the install summary. */
export function docsInstallLines(): string[] {
  return [
    "Docs (optional): keep per-file and per-subsystem documentation in sync with your code on every commit.",
    "  Enable in a repo:  hivemind docs sync    (one-time consent; opt into per-commit auto-sync when asked)",
    "  Turn it off later: hivemind docs auto off",
    "  Check status:      hivemind docs list",
  ];
}

/** Sentinel marking that the install docs hint has been shown once. */
export function docsHintSentinelPath(): string {
  return process.env.HIVEMIND_DOCS_HINT_FILE ?? join(homedir(), ".deeplake", ".docs-hint-shown");
}

/** Has the install docs hint already been shown on this machine? */
export function docsHintShown(file = docsHintSentinelPath()): boolean {
  return existsSync(file);
}

/** Record that the install docs hint was shown. Best-effort — never throws. */
export function markDocsHintShown(file = docsHintSentinelPath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, new Date().toISOString() + "\n");
  } catch {
    /* best-effort: worst case the hint shows again on the next install */
  }
}
