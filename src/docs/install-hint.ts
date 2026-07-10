/**
 * Docs onboarding shown once, in the `hivemind install` output — the visible
 * counterpart to the (model-only) SessionStart note.
 *
 * `hivemind install` runs on a TTY, so this is the honest place to TELL the
 * user the docs feature exists and, crucially, how to turn it ON and OFF.
 * Both directions in one block so the user is never stuck: enabling and
 * disabling are one command each, and status is discoverable.
 */

/** Lines describing docs enable/disable, for the install summary. */
export function docsInstallLines(): string[] {
  return [
    "Docs (optional): keep per-file and per-subsystem documentation in sync with your code on every commit.",
    "  Enable in a repo:  hivemind docs sync    (one-time consent; opt into per-commit auto-sync when asked)",
    "  Turn it off later: hivemind docs auto off",
    "  Check status:      hivemind docs list",
  ];
}
