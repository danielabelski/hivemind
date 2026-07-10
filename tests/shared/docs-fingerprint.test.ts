import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  serializeFingerprint,
  parseFingerprint,
  changedFiles,
  isFresh,
} from "../../src/docs/fingerprint.js";
import type { GitRunner } from "../../src/docs/branch-scope.js";

const gitLsTree = (lines: string | null): GitRunner => (args) =>
  args[0] === "ls-tree" ? lines : null;

describe("computeFingerprint", () => {
  it("parses `<mode> blob <sha>\\t<path>` lines into a file->sha map", () => {
    const out =
      "100644 blob aaaa\tpkg/core/a.ts\n" +
      "100644 blob bbbb\tpkg/core/b.ts\n";
    expect(computeFingerprint(gitLsTree(out), ["pkg/core/a.ts", "pkg/core/b.ts"])).toEqual({
      "pkg/core/a.ts": "aaaa",
      "pkg/core/b.ts": "bbbb",
    });
  });

  it("omits files git can't resolve (deleted/untracked) — they read as changed", () => {
    const out = "100644 blob aaaa\tpkg/core/a.ts\n"; // b.ts absent
    expect(computeFingerprint(gitLsTree(out), ["pkg/core/a.ts", "pkg/core/b.ts"])).toEqual({
      "pkg/core/a.ts": "aaaa",
    });
  });

  it("ignores non-blob entries (trees/submodules)", () => {
    const out = "040000 tree cccc\tpkg/sub\n100644 blob aaaa\tpkg/a.ts\n";
    expect(computeFingerprint(gitLsTree(out), ["pkg/sub", "pkg/a.ts"])).toEqual({ "pkg/a.ts": "aaaa" });
  });

  it("empty file list makes no git call and returns {}", () => {
    let called = false;
    const git: GitRunner = () => { called = true; return "x"; };
    expect(computeFingerprint(git, [])).toEqual({});
    expect(called).toBe(false);
  });

  it("no git (null) → empty map (treated as unknown/stale downstream)", () => {
    expect(computeFingerprint(gitLsTree(null), ["a.ts"])).toEqual({});
  });

  it("preserves paths that contain spaces after the tab", () => {
    const out = "100644 blob aaaa\tpkg/with space.ts\n";
    expect(computeFingerprint(gitLsTree(out), ["pkg/with space.ts"])).toEqual({ "pkg/with space.ts": "aaaa" });
  });
});

describe("serialize/parse round-trip", () => {
  it("serializes with sorted keys and round-trips", () => {
    const fp = { "z.ts": "2", "a.ts": "1" };
    const s = serializeFingerprint(fp);
    expect(s).toBe(`{"a.ts":"1","z.ts":"2"}`); // sorted
    expect(parseFingerprint(s)).toEqual(fp);
  });
  it("parses an already-object cell and degrades garbage to {}", () => {
    expect(parseFingerprint({ "a.ts": "1", bad: 5 })).toEqual({ "a.ts": "1" });
    expect(parseFingerprint("not json")).toEqual({});
    expect(parseFingerprint("")).toEqual({});
    expect(parseFingerprint(null)).toEqual({});
    expect(parseFingerprint(["a"])).toEqual({});
  });
});

describe("changedFiles / isFresh", () => {
  it("detects a changed blob", () => {
    expect(changedFiles({ "a.ts": "1" }, { "a.ts": "2" })).toEqual(["a.ts"]);
    expect(isFresh({ "a.ts": "1" }, { "a.ts": "2" })).toBe(false);
  });
  it("detects added and removed files (membership drift)", () => {
    expect(changedFiles({ "a.ts": "1" }, { "a.ts": "1", "b.ts": "9" })).toEqual(["b.ts"]);
    expect(changedFiles({ "a.ts": "1", "b.ts": "9" }, { "a.ts": "1" })).toEqual(["b.ts"]);
  });
  it("identical fingerprints are fresh (edit-then-revert / rebase to same bytes)", () => {
    expect(isFresh({ "a.ts": "1", "b.ts": "2" }, { "b.ts": "2", "a.ts": "1" })).toBe(true);
    expect(changedFiles({ "a.ts": "1" }, { "a.ts": "1" })).toEqual([]);
  });
});
