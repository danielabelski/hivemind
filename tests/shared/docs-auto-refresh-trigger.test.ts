import { describe, expect, it, vi } from "vitest";
import { maybeSpawnDocsRefresh } from "../../src/docs/auto-refresh-trigger.js";

const CTX = { orgId: "org-a", project: "proj-1" };

describe("maybeSpawnDocsRefresh (registry-gated — no env var)", () => {
  it("no-ops when the registry has no matching entry", () => {
    const spawn = vi.fn();
    const fired = maybeSpawnDocsRefresh("/repo", CTX, { cliEntry: "/cli.js", spawn, isAutoEnabledFn: () => false });
    expect(fired).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns refresh + wiki-refresh when the registry authorizes (org, project)", () => {
    const spawn = vi.fn();
    const seen: Array<[string, string]> = [];
    const fired = maybeSpawnDocsRefresh("/repo/here", CTX, {
      cliEntry: "/path/cli.js", spawn,
      isAutoEnabledFn: (o, p) => { seen.push([o, p]); return true; },
    });
    expect(fired).toBe(true);
    expect(seen).toEqual([["org-a", "proj-1"]]); // exact key, no ambient state
    expect(spawn).toHaveBeenCalledWith("/path/cli.js", ["docs", "refresh", "--cwd", "/repo/here"]);
    expect(spawn).toHaveBeenCalledWith("/path/cli.js", ["docs", "wiki-refresh", "--cwd", "/repo/here"]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("ORG-SCOPED: enabled on another org does not fire here", () => {
    const spawn = vi.fn();
    const registry = (o: string, p: string) => o === "org-b" && p === "proj-1"; // enabled on org-b only
    const fired = maybeSpawnDocsRefresh("/repo", CTX, { cliEntry: "/cli.js", spawn, isAutoEnabledFn: registry });
    expect(fired).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns false when there is no CLI entry to re-invoke", () => {
    const spawn = vi.fn();
    const fired = maybeSpawnDocsRefresh("/repo", CTX, { cliEntry: "", spawn, isAutoEnabledFn: () => true });
    expect(fired).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
