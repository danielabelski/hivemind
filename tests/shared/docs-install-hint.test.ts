import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  docsHintShown,
  docsInstallLines,
  markDocsHintShown,
} from "../../src/docs/install-hint.js";

describe("docsInstallLines (install-time docs onboarding)", () => {
  it("explains both enabling and disabling in one block", () => {
    const text = docsInstallLines().join("\n");
    // Enable path.
    expect(text).toContain("hivemind docs sync");
    // Disable path — the user must never be stuck after opting in.
    expect(text).toContain("hivemind docs auto off");
    // Status is discoverable.
    expect(text).toContain("hivemind docs list");
  });

  it("is a non-empty list of plain strings (safe to feed line-by-line to log)", () => {
    const lines = docsInstallLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
  });
});

describe("first-install sentinel (show the hint once)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-hint-"));
    file = join(dir, ".docs-hint-shown");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is not shown before the first install, shown after marking", () => {
    expect(docsHintShown(file)).toBe(false); // first install → show
    markDocsHintShown(file);
    expect(docsHintShown(file)).toBe(true); // subsequent installs → quiet
  });

  it("markDocsHintShown never throws when the path is unwritable (best-effort)", () => {
    // Point at a path whose parent is a FILE, not a directory: mkdirSync
    // fails fast with ENOTDIR and the best-effort catch must swallow it.
    // (Do NOT use a /proc/<missing> path — recursive mkdirSync walks up a
    // non-existent procfs chain and hangs, which once froze the whole suite.)
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    expect(() => markDocsHintShown(join(blocker, "child", ".docs-hint-shown"))).not.toThrow();
  });
});
