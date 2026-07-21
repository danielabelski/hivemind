import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock ONLY the process boundary (execFileSync) — the network/exec seam the
// repo's testing philosophy says to mock — so the default runNpm/runHeal
// wrappers can be exercised without spawning real npm or the heal compile.
// spawnSync (used by transitively-imported embeddings.ts) stays real.
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { treeSitterSpecs, isGraphDepsInstalled, ensureGraphDeps } from "../../src/cli/graph-deps.js";

/**
 * The code-graph auto-build hook resolves tree-sitter from the shared
 * embed-deps dir. `ensureGraphDeps` provisions it there; these tests cover its
 * two pure helpers — the version derivation (which must track package.json so
 * embed-deps never drifts from what the bundles were built against) and the
 * presence check. The full install flow is covered by the e2e in the PR.
 */
describe("graph-deps helpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "graph-deps-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  describe("treeSitterSpecs", () => {
    it("returns only tree-sitter* optionalDependencies as name@range, sorted, skipping non-parsers", () => {
      const pkg = join(dir, "package.json");
      writeFileSync(pkg, JSON.stringify({
        optionalDependencies: {
          // deliberately unsorted + mixed with a non-parser native dep
          "tree-sitter-typescript": "^0.23.2",
          "@huggingface/transformers": "^3.0.0",
          "tree-sitter": "^0.21.1",
          "tree-sitter-python": "0.23.4",
        },
      }));
      expect(treeSitterSpecs(pkg)).toEqual([
        "tree-sitter@^0.21.1",
        "tree-sitter-python@0.23.4",
        "tree-sitter-typescript@^0.23.2",
      ]);
      // The 600MB transformers dep must NOT be dragged into the graph install.
      expect(treeSitterSpecs(pkg).join(" ")).not.toContain("transformers");
    });

    it("returns [] when the file is missing or has no optionalDependencies", () => {
      expect(treeSitterSpecs(join(dir, "does-not-exist.json"))).toEqual([]);
      const empty = join(dir, "empty.json");
      writeFileSync(empty, JSON.stringify({ dependencies: { foo: "1.0.0" } }));
      expect(treeSitterSpecs(empty)).toEqual([]);
    });

    it("does not match a package merely containing 'tree-sitter' mid-name", () => {
      const pkg = join(dir, "package.json");
      writeFileSync(pkg, JSON.stringify({
        optionalDependencies: { "not-tree-sitter-thing": "1.0.0", "tree-sitter": "^0.21.1" },
      }));
      // Only the real prefix/exact match — `tree-sitter-` or `tree-sitter`.
      expect(treeSitterSpecs(pkg)).toEqual(["tree-sitter@^0.21.1"]);
    });
  });

  describe("isGraphDepsInstalled", () => {
    const specs = ["tree-sitter@^0.21.1", "tree-sitter-python@0.23.4"];

    it("is true only when EVERY requested parser dir is present (partial install → false)", () => {
      const nm = join(dir, "node_modules");
      mkdirSync(nm, { recursive: true });
      expect(isGraphDepsInstalled(nm, specs)).toBe(false);
      // Partial install: one of the two parsers present → still not "installed".
      mkdirSync(join(nm, "tree-sitter"), { recursive: true });
      expect(isGraphDepsInstalled(nm, specs)).toBe(false);
      mkdirSync(join(nm, "tree-sitter-python"), { recursive: true });
      expect(isGraphDepsInstalled(nm, specs)).toBe(true);
    });

    it("is false when the spec set is empty (nothing to require)", () => {
      const nm = join(dir, "node_modules");
      mkdirSync(nm, { recursive: true });
      expect(isGraphDepsInstalled(nm, [])).toBe(false);
    });
  });

  describe("ensureGraphDeps", () => {
    const SPECS = ["tree-sitter@^0.21.1", "tree-sitter-python@0.23.4"];
    let nm: string;
    // A fake npm boundary that "installs" by creating the parser dirs, so the
    // presence check flips to true afterward (mirrors a successful install).
    const fakeInstall = (specs: string[]) => {
      for (const s of specs) mkdirSync(join(nm, s.slice(0, s.lastIndexOf("@"))), { recursive: true });
    };

    beforeEach(() => { nm = join(dir, "node_modules"); });

    function baseDeps(over: Record<string, unknown> = {}) {
      return {
        sharedDir: dir,
        sharedNodeModules: nm,
        specs: SPECS,
        logFn: () => {},
        warnFn: () => {},
        ...over,
      };
    }

    it("empty specs → warns and skips (no npm, no heal)", () => {
      const runNpm = vi.fn();
      const runHeal = vi.fn();
      const warnFn = vi.fn();
      ensureGraphDeps(baseDeps({ specs: [], runNpm, runHeal, warnFn }));
      expect(runNpm).not.toHaveBeenCalled();
      expect(runHeal).not.toHaveBeenCalled();
      expect(warnFn).toHaveBeenCalledWith(expect.stringContaining("no tree-sitter optionalDependencies"));
    });

    it("fresh → creates package.json, installs, writes the marker, then heals", () => {
      const runNpm = vi.fn((s: string[]) => fakeInstall(s));
      const runHeal = vi.fn();
      ensureGraphDeps(baseDeps({ runNpm, runHeal }));
      expect(runNpm).toHaveBeenCalledTimes(1);
      expect(runNpm).toHaveBeenCalledWith(SPECS, dir);
      expect(existsSync(join(dir, "package.json"))).toBe(true);
      expect(readFileSync(join(dir, ".graph-deps"), "utf8")).toBe(SPECS.join("\n"));
      // Heal ALWAYS runs, even right after a fresh install.
      expect(runHeal).toHaveBeenCalledTimes(1);
    });

    it("already present + marker matches → skips the install but STILL heals", () => {
      fakeInstall(SPECS);
      writeFileSync(join(dir, ".graph-deps"), SPECS.join("\n"));
      const runNpm = vi.fn();
      const runHeal = vi.fn();
      ensureGraphDeps(baseDeps({ runNpm, runHeal }));
      expect(runNpm).not.toHaveBeenCalled();
      expect(runHeal).toHaveBeenCalledTimes(1);
    });

    it("stale marker (spec set changed) → reinstalls even if the dirs exist", () => {
      fakeInstall(SPECS);
      writeFileSync(join(dir, ".graph-deps"), "tree-sitter@0.0.1"); // old key
      const runNpm = vi.fn((s: string[]) => fakeInstall(s));
      ensureGraphDeps(baseDeps({ runNpm, runHeal: () => {} }));
      expect(runNpm).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(dir, ".graph-deps"), "utf8")).toBe(SPECS.join("\n"));
    });

    it("partial install (marker matches but a parser dir is missing) → reinstalls", () => {
      mkdirSync(join(nm, "tree-sitter"), { recursive: true }); // only one of two
      writeFileSync(join(dir, ".graph-deps"), SPECS.join("\n"));
      const runNpm = vi.fn();
      ensureGraphDeps(baseDeps({ runNpm, runHeal: () => {} }));
      expect(runNpm).toHaveBeenCalledTimes(1);
    });

    it("npm failure is swallowed (best-effort) — never throws, no marker written", () => {
      const runNpm = vi.fn(() => { throw new Error("npm exploded"); });
      const warnFn = vi.fn();
      expect(() => ensureGraphDeps(baseDeps({ runNpm, runHeal: () => {}, warnFn }))).not.toThrow();
      expect(existsSync(join(dir, ".graph-deps"))).toBe(false);
      expect(warnFn).toHaveBeenCalledWith(expect.stringContaining("tree-sitter provisioning failed"));
    });

    it("heal failure is swallowed too — never throws", () => {
      const runHeal = vi.fn(() => { throw new Error("heal exploded"); });
      const warnFn = vi.fn();
      expect(() => ensureGraphDeps(baseDeps({ runNpm: (s: string[]) => fakeInstall(s), runHeal, warnFn }))).not.toThrow();
      expect(warnFn).toHaveBeenCalledWith(expect.stringContaining("tree-sitter provisioning failed"));
    });

    it("default boundaries: runNpm/runHeal go through execFileSync (npm install + heal)", () => {
      vi.mocked(execFileSync).mockClear();
      // No runNpm/runHeal injected → the real default wrappers run, but
      // execFileSync is mocked so nothing spawns.
      ensureGraphDeps({ sharedDir: dir, sharedNodeModules: nm, specs: SPECS, logFn: () => {}, warnFn: () => {} });
      const calls = vi.mocked(execFileSync).mock.calls;
      // defaultRunNpm issued `npm install <specs> ...`.
      expect(calls.some((c) => c[0] === "npm" && Array.isArray(c[1]) && c[1][0] === "install")).toBe(true);
      // defaultRunHeal spawned the ensure-tree-sitter heal via node (the repo
      // ships scripts/ensure-tree-sitter.mjs, so the existsSync gate passes).
      expect(calls.some((c) => c[0] === process.execPath
        && Array.isArray(c[1]) && String(c[1][0]).endsWith("ensure-tree-sitter.mjs"))).toBe(true);
    });

    it("does not clobber an existing package.json", () => {
      // Exercises the `if (!existsSync(pkgPath))` false arm: a prior embeddings
      // install may already have written transformers there.
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, JSON.stringify({ dependencies: { "@huggingface/transformers": "^3.0.0" } }));
      fakeInstall(SPECS);
      writeFileSync(join(dir, ".graph-deps"), SPECS.join("\n"));
      ensureGraphDeps(baseDeps({ runNpm: vi.fn(), runHeal: () => {} }));
      expect(JSON.parse(readFileSync(pkgPath, "utf8")).dependencies["@huggingface/transformers"]).toBe("^3.0.0");
    });
  });
});
