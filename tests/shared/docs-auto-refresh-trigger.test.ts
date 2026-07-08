import { describe, expect, it, vi } from "vitest";
import { maybeSpawnDocsRefresh } from "../../src/docs/auto-refresh-trigger.js";

describe("maybeSpawnDocsRefresh", () => {
  it("no-ops and returns false when the flag is unset", () => {
    const spawn = vi.fn();
    const fired = maybeSpawnDocsRefresh("/repo", { env: {}, cliEntry: "/cli.js", spawn });
    expect(fired).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("no-ops when the flag is set to anything other than '1'", () => {
    const spawn = vi.fn();
    expect(maybeSpawnDocsRefresh("/repo", { env: { HIVEMIND_DOCS_AUTO_REFRESH: "true" }, cliEntry: "/cli.js", spawn })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns `docs refresh` AND `docs wiki-refresh` detached when the flag is '1'", () => {
    const spawn = vi.fn();
    const fired = maybeSpawnDocsRefresh("/repo/here", { env: { HIVEMIND_DOCS_AUTO_REFRESH: "1" }, cliEntry: "/path/cli.js", spawn });
    expect(fired).toBe(true);
    expect(spawn).toHaveBeenCalledWith("/path/cli.js", ["docs", "refresh", "--cwd", "/repo/here"]);
    expect(spawn).toHaveBeenCalledWith("/path/cli.js", ["docs", "wiki-refresh", "--cwd", "/repo/here"]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("returns false when there is no CLI entry to re-invoke", () => {
    const spawn = vi.fn();
    const fired = maybeSpawnDocsRefresh("/repo", { env: { HIVEMIND_DOCS_AUTO_REFRESH: "1" }, cliEntry: "", spawn });
    expect(fired).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
