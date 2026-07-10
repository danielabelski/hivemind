import { describe, expect, it } from "vitest";
import { docsInstallLines } from "../../src/docs/install-hint.js";

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
